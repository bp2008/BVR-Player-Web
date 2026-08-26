import { performanceWall } from './MediaClock.js'
import { buildFlacDescription, makeSimpleDecoder, packetStartTimes } from './audioCodecs.js'

const LOOKAHEAD_MS = 700
const MAX_SCHEDULED = 24

/**
 * Decodes audio packets and schedules them on a WebAudio graph.
 *
 * Two things vary by container and nothing else does.
 *
 * *What the packets are.* A BVR file describes its audio with a WAVEFORMATEX and
 * leaves the reader to work out the rest; an MP4 states the decoder
 * configuration outright in its sample entry. So the container hands over an
 * `audioConfig` when it knows one -- `kind: 'codec'` for anything WebCodecs
 * decodes, `kind: 'raw'` for PCM and G.711, which are expanded here -- and the
 * BVR path leaves it null and is derived from the WAVEFORMATEX as before.
 *
 * *When they start.* Spec section 6 warns that a BVR packet's `timestamp` is not
 * a start time: FLAC packets are stamped near their *end*, and legacy files stamp
 * every packet 0. The stream is continuous from the first video frame, so the
 * starts are reconstructed from cumulative sample counts. An MP4 simply states
 * them, and hands them over in `index.audio.starts`.
 */
export class AudioPipeline {
  constructor ({ reader, index, header, clock, onError, onStatus }) {
    this.reader = reader
    this.index = index
    this.header = header
    this.wfx = header.wfx
    this.clock = clock
    this.onError = onError || (() => {})
    this.onStatus = onStatus || (() => {})

    this.available = false
    this.enabled = false
    this.ctx = null
    this.gain = null
    this.decoder = null
    this.simpleDecode = null
    this._decoderConfig = null

    // What the container said outright, where it said anything.
    this.audioConfig = header.audioConfig || null
    const stated = this.audioConfig && this.audioConfig.config
    this.sampleRate = (stated && stated.sampleRate) || this.wfx.nSamplesPerSec
    this.channels = Math.max(1, (stated && stated.numberOfChannels) || this.wfx.nChannels)
    this.startMs = 0
    this.packetStartMs = null

    this._cursor = 0
    this._scheduled = []
    this._waiters = []
    this._pumping = false
    this._epoch = 1
    this._needsResync = true
    this._clockAdopted = false
  }

  /** Builds the packet timing table. Returns false when the file has no audio. */
  prepare () {
    const a = this.index.audio
    if (!this.header.hasAudio || a.count === 0 || !this.sampleRate) return false

    if (a.starts && a.starts.length === a.count) {
      // The container knows exactly when each packet begins; nothing to rebuild.
      this.packetStartMs = a.starts
      this.startMs = a.starts[0]
    } else {
      // Legacy/odd files stamp every packet 0; the stream still starts where the
      // video does, so the origin is 0 rather than that meaningless stamp.
      const rawFirst = a.ts[0] + this.index.baseTs
      this.startMs = rawFirst === 0 && this.index.baseTs > 0 ? 0 : a.ts[0]

      const starts = packetStartTimes(this.wfx, a, this.header.audioExtradata)
      if (!starts) return false
      // packetStartTimes anchors on the stored first timestamp; re-anchor onto
      // the origin worked out above.
      const shift = this.startMs - a.ts[0]
      this.packetStartMs = shift === 0 ? starts : starts.map((t) => t + shift)
    }

    // A container that named a WebCodecs codec is decoded by WebCodecs, whatever
    // the WAVEFORMATEX beside it happens to say -- without this test an AAC track
    // whose header block is a placeholder would be expanded as if it were PCM,
    // which is full-scale noise rather than a silent failure.
    this.simpleDecode = this.audioConfig && this.audioConfig.kind === 'codec'
      ? null
      : makeSimpleDecoder(this.audioConfig ? this.audioConfig.wfx || this.wfx : this.wfx)
    this.available = true
    return true
  }

  /** Lazily creates the AudioContext; must be called from a user gesture. */
  async ensureContext () {
    if (!this.available) return null
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext
      if (!Ctor) { this.available = false; return null }
      // Confirm the decoder before adopting the context as the clock source --
      // a suspended context that never resumes would freeze playback.
      if (!(await this._ensureDecoder())) {
        this.available = false
        return null
      }
      this.ctx = new Ctor({ latencyHint: 'playback' })
      this.gain = this.ctx.createGain()
      this.gain.connect(this.ctx.destination)
      this.enabled = true
    }
    if (this.ctx.state === 'suspended') {
      // resume() stays pending indefinitely until the page gets user activation,
      // so it must never be the thing playback waits on.
      await Promise.race([
        this.ctx.resume().catch(() => {}),
        new Promise((r) => setTimeout(r, 1500))
      ])
    }
    this._syncClockSource()
    return this.ctx
  }

  /**
   * The media clock runs off AudioContext.currentTime so that audio scheduling
   * and video presentation cannot drift apart -- but only while the context is
   * actually running. A suspended context has a frozen currentTime, which would
   * otherwise stall video along with it.
   */
  _syncClockSource () {
    const running = !!this.ctx && this.ctx.state === 'running'
    if (running === this._clockAdopted) return
    this._clockAdopted = running
    this.clock.setWallSource(running ? () => this.ctx.currentTime : performanceWall)
  }

  async _ensureDecoder () {
    if (this.simpleDecode) return true
    if (typeof AudioDecoder === 'undefined') {
      this.onStatus('Audio disabled: this browser has no WebCodecs AudioDecoder.')
      return false
    }

    const stated = this.audioConfig && this.audioConfig.kind === 'codec'
      ? this.audioConfig.config
      : null
    const label = (this.audioConfig && this.audioConfig.label) || 'FLAC'

    if (stated) {
      this._decoderConfig = { ...stated }
    } else {
      // The BVR path: the only compressed audio Blue Iris writes is FLAC, and it
      // stores a bare STREAMINFO where WebCodecs wants a whole stream header.
      const description = buildFlacDescription(this.header.audioExtradata)
      if (!description) {
        this.onStatus('Audio disabled: the FLAC stream header is missing.')
        return false
      }
      this._decoderConfig = {
        codec: 'flac',
        sampleRate: this.sampleRate,
        numberOfChannels: this.channels,
        description
      }
    }

    try {
      const support = await AudioDecoder.isConfigSupported(this._decoderConfig)
      if (!support.supported) {
        this.onStatus(`Audio disabled: this browser cannot decode ${label}.`)
        return false
      }
    } catch {
      this.onStatus(`Audio disabled: this browser cannot decode ${label}.`)
      return false
    }
    this._openDecoder()
    return true
  }

  _openDecoder () {
    this.decoder = new AudioDecoder({
      output: (data) => this._onAudioData(data),
      error: () => {
        this.onStatus('Audio disabled: the audio decoder reported an error.')
        this.enabled = false
        this.available = false
      }
    })
    this.decoder.configure(this._decoderConfig)
  }

  _onAudioData (data) {
    // Decoders are free to rewrite output timestamps, so packets are paired with
    // their requests by order rather than by timestamp. Audio is never reordered.
    const waiter = this._waiters.shift()
    if (!waiter) { data.close(); return }
    const frames = data.numberOfFrames
    const chCount = Math.min(data.numberOfChannels, 2) || 1
    const planes = []
    for (let c = 0; c < chCount; c++) {
      const arr = new Float32Array(frames)
      try {
        data.copyTo(arr, { planeIndex: c, format: 'f32-planar' })
      } catch { /* leave silent on unexpected layouts */ }
      planes.push(arr)
    }
    data.close()
    waiter({ planes, frames })
  }

  setVolume (v) {
    if (this.gain) this.gain.gain.value = v
  }

  _packetIndexForTime (ms) {
    const starts = this.packetStartMs
    if (!starts || starts.length === 0) return 0
    let lo = 0
    let hi = starts.length - 1
    if (ms <= starts[0]) return 0
    if (ms >= starts[hi]) return hi
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= ms) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** Cancels every scheduled buffer; used on pause, seek and teardown. */
  stop () {
    this._epoch++
    for (const node of this._scheduled) {
      try { node.stop() } catch { /* already finished */ }
      try { node.disconnect() } catch { /* already detached */ }
    }
    this._scheduled.length = 0
    this._needsResync = true
    // Unblock anything waiting on a decode that reset() is about to cancel.
    const waiters = this._waiters.splice(0)
    for (const resolve of waiters) resolve(null)
    if (this.decoder && this.decoder.state === 'configured') {
      try {
        this.decoder.reset()
        this.decoder.configure(this._decoderConfig)
      } catch { /* re-created on next use */ }
    }
  }

  seek (mediaMs) {
    this.stop()
    this._cursor = this._packetIndexForTime(mediaMs)
    this._needsResync = false
  }

  /** Schedules packets so that roughly LOOKAHEAD_MS of audio is always queued. */
  pump () {
    if (!this.enabled || !this.ctx) return
    this._syncClockSource()
    if (this.ctx.state !== 'running') return
    if (!this.clock.playing || this.clock.held) return
    if (this.clock.rate !== 1) return
    // The context may have started late (autoplay policy); pick up from wherever
    // the video actually is rather than from a stale cursor.
    if (this._needsResync) this.seek(this.clock.currentTime)
    if (this._pumping) return
    this._pumping = true
    this._fill().catch((e) => this.onError(e)).finally(() => { this._pumping = false })
  }

  async _fill () {
    const a = this.index.audio
    const epoch = this._epoch
    const now = this.clock.currentTime
    while (this._cursor < a.count) {
      if (epoch !== this._epoch) return
      if (this._scheduled.length >= MAX_SCHEDULED) return
      const idx = this._cursor
      const startMs = this.packetStartMs[idx]
      if (startMs > now + LOOKAHEAD_MS) return

      const bytes = await this.reader.readCopy(a.offset[idx], a.size[idx])
      if (epoch !== this._epoch) return
      let pcm = null
      try {
        pcm = this.simpleDecode ? this.simpleDecode(bytes) : await this._decodeCompressed(bytes, startMs)
      } catch (e) {
        this.onError(e)
        this._cursor = idx + 1
        continue
      }
      if (epoch !== this._epoch) return
      this._cursor = idx + 1
      if (pcm && pcm.frames > 0) this._schedule(pcm, startMs)
    }
  }

  _decodeCompressed (bytes, startMs) {
    if (!this.decoder || this.decoder.state !== 'configured') return Promise.resolve(null)
    return new Promise((resolve) => {
      this._waiters.push(resolve)
      try {
        this.decoder.decode(new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round(startMs * 1000),
          data: bytes
        }))
      } catch {
        const at = this._waiters.indexOf(resolve)
        if (at >= 0) this._waiters.splice(at, 1)
        resolve(null)
      }
    })
  }

  _schedule (pcm, startMs) {
    const ctx = this.ctx
    const rate = this.sampleRate
    const chCount = pcm.planes.length
    const buffer = ctx.createBuffer(chCount, pcm.frames, rate)
    for (let c = 0; c < chCount; c++) buffer.copyToChannel(pcm.planes[c], c)

    let when = this.clock.wallForMedia(startMs)
    let offset = 0
    const nowCtx = ctx.currentTime
    if (when < nowCtx) {
      offset = nowCtx - when
      when = nowCtx
      if (offset >= buffer.duration - 0.005) return // wholly in the past
    }

    const node = ctx.createBufferSource()
    node.buffer = buffer
    node.connect(this.gain)
    node.onended = () => {
      const i = this._scheduled.indexOf(node)
      if (i >= 0) this._scheduled.splice(i, 1)
      try { node.disconnect() } catch { /* already detached */ }
    }
    try {
      node.start(when, offset)
      this._scheduled.push(node)
    } catch (e) {
      this.onError(e)
    }
  }

  close () {
    // Hand the clock back to wall time first: nothing may read a context that
    // is about to be closed.
    if (this._clockAdopted) this.clock.setWallSource(performanceWall)
    this._clockAdopted = false
    this.stop()
    if (this.decoder && this.decoder.state !== 'closed') {
      try { this.decoder.close() } catch { /* already torn down */ }
    }
    this.decoder = null
    this._waiters.splice(0).forEach((resolve) => resolve(null))
    if (this.ctx) {
      try { this.ctx.close() } catch { /* already closed */ }
    }
    this.ctx = null
    this.gain = null
    this.enabled = false
  }
}
