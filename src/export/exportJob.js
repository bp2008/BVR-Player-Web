import { BlobReader } from '../bvr/blobReader.js'
import { buildFlacDescription, makeSimpleDecoder, packetStartTimes } from '../player/audioCodecs.js'
import { Mp4Muxer } from './mp4Muxer.js'
import {
  ParameterSets, annexBToLengthPrefixed, buildDecoderConfig, sampleEntryFor
} from './bitstream.js'
import { MODE_REMUX, TRANSCODE_CODECS, VIDEO_TIMESCALE } from './exportPlan.js'

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
      const audio = plan.audio.include ? await this._encodeAudio() : null
      this._check()

      const mux = new Mp4Muxer({ sink: this.sink })
      const videoTrack = mux.addVideoTrack({
        entry: plan.mode === MODE_REMUX
          ? sampleEntryFor(plan.fourcc)
          : (TRANSCODE_CODECS.find((c) => c.value === plan.options.videoCodec) || TRANSCODE_CODECS[0]).entry,
        width: plan.outWidth,
        height: plan.outHeight,
        timescale: VIDEO_TIMESCALE,
        config: null,
        name: plan.mode === MODE_REMUX ? 'BVR stream copy' : 'BVR re-encode'
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

    try {
      const decode = await this._audioDecoder()
      const chunks = []
      let description = null
      let bytes = 0
      let failed = null

      const encoder = new AudioEncoder({
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
          encoder.close()
          decode.close()
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
      encoder.close()
      decode.close()
      if (failed) throw failed
      if (!chunks.length) return null

      return { chunks, description, sampleRate, channels, bytes }
    } catch (e) {
      this.warnings.push(`Audio was left out: ${e && e.message ? e.message : e}`)
      return null
    }
  }

  /** Reconstructs a packet's start time the way playback does (spec 6). */
  _audioStartMs (i) {
    if (!this._audioStarts) {
      this._audioStarts = packetStartTimes(this.header.wfx, this.index.audio, this.header.audioExtradata) ||
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
    const isH264 = plan.fourcc === 'H264'
    const params = new ParameterSets(isH264)
    if (audio) audio.cursor = 0

    const base = s.ts[plan.startIdx]
    const total = plan.frames
    let written = 0
    let dropped = 0
    let nextInterleave = INTERLEAVE_MS
    mux.beginChunk(videoTrack)

    for (let i = plan.startIdx; i <= plan.endIdx; i++) {
      this._check()
      const relMs = s.ts[i] - base
      if (relMs >= nextInterleave) {
        mux.endChunk(videoTrack)
        await this._drainAudio(mux, audioTrack, audio, relMs)
        mux.beginChunk(videoTrack)
        while (relMs >= nextInterleave) nextInterleave += INTERLEAVE_MS
      }

      const view = await this.reader.read(s.offset[i], s.size[i])
      const payload = new Uint8Array(view.buffer, view.byteOffset, s.size[i])
      const sample = annexBToLengthPrefixed(payload, isH264, params)
      if (!sample) { dropped++; continue }

      const nextMs = i < plan.endIdx ? s.ts[i + 1] - base : relMs + this._tailDuration()
      await mux.writeSample(videoTrack, sample, {
        duration: (nextMs - relMs) * (VIDEO_TIMESCALE / 1000),
        isKey: !!(s.flags[i] & 0x0001)
      })
      written++
      if ((written & 63) === 0) {
        this._report('video', i - plan.startIdx, total)
        // The read-ahead makes most iterations synchronous; without a real turn
        // of the event loop the progress bar would never paint.
        await nextTurn()
      }
    }
    mux.endChunk(videoTrack)
    await this._drainAudio(mux, audioTrack, audio, Infinity)

    videoTrack.config = buildDecoderConfig(plan.fourcc, params)
    if (params.conflict) {
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

    const scaling = plan.outWidth !== plan.width || plan.outHeight !== plan.height
    const canvas = scaling ? new OffscreenCanvas(plan.outWidth, plan.outHeight) : null
    const ctx = canvas ? canvas.getContext('2d', { alpha: false }) : null

    let failure = null
    let written = 0
    let nextInterleave = INTERLEAVE_MS
    // Spacing of the last pair written, so the final sample -- which has no
    // successor to measure against -- gets the output's rate, not the input's.
    let lastGapMs = 0
    const pending = []

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

    const encoderConfig = {
      codec: codec.codec,
      width: plan.outWidth,
      height: plan.outHeight,
      bitrate: plan.options.videoBitrate,
      framerate: plan.options.fps > 0 ? plan.options.fps : undefined,
      // Encoders may emit B-frames when left to optimise for quality, which
      // would put the samples out of presentation order. The muxer can express
      // that, but a surveillance clip has nothing to gain from it.
      latencyMode: 'realtime'
    }
    encoderConfig[codec.value === 'hevc' ? 'hevc' : 'avc'] = { format: codec.value === 'hevc' ? 'hevc' : 'avc' }
    const support = await VideoEncoder.isConfigSupported(encoderConfig)
    if (!support || !support.supported) {
      throw new Error(`This device cannot encode ${codec.label} at ${plan.outWidth}x${plan.outHeight}.`)
    }
    encoder.configure(encoderConfig)

    const decoder = new VideoDecoder({
      output: (frame) => {
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
      },
      error: (e) => { failure = failure || e }
    })
    decoder.configure(this._decodeConfig())

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
      for (let i = plan.decodeFrom; i <= plan.endIdx; i++) {
        this._check()
        if (failure) throw failure
        const view = await this.reader.read(s.offset[i], s.size[i])
        const bytes = new Uint8Array(view.buffer, view.byteOffset, s.size[i])
        decoder.decode(new EncodedVideoChunk({
          type: (s.flags[i] & 0x0001) ? 'key' : 'delta',
          timestamp: Math.round(s.ts[i] * 1000),
          data: bytes
        }))
        while (decoder.decodeQueueSize > DECODE_QUEUE_LIMIT || encoder.encodeQueueSize > ENCODE_QUEUE_LIMIT) {
          this._check()
          if (failure) throw failure
          await nextTurn()
          await flushPending()
        }
        if ((i & 31) === 0) await flushPending(i - plan.decodeFrom)
      }
      await decoder.flush()
      await encoder.flush()
      if (failure) throw failure
      await flushPending(total, true)
    } finally {
      try { decoder.close() } catch { /* already torn down */ }
      try { encoder.close() } catch { /* already torn down */ }
    }

    mux.endChunk(videoTrack)
    await this._drainAudio(mux, audioTrack, audio, Infinity)
    this._report('video', total, total)
    return { frames: written, mode: 'transcode' }
  }

  _scaleFrame (frame, canvas, ctx, plan, timestamp) {
    if (!canvas) return frame
    ctx.drawImage(frame, 0, 0, plan.outWidth, plan.outHeight)
    return new VideoFrame(canvas, { timestamp, alpha: 'discard' })
  }

  _decodeConfig () {
    // The same Annex-B configuration playback uses; the probe already settled
    // the codec string against a real key frame.
    const info = this.plan.decoderConfig
    if (info) return info
    throw new Error('No decoder configuration was supplied for the transcode.')
  }
}
