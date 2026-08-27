import { BlobReader } from '../bvr/blobReader.js'
import { buildFlacDescription, makeSimpleDecoder, packetStartTimes } from '../player/audioCodecs.js'
import { Mp4Muxer } from './mp4Muxer.js'
import {
  ParameterSets, annexBToLengthPrefixed, buildDecoderConfig, sampleEntryFor, isLengthPrefixed
} from './bitstream.js'
import {
  MODE_REMUX, TRANSCODE_CODECS, VIDEO_TIMESCALE, chooseEncoderConfig
} from './exportPlan.js'

/**
 * Runs an export planned by `planExport`.
 *
 * Two paths share one muxer. The remux path never decodes anything: it reads
 * each access unit, rewrites its start codes as lengths, and hands the same
 * slice bytes to the writer. The transcode path runs a decoder into an encoder
 * and is bounded by how fast the platform can do both.
 *
 * Interleaving
 * ------------
 * Audio is encoded first, in full, and held in memory; video is then streamed
 * with the audio spliced in around one-second boundaries. That ordering is what
 * keeps the memory cost flat for the part that is actually large: an hour of AAC
 * is tens of megabytes, while an hour of video is gigabytes and never has more
 * than one frame resident.
 */

// Roughly how much media each chunk of samples covers. Small enough that a
// player never has to seek far between the two tracks, large enough that the
// chunk tables stay short.
const INTERLEAVE_MS = 1000

// The read window used for payload fetches. Frames are stored in order, so a
// generous window turns the whole export into a handful of large sequential
// reads.
const READ_WINDOW = 8 << 20

// Ceiling on the encoded audio held in memory before audio is dropped instead.
const AUDIO_MEMORY_LIMIT = 256 << 20

const DECODE_QUEUE_LIMIT = 8
const ENCODE_QUEUE_LIMIT = 8

export class ExportCancelled extends Error {
  constructor () { super('Export cancelled.') }
}

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0))

export class ExportJob {
  constructor ({ blob, header, index, pstream, plan, sink, onProgress }) {
    this.blob = blob
    this.header = header
    this.index = index
    this.pstream = pstream
    this.plan = plan
    this.sink = sink
    this.onProgress = onProgress || (() => {})

    this.reader = new BlobReader(blob, READ_WINDOW)
    this.cancelled = false
    this.warnings = [...plan.warnings]
  }

  cancel () { this.cancelled = true }

  _check () {
    if (this.cancelled) throw new ExportCancelled()
  }

  _report (stage, done, total) {
    this.onProgress({ stage, progress: total > 0 ? Math.min(1, done / total) : 0, done, total })
  }

  async run () {
    const plan = this.plan
    try {
      const audio = plan.audio.include
        ? (plan.audio.copy ? await this._copyAudio() : await this._encodeAudio())
        : null
      this._check()

      const mux = new Mp4Muxer({ sink: this.sink })
      const videoTrack = mux.addVideoTrack({
        entry: plan.mode === MODE_REMUX
          ? sampleEntryFor(plan.fourcc)
          : (TRANSCODE_CODECS.find((c) => c.value === plan.options.videoCodec) || TRANSCODE_CODECS[0]).entry,
        width: plan.outWidth,
        height: plan.outHeight,
        // A remux cannot re-shape the pixels, so the shape goes in the container:
        // the track header presents the corrected size and `pasp` says why. A
        // transcode has already drawn the correction into the samples, so both
        // are simply the output size and no `pasp` is written.
        displayWidth: plan.trackWidth,
        displayHeight: plan.trackHeight,
        pasp: plan.pasp,
        timescale: VIDEO_TIMESCALE,
        config: null,
        name: plan.mode === MODE_REMUX ? 'stream copy' : 're-encode'
      })
      const audioTrack = audio
        ? mux.addAudioTrack({
          sampleRate: audio.sampleRate,
          channels: audio.channels,
          config: audio.description
        })
        : null

      await mux.start()
      this._check()

      const written = plan.mode === MODE_REMUX
        ? await this._runRemux(mux, videoTrack, audioTrack, audio)
        : await this._runTranscode(mux, videoTrack, audioTrack, audio)
      this._check()

      if (!videoTrack.config) throw new Error('The stream carried no parameter sets, so no MP4 header could be built.')
      const result = await mux.finalize()
      return { ...result, ...written, warnings: this.warnings }
    } finally {
      this.reader.release()
    }
  }

  // --------------------------------------------------------------- audio side

  /**
   * Decodes the source audio and re-encodes it as AAC.
   *
   * BVR carries PCM, G.711 mu-law or FLAC (spec 6). None of the three has a
   * form MP4 players can be relied on to handle, so all of them go through
   * `AudioEncoder`. Failing here is never fatal: the export continues without
   * an audio track and says so.
   */
  async _encodeAudio () {
    const plan = this.plan
    const a = this.index.audio
    const wfx = this.header.wfx
    const sampleRate = wfx.nSamplesPerSec
    const channels = Math.max(1, Math.min(2, wfx.nChannels))

    // Held out here so the `finally` can close whatever was built, whichever
    // step threw. A codec object that is dropped without `close()` stays live
    // for the life of the page, and the audio path is the one that gives up
    // quietly -- so without this a run of failed exports silently accumulates
    // encoders and decoders until nothing will configure any more.
    let decode = null
    let encoder = null
    try {
      decode = await this._audioDecoder()
      const chunks = []
      let description = null
      let bytes = 0
      let failed = null

      encoder = new AudioEncoder({
        output: (chunk, metadata) => {
          if (metadata && metadata.decoderConfig && metadata.decoderConfig.description && !description) {
            const d = metadata.decoderConfig.description
            description = new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))
          }
          const data = new Uint8Array(chunk.byteLength)
          chunk.copyTo(data)
          bytes += data.length
          chunks.push({ timestamp: chunk.timestamp, duration: chunk.duration || 0, data })
        },
        error: (e) => { failed = e }
      })
      const config = {
        codec: 'mp4a.40.2',
        sampleRate,
        numberOfChannels: channels,
        bitrate: plan.options.audioBitrate
      }
      const support = await AudioEncoder.isConfigSupported(config)
      if (!support || !support.supported) throw new Error('AAC encoding is not available here.')
      encoder.configure(config)

      const from = plan.audio.from
      const to = plan.audio.to
      const total = Math.max(1, to - from + 1)
      // The first packet in range sets the export's audio origin, so the track
      // starts at zero alongside the video rather than at its position in the
      // recording.
      const originMs = this._audioStartMs(from)

      for (let i = from; i <= to; i++) {
        this._check()
        if (failed) throw failed
        if (bytes > AUDIO_MEMORY_LIMIT) {
          this.warnings.push('The audio track grew past the memory budget for an export and was dropped.')
          return null
        }
        const raw = await this.reader.readCopy(a.offset[i], a.size[i])
        const pcm = await decode.decode(raw)
        if (!pcm || !pcm.frames) continue
        const startMs = this._audioStartMs(i) - originMs
        encoder.encode(this._audioData(pcm, sampleRate, channels, startMs))
        if (encoder.encodeQueueSize > ENCODE_QUEUE_LIMIT) await nextTurn()
        if ((i - from) % 32 === 0) this._report('audio', i - from, total)
      }
      await encoder.flush()
      if (failed) throw failed
      if (!chunks.length) return null

      return { chunks, description, sampleRate, channels, bytes }
    } catch (e) {
      // A cancellation is the user's answer about the whole export, not a
      // reason to carry on without sound.
      if (e instanceof ExportCancelled) throw e
      this.warnings.push(`Audio was left out: ${e && e.message ? e.message : e}`)
      return null
    } finally {
      if (encoder) { try { encoder.close() } catch { /* already torn down */ } }
      if (decode) { try { decode.close() } catch { /* already torn down */ } }
    }
  }

  /**
   * Copies the source's audio packets rather than re-encoding them.
   *
   * Only reachable from an MP4 source, and only when its audio is already AAC --
   * which is to say, when the source track and the output track are the same
   * format and the samples can simply be moved. It is both faster than a
   * re-encode and lossless, and it is the only audio path that works at all in a
   * browser with no `AudioEncoder`.
   *
   * The packets are read up front and held, exactly as the encoding path holds
   * its output, because the muxer interleaves them into the video stream as it
   * goes and cannot go back for them.
   */
  async _copyAudio () {
    const plan = this.plan
    const a = this.index.audio
    const stated = this.header.audioConfig
    try {
      const description = stated && stated.config ? stated.config.description : null
      if (!description) throw new Error('the source audio has no decoder configuration to carry over.')

      const sampleRate = stated.config.sampleRate
      const channels = Math.max(1, Math.min(2, stated.config.numberOfChannels || 1))
      const from = plan.audio.from
      const to = plan.audio.to
      const total = Math.max(1, to - from + 1)
      const originMs = this._audioStartMs(from)

      const chunks = []
      let bytes = 0
      for (let i = from; i <= to; i++) {
        this._check()
        if (bytes > AUDIO_MEMORY_LIMIT) {
          this.warnings.push('The audio track grew past the memory budget for an export and was dropped.')
          return null
        }
        const data = await this.reader.readCopy(a.offset[i], a.size[i])
        bytes += data.length
        const startMs = this._audioStartMs(i) - originMs
        const nextMs = i < to ? this._audioStartMs(i + 1) - originMs : startMs
        chunks.push({
          timestamp: Math.round(startMs * 1000),
          duration: i < to ? Math.round((nextMs - startMs) * 1000) : 0,
          data
        })
        if ((i - from) % 64 === 0) this._report('audio', i - from, total)
      }
      if (!chunks.length) return null
      this._report('audio', total, total)
      return { chunks, description, sampleRate, channels, bytes }
    } catch (e) {
      this.warnings.push(`Audio was left out: ${e && e.message ? e.message : e}`)
      return null
    }
  }

  /** Reconstructs a packet's start time the way playback does (spec 6). */
  _audioStartMs (i) {
    if (!this._audioStarts) {
      // An MP4 states its packet start times; a BVR file has to have them
      // reconstructed, because what it stores is not a start time (spec 6).
      this._audioStarts = this.index.audio.starts ||
        packetStartTimes(this.header.wfx, this.index.audio, this.header.audioExtradata) ||
        Float64Array.from(this.index.audio.ts)
    }
    return this._audioStarts[i] || 0
  }

  _audioData (pcm, sampleRate, channels, startMs) {
    const frames = pcm.frames
    const planes = new Float32Array(frames * channels)
    for (let c = 0; c < channels; c++) {
      const src = pcm.planes[Math.min(c, pcm.planes.length - 1)]
      planes.set(src.subarray(0, frames), c * frames)
    }
    return new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels: channels,
      timestamp: Math.round(startMs * 1000),
      data: planes
    })
  }

  /** A uniform "bytes in, planar floats out" front end for all three codecs. */
  async _audioDecoder () {
    const simple = makeSimpleDecoder(this.header.wfx)
    if (simple) {
      return { decode: async (bytes) => simple(bytes), close: () => {} }
    }
    if (typeof AudioDecoder === 'undefined') throw new Error('this browser cannot decode FLAC.')
    const description = buildFlacDescription(this.header.audioExtradata)
    if (!description) throw new Error('the FLAC stream header is missing.')
    const config = {
      codec: 'flac',
      sampleRate: this.header.wfx.nSamplesPerSec,
      numberOfChannels: Math.max(1, this.header.wfx.nChannels),
      description
    }
    const support = await AudioDecoder.isConfigSupported(config)
    if (!support || !support.supported) throw new Error('this browser cannot decode FLAC.')

    const waiters = []
    const decoder = new AudioDecoder({
      output: (data) => {
        const resolve = waiters.shift()
        if (!resolve) { data.close(); return }
        const frames = data.numberOfFrames
        const chCount = Math.min(data.numberOfChannels, 2) || 1
        const planes = []
        for (let c = 0; c < chCount; c++) {
          const arr = new Float32Array(frames)
          try { data.copyTo(arr, { planeIndex: c, format: 'f32-planar' }) } catch { /* silent */ }
          planes.push(arr)
        }
        data.close()
        resolve({ planes, frames })
      },
      error: () => {
        const resolve = waiters.shift()
        if (resolve) resolve(null)
      }
    })
    decoder.configure(config)

    let timestamp = 0
    return {
      decode: (bytes) => new Promise((resolve) => {
        waiters.push(resolve)
        try {
          decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: timestamp++, data: bytes }))
        } catch {
          const at = waiters.indexOf(resolve)
          if (at >= 0) waiters.splice(at, 1)
          resolve(null)
        }
      }),
      close: () => { try { decoder.close() } catch { /* already torn down */ } }
    }
  }

  // --------------------------------------------------------------- video side

  /**
   * Splices the audio encoded earlier into the video stream at a chunk boundary.
   *
   * Called each time the video crosses another interleave period, with the media
   * time reached; every audio packet that starts before it goes out here.
   */
  async _drainAudio (mux, audioTrack, audio, uptoMs) {
    if (!audioTrack || !audio) return
    const chunks = audio.chunks
    let wrote = false
    while (audio.cursor < chunks.length) {
      const c = chunks[audio.cursor]
      if (c.timestamp / 1000 > uptoMs) break
      if (!wrote) { mux.beginChunk(audioTrack); wrote = true }
      const nextChunk = chunks[audio.cursor + 1]
      // A trailing packet has no successor to measure against; AAC frames are a
      // fixed 1024 samples, which is the right answer for every one of them.
      const ticks = c.duration > 0
        ? (c.duration * audio.sampleRate) / 1e6
        : nextChunk
          ? ((nextChunk.timestamp - c.timestamp) * audio.sampleRate) / 1e6
          : 1024
      await mux.writeSample(audioTrack, c.data, { duration: ticks })
      audio.cursor++
    }
    if (wrote) mux.endChunk(audioTrack)
  }

  /** Copies compressed frames into the container with no re-encoding. */
  async _runRemux (mux, videoTrack, audioTrack, audio) {
    const plan = this.plan
    const s = this.pstream
    // An MP4 source is already storing exactly what an MP4 sample is, so its
    // frames are moved rather than converted and its parameter sets are taken
    // from the sample entry instead of being gathered out of the bitstream.
    const copyBytes = isLengthPrefixed(plan.fourcc)
    const isH264 = plan.fourcc === 'H264' || plan.fourcc === 'avc1' || plan.fourcc === 'avc3'
    const params = new ParameterSets(isH264)
    if (audio) audio.cursor = 0

    // The order the frames are written in, and the clock they are timed against.
    //
    // Normally these are the same thing: frames are shown in the order they
    // decode, so copying them in that order with the gaps between their
    // presentation times as durations is the whole job. A source with B-frames
    // has two orders and two clocks, and both have to survive the copy -- the
    // samples go out in *decode* order, timed by their decode timestamps, and
    // each one's presentation time rides along so the muxer can write the
    // composition offsets back out. Getting this wrong produces a file that
    // plays its frames jumbled, which is why it is not left to chance.
    const order = this._remuxOrder()
    const base = order.baseMs
    const total = order.steps.length
    let written = 0
    let dropped = 0
    let nextInterleave = INTERLEAVE_MS
    mux.beginChunk(videoTrack)

    for (let n = 0; n < order.steps.length; n++) {
      this._check()
      const i = order.steps[n]
      const relMs = order.timeOf(i) - base
      if (relMs >= nextInterleave) {
        mux.endChunk(videoTrack)
        await this._drainAudio(mux, audioTrack, audio, relMs)
        mux.beginChunk(videoTrack)
        while (relMs >= nextInterleave) nextInterleave += INTERLEAVE_MS
      }

      const view = await this.reader.read(s.offset[i], s.size[i])
      const payload = new Uint8Array(view.buffer, view.byteOffset, s.size[i])
      // The read window is reused by the next read, so a copy is needed either
      // way; the converter makes one, and the passthrough has to make its own.
      const sample = copyBytes
        ? payload.slice()
        : annexBToLengthPrefixed(payload, isH264, params)
      if (!sample) { dropped++; continue }

      const next = order.steps[n + 1]
      const nextMs = next !== undefined ? order.timeOf(next) - base : relMs + this._tailDuration()
      await mux.writeSample(videoTrack, sample, {
        duration: (nextMs - relMs) * (VIDEO_TIMESCALE / 1000),
        isKey: !!(s.flags[i] & 0x0001),
        // Only supplied where it differs from the decode time; the muxer writes
        // no `ctts` at all when every offset comes out zero.
        pts: order.reordered ? (s.ts[i] - base) * (VIDEO_TIMESCALE / 1000) : null
      })
      written++
      if ((written & 63) === 0) {
        this._report('video', n, total)
        // The read-ahead makes most iterations synchronous; without a real turn
        // of the event loop the progress bar would never paint.
        await nextTurn()
      }
    }
    mux.endChunk(videoTrack)
    await this._drainAudio(mux, audioTrack, audio, Infinity)

    videoTrack.config = copyBytes
      ? this._sourceDecoderConfig()
      : buildDecoderConfig(plan.fourcc, params)
    if (!copyBytes && params.conflict) {
      this.warnings.push(
        'The recording redefines a parameter set mid-stream. Only the first ' +
        'definition could be carried in the MP4 header; re-encode if the result ' +
        'looks wrong.'
      )
    }
    if (dropped) this.warnings.push(`${dropped} frame(s) held no decodable data and were skipped.`)
    this._report('video', total, total)
    return { frames: written, mode: MODE_REMUX }
  }

  /**
   * Which frames a stream copy writes, in which order, and against which clock.
   *
   * On an ordinary stream this is just the planned range walked forwards, timed
   * by presentation. On a reordered one it is the *decode*-order run that covers
   * that range: starting at the key frame the plan already snapped to, and
   * ending at the last decode step any frame in the range occupies. That run is
   * contiguous by construction -- a frame cannot decode before the key frame it
   * depends on -- and it may reach a little past the requested end, because a
   * frame shown inside the range can depend on one decoded after it. Copying a
   * frame too many is harmless; omitting one it referenced is not.
   */
  _remuxOrder () {
    const s = this.pstream
    const plan = this.plan
    const lo = plan.startIdx
    const hi = Math.min(plan.endIdx, s.count - 1)

    if (!s.feedOrder || !s.dts) {
      const steps = []
      for (let i = lo; i <= hi; i++) steps.push(i)
      return {
        steps,
        reordered: false,
        baseMs: s.ts[lo] || 0,
        timeOf: (i) => s.ts[i]
      }
    }

    let stepHi = s.feedPos[lo]
    for (let i = lo; i <= hi; i++) if (s.feedPos[i] > stepHi) stepHi = s.feedPos[i]
    const stepLo = s.feedPos[lo]

    const steps = []
    for (let step = stepLo; step <= stepHi; step++) steps.push(s.feedOrder[step])
    return {
      steps,
      reordered: true,
      baseMs: s.dts[s.feedOrder[stepLo]],
      timeOf: (i) => s.dts[i]
    }
  }

  /**
   * The `avcC`/`hvcC` an MP4 source already carries, for a copy that has no
   * bitstream to collect parameter sets from.
   */
  _sourceDecoderConfig () {
    const configs = this.plan.decoderConfigs
    const si = this.pstream.codecSource
    const config = configs && (configs[si] || configs.find(Boolean))
    const d = config && config.description
    if (!d) return null
    return d instanceof Uint8Array ? d : new Uint8Array(d)
  }

  _tailDuration () {
    const s = this.pstream
    if (s.count < 2) return 33
    const span = s.ts[s.count - 1] - s.ts[0]
    return span > 0 ? Math.max(1, span / (s.count - 1)) : 33
  }

  /** Decodes and re-encodes, which is what trimming exactly or rescaling needs. */
  async _runTranscode (mux, videoTrack, audioTrack, audio) {
    const plan = this.plan
    const s = this.pstream
    const codec = TRANSCODE_CODECS.find((c) => c.value === plan.options.videoCodec) || TRANSCODE_CODECS[0]
    if (audio) audio.cursor = 0

    const base = s.ts[plan.startIdx]
    const startUs = Math.round(s.ts[plan.startIdx] * 1000)
    const endUs = Math.round(s.ts[plan.endIdx] * 1000)

    // Frame-rate cap. Timing off a running target rather than off the gap since
    // the last kept frame, so rounding cannot accumulate. The tolerance matters:
    // BVR timestamps are whole milliseconds, so two frames of a nominal 30 fps
    // stream are 66 or 67 ms apart while a 15 fps period is 66.667 ms -- without
    // slack, half the frames miss by a fraction of a millisecond and a 15 fps
    // cap silently yields 10.
    const periodUs = plan.options.fps > 0 ? 1e6 / plan.options.fps : 0
    const TOLERANCE_US = 2000
    let nextEmitUs = -Infinity

    // A key frame every couple of seconds keeps the export seekable without
    // spending the whole bitrate on them.
    const KEY_INTERVAL_US = 2e6
    let lastKeyUs = -Infinity

    // Frames go through a canvas whenever they are not already the output size --
    // and always for a sequence built from both streams, whose pictures are two
    // different sizes. An encoder is configured once, for one size, so the
    // smaller stream's frames have to be drawn up to it rather than handed over
    // as they decoded.
    const scaling = plan.outWidth !== plan.width || plan.outHeight !== plan.height ||
      !!s.variableResolution
    const canvas = scaling ? new OffscreenCanvas(plan.outWidth, plan.outHeight) : null
    const ctx = canvas ? canvas.getContext('2d', { alpha: false }) : null

    let failure = null
    let written = 0
    let nextInterleave = INTERLEAVE_MS
    // Spacing of the last pair written, so the final sample -- which has no
    // successor to measure against -- gets the output's rate, not the input's.
    let lastGapMs = 0
    const pending = []

    const encoderConfig = await this._encoderConfig(codec)

    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        if (metadata && metadata.decoderConfig && metadata.decoderConfig.description && !videoTrack.config) {
          const d = metadata.decoderConfig.description
          videoTrack.config = new Uint8Array(
            d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))
        }
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        pending.push({ data, timestamp: chunk.timestamp, type: chunk.type, duration: chunk.duration })
      },
      error: (e) => { failure = e }
    })
    encoder.configure(encoderConfig)

    // One decoder per source stream. A merged `auto` sequence can carry H.265
    // main and H.264 sub, and even when the codecs agree the resolutions do not;
    // a decoder each is what lets the export follow the same sequence the player
    // was showing. Draining one before the next takes over keeps the encoder's
    // input in presentation order across a changeover.
    const decoders = new Map()
    const onDecoded = (frame) => {
      try {
        const ts = frame.timestamp
        // Frames before the requested start are the key-frame lead-in the
        // decoder needed and nothing more; this is what lets a re-encode trim
        // exactly where a stream copy cannot.
        if (ts < startUs || ts > endUs) return
        if (periodUs > 0) {
          if (ts + TOLERANCE_US < nextEmitUs) return
          // Advance along a fixed grid so a source whose frames land a
          // millisecond either side of the ideal spacing does not push the
          // target steadily later -- that turns a 15 fps cap into 13.5.
          // A real gap in the recording resets the grid instead.
          nextEmitUs = nextEmitUs === -Infinity ? ts + periodUs : nextEmitUs + periodUs
          if (nextEmitUs + periodUs < ts) nextEmitUs = ts + periodUs
        }
        const source = this._scaleFrame(frame, canvas, ctx, plan, ts)
        const wantKey = ts - lastKeyUs >= KEY_INTERVAL_US
        if (wantKey) lastKeyUs = ts
        encoder.encode(source, { keyFrame: wantKey })
        if (source !== frame) source.close()
      } catch (e) {
        failure = failure || e
      } finally {
        frame.close()
      }
    }

    const decoderFor = (si) => {
      let dec = decoders.get(si)
      if (dec) return dec
      dec = new VideoDecoder({
        output: onDecoded,
        error: (e) => { failure = failure || e }
      })
      dec.configure(this._decodeConfig(si))
      decoders.set(si, dec)
      return dec
    }
    const queued = () => {
      let n = 0
      for (const d of decoders.values()) if (d.state === 'configured') n += d.decodeQueueSize
      return n
    }

    mux.beginChunk(videoTrack)
    const total = plan.endIdx - plan.decodeFrom + 1

    /**
     * Writes out encoded chunks, holding the newest one back.
     *
     * A sample's duration is the distance to the one after it, and encoders do
     * not reliably populate `EncodedVideoChunk.duration` -- a frame handed in
     * without one comes back out without one. Measuring against the next chunk's
     * timestamp is what makes the output's length right whether frames were
     * dropped by the rate cap or not; the source frame interval, which is what a
     * missing duration would otherwise fall back to, describes the input rather
     * than the output.
     */
    const flushPending = async (uptoMs, final = false) => {
      while (pending.length > (final ? 0 : 1)) {
        const c = pending.shift()
        const next = pending[0]
        const relMs = c.timestamp / 1000 - base
        if (relMs >= nextInterleave) {
          mux.endChunk(videoTrack)
          await this._drainAudio(mux, audioTrack, audio, relMs)
          mux.beginChunk(videoTrack)
          while (relMs >= nextInterleave) nextInterleave += INTERLEAVE_MS
        }
        const nextRelMs = next
          ? next.timestamp / 1000 - base
          : relMs + (c.duration > 0 ? c.duration / 1000 : lastGapMs || this._tailDuration())
        if (next) lastGapMs = nextRelMs - relMs
        await mux.writeSample(videoTrack, c.data, {
          duration: (nextRelMs - relMs) * (VIDEO_TIMESCALE / 1000),
          isKey: c.type === 'key',
          pts: Math.round(relMs * (VIDEO_TIMESCALE / 1000))
        })
        written++
      }
      if (uptoMs !== undefined) this._report('video', uptoMs, total)
    }

    try {
      let current = -1
      for (let i = plan.decodeFrom; i <= plan.endIdx; i++) {
        this._check()
        if (failure) throw failure
        const si = s.srcStream ? s.srcStream[i] : s.codecSource
        if (si !== current) {
          // Drain the outgoing stream before the incoming one starts, or the
          // encoder would be handed the tail of one run after the head of the
          // next and the output would run backwards in time.
          if (current >= 0) await decoders.get(current).flush()
          if (failure) throw failure
          current = si
        }
        const view = await this.reader.read(s.offset[i], s.size[i])
        const bytes = new Uint8Array(view.buffer, view.byteOffset, s.size[i])
        decoderFor(si).decode(new EncodedVideoChunk({
          type: (s.flags[i] & 0x0001) ? 'key' : 'delta',
          timestamp: Math.round(s.ts[i] * 1000),
          data: bytes
        }))
        while (queued() > DECODE_QUEUE_LIMIT || encoder.encodeQueueSize > ENCODE_QUEUE_LIMIT) {
          this._check()
          if (failure) throw failure
          await nextTurn()
          await flushPending()
        }
        if ((i & 31) === 0) await flushPending(i - plan.decodeFrom)
      }
      for (const dec of decoders.values()) await dec.flush()
      await encoder.flush()
      if (failure) throw failure
      await flushPending(total, true)
    } finally {
      for (const dec of decoders.values()) {
        try { dec.close() } catch { /* already torn down */ }
      }
      try { encoder.close() } catch { /* already torn down */ }
    }

    mux.endChunk(videoTrack)
    await this._drainAudio(mux, audioTrack, audio, Infinity)
    this._report('video', total, total)
    return { frames: written, mode: 'transcode' }
  }

  /**
   * Settles on an encoder configuration the platform will actually accept.
   *
   * Nothing is constructed until one is found, so a rejected export leaves no
   * encoder behind -- a leaked one is a live codec instance for the life of the
   * page, and enough of them is what turns one failed export into every later
   * export failing until the tab is reloaded.
   */
  async _encoderConfig (codec) {
    const plan = this.plan
    const chosen = await chooseEncoderConfig({
      codec: codec.value,
      width: plan.outWidth,
      height: plan.outHeight,
      fps: plan.outFps,
      bitrate: plan.options.videoBitrate
    })
    if (!chosen || !chosen.config) {
      const tried = chosen && chosen.tried.length ? chosen.tried.join(', ') : 'no usable level'
      throw new Error(
        `This device cannot encode ${codec.label} at ${plan.outWidth}x${plan.outHeight} ` +
        `(tried ${tried}). Choose a smaller resolution and try again.`)
    }
    if (chosen.fallback) {
      this.warnings.push(
        `The encoder would not take ${chosen.tried[0]}, so ${chosen.codecString} was used instead.`)
    }
    return chosen.config
  }

  _scaleFrame (frame, canvas, ctx, plan, timestamp) {
    if (!canvas) return frame
    ctx.drawImage(frame, 0, 0, plan.outWidth, plan.outHeight)
    return new VideoFrame(canvas, { timestamp, alpha: 'discard' })
  }

  _decodeConfig (si) {
    // The same Annex-B configuration playback uses; the probe already settled
    // the codec string against a real key frame.
    const configs = this.plan.decoderConfigs
    const info = (configs && configs[si]) || this.plan.decoderConfig
    if (info) return info
    throw new Error('No decoder configuration was supplied for the transcode.')
  }
}
