import { BlobReader } from '../bvr/blobReader.js'
import { parseFileHeader } from '../bvr/parseFileHeader.js'
import { buildIndex, frameIndexForTime } from '../bvr/indexer.js'
import { describeVideoCodec } from '../bvr/codec.js'
import { buildPlaybackStream, estimateFrameInterval } from './playbackStream.js'
import { VideoPipeline } from './VideoPipeline.js'
import { AudioPipeline } from './AudioPipeline.js'
import { MediaClock, performanceWall } from './MediaClock.js'
import { Renderer } from './Renderer.js'
import { audioCodecLabel } from './audioCodecs.js'

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/**
 * Orchestrates parsing, decoding, presentation and transport controls.
 *
 * It is deliberately framework-free: the Vue layer subscribes to `onState` and
 * calls the transport methods, so nothing here depends on reactivity.
 */
export class BvrPlayer {
  constructor ({ canvas, onState, onError, onNotice }) {
    this.renderer = new Renderer(canvas)
    this.clock = new MediaClock()
    this.onState = onState || (() => {})
    this.onError = onError || (() => {})
    this.onNotice = onNotice || (() => {})

    this.reader = null
    this.header = null
    this.index = null
    this.pstream = null
    this.video = null
    this.audio = null
    this.codecInfo = null

    this.streamMode = 'auto'
    this.frameIntervalMs = 33.367

    this.curIdx = -1
    this.pendingSeek = null
    this.scrubbing = false
    this.ended = false
    this.volume = 1
    this.muted = false

    this._raf = 0
    this._generation = 0
    this._destroyed = false
    this._state = this._blankState()
    this._loop = this._loop.bind(this)
  }

  _blankState () {
    return {
      status: 'idle',
      loadProgress: 0,
      fileName: '',
      fileSize: 0,
      playing: false,
      buffering: false,
      ended: false,
      currentTime: 0,
      duration: 0,
      frameIndex: 0,
      frameCount: 0,
      volume: 1,
      muted: false,
      hasAudio: false,
      audioLabel: '',
      videoLabel: '',
      width: 0,
      height: 0,
      fps: 0,
      streamMode: 'auto',
      streamLabel: '',
      hasSubStream: false,
      hasMainStream: false,
      switchingMode: false,
      startUtc: 0,
      currentUtc: 0,
      truncated: false,
      error: ''
    }
  }

  _emit (patch) {
    this._state = { ...this._state, ...patch }
    this.onState(this._state)
  }

  get state () { return this._state }

  // ---------------------------------------------------------------- lifecycle

  async open (file) {
    this.closeFile()
    const gen = ++this._generation
    this._emit({ ...this._blankState(), status: 'loading', fileName: file.name, fileSize: file.size })

    try {
      this.reader = new BlobReader(file)
      this.header = await parseFileHeader(this.reader)
      if (gen !== this._generation) return

      this.index = await buildIndex(this.reader, this.header, {
        onProgress: (p) => { if (gen === this._generation) this._emit({ loadProgress: p }) },
        shouldStop: () => gen !== this._generation
      })
      if (gen !== this._generation) return

      if (this.index.streams[0].count === 0 && this.index.streams[1].count === 0) {
        throw new Error('This file contains no video frames.')
      }

      this.renderer.setOrientation(this.header.rotation, this.header.flipH)

      await this._selectStream(this.streamMode, true)
      if (gen !== this._generation) return

      this._setupAudio()
      this._emit({
        status: 'ready',
        loadProgress: 1,
        startUtc: this.index.startUtc,
        truncated: this.index.truncated,
        hasMainStream: this.index.streams[0].count > 0,
        hasSubStream: this.index.streams[1].count > 0,
        switchingMode: this.index.switchingMode
      })

      this._start()
      await this._gotoIndex(0)
    } catch (e) {
      if (gen !== this._generation) return
      this.closeFile()
      const message = e && e.message ? e.message : String(e)
      this._emit({ status: 'error', error: message })
      this.onError(e)
    }
  }

  async _selectStream (mode, initial) {
    const wasPlaying = this._state.playing
    const atTime = initial ? 0 : this.clock.currentTime
    this.streamMode = mode

    const pstream = buildPlaybackStream(this.index, this.header, mode)
    if (pstream.count === 0) throw new Error('The selected stream contains no frames.')

    // Take the codec description from the first key frame of the chosen stream.
    const firstKey = pstream.keys.length ? pstream.keys[0] : 0
    const keyBytes = await this.reader.readCopy(pstream.offset[firstKey], Math.min(pstream.size[firstKey], 1 << 16))
    const codecInfo = describeVideoCodec(pstream.fourcc, keyBytes, {
      width: pstream.width,
      height: pstream.height
    })
    if (codecInfo.kind === 'unsupported') {
      throw new Error(`Unsupported video codec: ${codecInfo.label}. Browsers cannot decode this stream.`)
    }

    if (this.video) this.video.close()
    this.video = new VideoPipeline({
      reader: this.reader,
      onError: (e) => this._onPipelineError(e)
    })
    await this.video.open(pstream, codecInfo)

    this.pstream = pstream
    this.codecInfo = codecInfo
    this.frameIntervalMs = estimateFrameInterval(pstream, this.header.frameInterval)
    this.curIdx = -1
    this.renderer.forget()

    const duration = pstream.ts[pstream.count - 1] + this.frameIntervalMs
    this._emit({
      duration,
      frameCount: pstream.count,
      width: pstream.width,
      height: pstream.height,
      videoLabel: codecInfo.label,
      fps: this.header.fps,
      streamMode: mode,
      streamLabel: pstream.streamLabel
    })

    if (!initial) {
      await this._gotoIndex(frameIndexForTime(pstream, atTime))
      if (wasPlaying) this.play()
    }
  }

  _setupAudio () {
    if (this.audio) { this.audio.close(); this.audio = null }
    const pipeline = new AudioPipeline({
      reader: this.reader,
      index: this.index,
      header: this.header,
      clock: this.clock,
      onError: (e) => console.warn('audio', e),
      onStatus: (msg) => this.onNotice(msg)
    })
    if (!pipeline.prepare()) {
      this._emit({ hasAudio: false, audioLabel: '' })
      return
    }
    this.audio = pipeline
    this._emit({ hasAudio: true, audioLabel: audioCodecLabel(this.header.wfx) })
  }

  _onPipelineError (e) {
    const message = e && e.message ? e.message : String(e)
    this._emit({ status: 'error', error: `Video decoding failed: ${message}` })
    this.pause()
  }

  closeFile () {
    this._generation++
    this._stop()
    if (this.video) { this.video.close(); this.video = null }
    if (this.audio) { this.audio.close(); this.audio = null }
    if (this.reader) { this.reader.release(); this.reader = null }
    this.header = null
    this.index = null
    this.pstream = null
    this.curIdx = -1
    this.pendingSeek = null
    this.clock.setWallSource(performanceWall)
    this.clock.pause()
    this.clock.currentTime = 0
    this.renderer.forget()
    this.renderer.clear()
  }

  destroy () {
    this._destroyed = true
    this.closeFile()
  }

  // ---------------------------------------------------------------- transport

  async play () {
    if (!this.pstream || this._state.status !== 'ready') return
    if (this.ended || this.clock.currentTime >= this._state.duration - 1) {
      await this._gotoIndex(0)
    }
    this.ended = false
    this.clock.play()
    this._emit({ playing: true, ended: false })
    // Audio starts alongside, never in front of, video.
    this._startAudio()
  }

  _startAudio () {
    if (!this.audio || this._audioStarting) return
    this._audioStarting = true
    const gen = this._generation
    Promise.resolve()
      .then(() => this.audio.ensureContext())
      .then((ctx) => {
        if (gen !== this._generation || !this.audio) return
        if (!this.audio.available) {
          this.audio.close()
          this.audio = null
          this._emit({ hasAudio: false })
          return
        }
        this.audio.setVolume(this.muted ? 0 : this.volume)
        // A context still suspended here will be picked up by pump() as soon as
        // the browser lets it start.
        if (ctx && ctx.state === 'running') this.audio.seek(this.clock.currentTime)
      })
      .catch(() => {})
      .finally(() => { this._audioStarting = false })
  }

  pause () {
    if (!this.clock.playing) return
    this.clock.pause()
    this.clock.setHeld(false)
    if (this.audio) this.audio.stop()
    this._emit({ playing: false, buffering: false })
  }

  togglePlay () {
    if (this._state.playing) this.pause()
    else this.play()
  }

  /**
   * Seeks to a media time. `preview` decodes only the enclosing key frame, which
   * is what keeps scrub-bar dragging responsive on long GOPs.
   */
  seek (ms, { preview = false } = {}) {
    if (!this.pstream) return
    const s = this.pstream
    const t = clamp(ms, 0, Math.max(0, s.ts[s.count - 1]))
    const exactIdx = frameIndexForTime(s, t)
    const idx = preview ? Math.max(0, s.keyIdx[exactIdx]) : exactIdx
    this.clock.currentTime = t
    this.ended = false
    this.pendingSeek = idx
    this._applySeek()
    this._emit({ currentTime: t, ended: false })
  }

  skip (seconds) {
    this.seek(this.clock.currentTime + seconds * 1000)
  }

  setScrubbing (on) {
    this.scrubbing = on
    if (!on && this.pstream) {
      // Settle on the exact frame the user released over.
      this.seek(this.clock.currentTime)
    }
  }

  async stepFrames (delta) {
    if (!this.pstream) return
    this.pause()
    const s = this.pstream
    const from = this.curIdx >= 0 ? this.curIdx : frameIndexForTime(s, this.clock.currentTime)
    await this._gotoIndex(clamp(from + delta, 0, s.count - 1))
  }

  setVolume (v) {
    this.volume = clamp(v, 0, 1)
    if (this.volume > 0 && this.muted) this.muted = false
    if (this.audio) this.audio.setVolume(this.muted ? 0 : this.volume)
    this._emit({ volume: this.volume, muted: this.muted })
  }

  toggleMute () {
    this.muted = !this.muted
    if (this.audio) this.audio.setVolume(this.muted ? 0 : this.volume)
    this._emit({ muted: this.muted })
  }

  async setStreamMode (mode) {
    if (!this.index || mode === this.streamMode) return
    try {
      await this._selectStream(mode, false)
    } catch (e) {
      this._emit({ status: 'error', error: e.message })
    }
  }

  onResize () {
    if (this.renderer.resize()) this._repaint()
  }

  // ----------------------------------------------------------------- internal

  async _gotoIndex (idx) {
    if (!this.pstream) return
    const s = this.pstream
    const target = clamp(idx, 0, s.count - 1)
    this.clock.currentTime = s.ts[target]
    this.ended = false
    this.pendingSeek = target
    this._applySeek()
    this._emit({ currentTime: s.ts[target], ended: false })
  }

  _applySeek () {
    if (this.pendingSeek == null || !this.video) return
    const idx = this.pendingSeek
    this.video.seekTo(idx)
    if (this.audio && this.clock.playing) this.audio.seek(this.clock.currentTime)
    // Present immediately when the frame is already resident.
    this._tryPresentPending()
  }

  _tryPresentPending () {
    if (this.pendingSeek == null) return false
    const idx = this.video.decodableIndex(this.pendingSeek)
    const frame = this.video.get(idx)
    if (!frame) return false
    this._present(idx, frame)
    this.pendingSeek = null
    this.clock.setHeld(false)
    return true
  }

  _present (idx, frame) {
    this.curIdx = idx
    this.video.setAnchor(idx)
    this.renderer.draw(frame)
  }

  _repaint () {
    if (this.curIdx >= 0 && this.video) {
      const frame = this.video.get(this.curIdx)
      if (frame) { this.renderer.draw(frame); return }
    }
    this.renderer.redraw()
  }

  _start () {
    if (this._raf) return
    this._raf = requestAnimationFrame(this._loop)
  }

  _stop () {
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = 0
  }

  _loop () {
    this._raf = requestAnimationFrame(this._loop)
    if (!this.pstream || !this.video) return
    const s = this.pstream

    if (this.pendingSeek != null) {
      if (!this._tryPresentPending()) {
        this.clock.setHeld(true)
        if (!this._state.buffering) this._emit({ buffering: true })
        this.video.pump()
        return
      }
      if (this._state.buffering) this._emit({ buffering: false })
    }

    if (!this.scrubbing && this.clock.playing) {
      const t = this.clock.currentTime
      const target = frameIndexForTime(s, t)
      if (target > this.curIdx) {
        const show = this.video.has(target) ? target : this.video.bestAtOrBefore(target)
        if (show > this.curIdx) {
          this._present(show, this.video.get(show))
          this.clock.setHeld(false)
          if (this._state.buffering) this._emit({ buffering: false })
        } else if (this.curIdx < s.count - 1) {
          this.clock.setHeld(true)
          if (!this._state.buffering) this._emit({ buffering: true })
        }
      }
      const lastTs = s.ts[s.count - 1]
      if (this.curIdx >= s.count - 1 && t > lastTs + this.frameIntervalMs) {
        this.clock.currentTime = lastTs + this.frameIntervalMs
        this.pause()
        this.ended = true
        this._emit({ ended: true, currentTime: this.clock.currentTime })
      }
    }

    this.video.pump()
    if (this.audio && this.clock.playing && !this.clock.held) {
      this.audio.pump()
      // Autoplay policy can leave the context suspended after the first play();
      // retry so audio joins as soon as the page earns user activation.
      if (this.audio.ctx && this.audio.ctx.state === 'suspended') this._startAudio()
    }

    const now = this.clock.currentTime
    const idx = Math.max(0, this.curIdx)
    const utc = this.curIdx >= 0 ? s.utc[this.curIdx] : 0
    if (Math.abs(now - this._state.currentTime) > 4 ||
        idx !== this._state.frameIndex ||
        utc !== this._state.currentUtc) {
      this._emit({ currentTime: now, frameIndex: idx, currentUtc: utc })
    }
  }
}
