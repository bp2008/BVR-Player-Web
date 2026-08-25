import { BlobReader } from '../bvr/blobReader.js'
import { parseFileHeader } from '../bvr/parseFileHeader.js'
import { buildIndex, frameIndexForTime } from '../bvr/indexer.js'
import { probeVideoStreams, probeIndexedStream, summarizeProbe } from '../bvr/probe.js'
import {
  buildPlaybackStream, resolveStreamMode, estimateFrameInterval, collectMarkers
} from './playbackStream.js'
import { VideoPipeline } from './VideoPipeline.js'
import { AudioPipeline } from './AudioPipeline.js'
import { MetadataPipeline } from './MetadataPipeline.js'
import { MediaClock, performanceWall } from './MediaClock.js'
import { Renderer } from './Renderer.js'
import { paintOverlay } from './overlayPainter.js'
import { snapshotOverlay } from '../bvr/metadata.js'
import { audioCodecLabel } from './audioCodecs.js'

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/** Rates offered by the UI. Audio is muted away from 1x (see setRate). */
export const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2, 4, 8]

/**
 * The complete shape of the state the player publishes.
 *
 * Exported so the Vue layer can seed itself from the same definition rather
 * than keeping a second copy that quietly drifts as fields are added.
 */
export function createBlankState () {
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
    // The size each stream's pictures actually are, read from the bitstream.
    mainWidth: 0,
    mainHeight: 0,
    subWidth: 0,
    subHeight: 0,
    // The size the file header says they are -- what Blue Iris asked the camera
    // for. Kept apart because the two disagree often, and the difference is what
    // the aspect correction is built on.
    mainDeclaredWidth: 0,
    mainDeclaredHeight: 0,
    subDeclaredWidth: 0,
    subDeclaredHeight: 0,
    startUtc: 0,
    currentUtc: 0,
    truncated: false,
    mainCodecLabel: '',
    subCodecLabel: '',
    mainFourcc: '',
    subFourcc: '',
    mainCodecSupported: true,
    subCodecSupported: true,
    codecWarning: '',
    error: '',

    // The shape every frame is put into, from the header's main-stream
    // resolution; 0 when the correction is off (see _targetAspect).
    displayAspect: 0,
    // The size the stream on screen is actually being drawn at. Equal to
    // width/height when the pictures already have the reference shape, which is
    // how the UI knows whether anything is being rescaled at all.
    displayWidth: 0,
    displayHeight: 0,

    // Digital zoom, driven from outside by the ViewController.
    zoom: 1,
    zoomed: false,

    // Playback speed. Audio only runs at 1x (see setRate).
    rate: 1,

    // Overlay metadata (spec section 7).
    hasMetadata: false,
    overlayEnabled: false,
    overlayObjects: 0,
    overlayShapes: 0,
    overlayReady: false,
    overlayList: [],
    gps: null,
    stateBits: 0,
    dioInputs: 0,

    // Marks and segment starts, for the scrub bar and the inspector.
    marks: [],
    segments: [],
    resyncs: 0,
    fileSizeBytes: 0
  }
}

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
    this.metadata = null
    this.codecInfo = null
    this.probe = null
    this.blob = null

    this.streamMode = 'auto'
    this.matchAspect = true
    this.frameIntervalMs = 33.367

    this.curIdx = -1
    this.pendingSeek = null
    this.scrubbing = false
    this.ended = false
    this.volume = 1
    this.muted = false

    // Which classes of overlay object are drawn over the video. The file's own
    // objects are always parsed; this only decides what reaches the canvas.
    this.overlay = { enabled: false, shapes: true, text: true, graphics: true }
    this.renderer.setOverlayPainter((ctx, geom) => this._paintOverlay(ctx, geom))

    this._raf = 0
    this._generation = 0
    this._destroyed = false
    this._state = createBlankState()
    this._loop = this._loop.bind(this)
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
    this._emit({ ...createBlankState(), status: 'loading', fileName: file.name, fileSize: file.size })

    try {
      this.blob = file
      this.reader = new BlobReader(file)
      this.header = await parseFileHeader(this.reader)
      if (gen !== this._generation) return

      // Codec support is settled from the first key frames, before the scan that
      // reads the rest of the file. A machine with no HEVC decoder should hear so
      // in the first moment rather than after a gigabyte has gone past, and a
      // file whose main stream cannot be decoded here may still have a sub
      // stream that can.
      this.probe = await probeVideoStreams(this.reader, this.header)
      if (gen !== this._generation) return
      this._emitProbe()
      if (this.probe.decided && !this.probe.anySupported) throw new Error(this.probe.summary)

      this.index = await buildIndex(this.reader, this.header, {
        onProgress: (p) => { if (gen === this._generation) this._emit({ loadProgress: p }) },
        shouldStop: () => gen !== this._generation
      })
      if (gen !== this._generation) return

      if (this.index.streams[0].count === 0 && this.index.streams[1].count === 0) {
        throw new Error('This file contains no video frames.')
      }

      // A stream whose frames start only later in the file was invisible to the
      // opening probe; the index now points straight at its first key frame.
      await this._probeMissedStreams()
      if (gen !== this._generation) return
      this._emitProbe()
      if (!this.probe.anySupported) throw new Error(this.probe.summary)

      this.renderer.setOrientation(this.header.rotation, this.header.flipH)
      this.renderer.resetView()
      this._applyDisplayAspect()

      await this._selectStream(this.streamMode, true)
      if (gen !== this._generation) return

      this._setupAudio()
      this._setupMetadata()
      this._emit({
        status: 'ready',
        loadProgress: 1,
        startUtc: this.index.startUtc,
        truncated: this.index.truncated,
        resyncs: this.index.resyncs,
        fileSizeBytes: file.size,
        zoom: 1,
        zoomed: false,
        // Stream presence comes from the finished index rather than the probe:
        // a stream whose frames start late in the file is real even though the
        // opening probe never reached it. The sizes _emitProbe published are
        // the bitstream's own and are left alone.
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

    const playable = [this._streamPlayable(0), this._streamPlayable(1)]
    const effective = resolveStreamMode(this.index, playable, mode)
    this.streamMode = effective

    const pstream = buildPlaybackStream(this.index, this.header, effective, playable, this._probedSizes())
    if (pstream.count === 0) throw new Error('The selected stream contains no frames.')

    const codecInfo = this._codecFor(pstream)
    if (!codecInfo) throw new Error('The selected stream could not be identified.')
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
    const { marks, segments } = collectMarkers(this.index)
    this._emit({
      duration,
      frameCount: pstream.count,
      width: pstream.width,
      height: pstream.height,
      videoLabel: codecInfo.label,
      fps: this.header.fps,
      streamMode: effective,
      streamLabel: pstream.streamLabel,
      marks,
      segments
    })
    // The reference shape does not change with the stream, but whether *this*
    // stream is being rescaled to reach it does.
    this._applyDisplayAspect()

    // On open the codec warning already explains this; only an explicit switch
    // that could not be honoured needs saying out loud.
    if (!initial && effective !== mode) {
      this.onNotice(`The ${mode} stream cannot be decoded on this device \u2014 showing the ${pstream.streamLabel.toLowerCase()} instead.`)
    }

    if (!initial) {
      await this._gotoIndex(frameIndexForTime(pstream, atTime))
      if (wasPlaying) this.play()
    }
  }

  /**
   * Turns the "rescale mismatched streams" behaviour on or off.
   *
   * Cheap enough to apply live: it only changes the destination rectangle the
   * renderer draws into, so the current frame is simply re-presented.
   */
  setMatchAspect (on) {
    const next = !!on
    if (next === this.matchAspect) return
    this.matchAspect = next
    this._applyDisplayAspect()
    this._repaint()
  }

  _applyDisplayAspect () {
    const aspect = this._targetAspect()
    this.renderer.setDisplayAspect(aspect)
    const shown = this.renderer.presentedSize(this._state.width, this._state.height)
    this._emit({ displayAspect: aspect, displayWidth: shown.width, displayHeight: shown.height })
  }

  /**
   * The aspect ratio every frame should be shown in, or 0 to leave frames as
   * they decoded.
   *
   * The reference is the resolution Blue Iris recorded for the *main* stream in
   * the file header, not the resolution either encoder actually produced. That
   * distinction is the whole point: Blue Iris writes down the picture it asked
   * the camera for, and cameras routinely hand back something else. Real files
   * in hand have a sub stream declared 640x480 and encoded 704x480, and another
   * declared 848x480 and encoded 704x480 -- in both, the two streams' *declared*
   * shapes agree to within a fraction of a percent while the pictures that
   * arrive are visibly different shapes. Comparing declared against declared, as
   * this used to, concluded there was nothing to fix and left the sub stream
   * stretched sideways.
   *
   * So the header's main-stream shape is taken as the truth -- it is the field
   * of view the recording claims, and the one the main stream is very nearly
   * always encoded in anyway -- and any frame that decodes to a different shape
   * is put back into it. Frames that already agree are untouched, so a file
   * whose encoders did what they were told sees no change at all; the renderer
   * decides that per frame, which is what a switching-mode file interleaving two
   * differently shaped streams needs.
   *
   * Spec 4.3: a sub-only recording carries no second BITMAPINFOHEADER and
   * readers treat the first as describing the stream they have, so bmih[0] is
   * the right reference whichever streams the file turns out to hold.
   */
  _targetAspect () {
    if (!this.matchAspect || !this.header) return 0
    for (const bmih of [this.header.bmih[0], this.header.bmih[1]]) {
      const w = bmih ? bmih.width : 0
      const h = bmih ? bmih.height : 0
      if (w <= 0 || h <= 0) continue
      const ratio = w / h
      // A header carrying a nonsense resolution is worse than no reference.
      if (ratio < 0.2 || ratio > 5) continue
      return ratio
    }
    return 0
  }

  /** Each stream's real picture size, as the probe read it out of the bitstream. */
  _probedSizes () {
    if (!this.probe) return null
    return this.probe.streams.map((s) => (s ? { width: s.width, height: s.height } : null))
  }

  /** Whether a source stream may be fed to the decoder; unprobed means "try it". */
  _streamPlayable (si) {
    const p = this.probe && this.probe.streams[si]
    return p ? p.supported : true
  }

  /** The decoder configuration for a playback stream, from the probe. */
  _codecFor (pstream) {
    const probed = this.probe && this.probe.streams[pstream.codecSource]
    if (!probed) return null
    const info = probed.codec
    if (info.kind !== 'video' || !pstream.variableResolution) return info
    // A switching-mode sequence carries both resolutions; configure for the larger.
    return {
      ...info,
      config: {
        ...info.config,
        codedWidth: pstream.width || undefined,
        codedHeight: pstream.height || undefined
      }
    }
  }

  async _probeMissedStreams () {
    let changed = false
    for (let si = 0; si < 2; si++) {
      const known = this.probe.streams[si]
      if (this.index.streams[si].count === 0) continue
      if (known && known.hasKeyFrame) continue
      const info = await probeIndexedStream(this.reader, this.header, this.index, si)
      if (info) { this.probe.streams[si] = info; changed = true }
    }
    if (changed) this.probe = summarizeProbe(this.probe.streams)
  }

  _emitProbe () {
    const [main, sub] = this.probe.streams
    const pick = (main && main.supported) ? main : (sub && sub.supported) ? sub : (main || sub)
    this._emit({
      hasMainStream: !!main,
      hasSubStream: !!sub,
      mainWidth: main ? main.width : (this.header.bmih[0]?.width || 0),
      mainHeight: main ? main.height : (this.header.bmih[0]?.height || 0),
      subWidth: sub ? sub.width : (this.header.bmih[1]?.width || 0),
      subHeight: sub ? sub.height : (this.header.bmih[1]?.height || 0),
      mainDeclaredWidth: this.header.bmih[0]?.width || 0,
      mainDeclaredHeight: this.header.bmih[0]?.height || 0,
      subDeclaredWidth: this.header.bmih[1]?.width || this.header.bmih[0]?.width || 0,
      subDeclaredHeight: this.header.bmih[1]?.height || this.header.bmih[0]?.height || 0,
      mainCodecLabel: main ? main.codec.label : '',
      subCodecLabel: sub ? sub.codec.label : '',
      mainFourcc: main ? main.fourcc : '',
      subFourcc: sub ? sub.fourcc : '',
      mainCodecSupported: main ? main.supported : true,
      subCodecSupported: sub ? sub.supported : true,
      codecWarning: this._codecWarning(),
      videoLabel: pick ? pick.codec.label : '',
      width: pick ? pick.width : 0,
      height: pick ? pick.height : 0
    })
  }

  _codecWarning () {
    const p = this.probe
    if (!p || !p.someUnsupported) return ''
    const bad = p.streams.filter((s) => s && !s.supported)
    const good = p.streams.filter((s) => s && s.supported)
    const badList = bad.map((s) => `${s.name} (${s.codec.label})`).join(' and ')
    return `This device cannot decode the ${badList} stream${bad.length > 1 ? 's' : ''}. ` +
      `Playing the ${good.map((s) => s.name).join(' and ')} stream instead.`
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

  _setupMetadata () {
    if (this.metadata) { this.metadata.close(); this.metadata = null }
    const pipeline = new MetadataPipeline({
      blob: this.blob,
      index: this.index,
      onChange: (state) => this._onOverlayChange(state)
    })
    if (!pipeline.hasRecords) {
      this._emit({ hasMetadata: false, overlayObjects: 0, overlayShapes: 0, overlayReady: false })
      return
    }
    this.metadata = pipeline
    this._emit({ hasMetadata: true })
    // The definitions decide what the update records mean, so nothing can be
    // read until they are in hand.
    pipeline.load().then(() => {
      if (!this.metadata) return
      this._emit({ overlayReady: true })
      this._updateMetadata(true)
    }).catch(() => { /* the file plays with or without overlays */ })
  }

  _onOverlayChange (state) {
    const objects = snapshotOverlay(state)
    let shapes = 0
    for (const obj of objects) shapes += obj.shapes.length
    this._emit({
      overlayObjects: objects.length,
      overlayShapes: shapes,
      overlayList: objects,
      gps: state.gps
    })
    if (this.overlay.enabled) this._repaint()
  }

  /** Nudges the overlay state to wherever the playhead now is. */
  _updateMetadata (force) {
    if (!this.metadata) return
    const s = this.pstream
    if (!s) return
    const idx = this.curIdx >= 0 ? this.curIdx : 0
    const ms = s.ts[idx]
    if (!force && ms === this._metaAt) return
    this._metaAt = ms
    const key = s.keyIdx[idx]
    this.metadata.update(ms, key >= 0 ? s.ts[key] : ms)
  }

  _paintOverlay (ctx, geom) {
    if (!this.overlay.enabled || !this.metadata) return
    const s = this.pstream
    const idx = this.curIdx >= 0 ? this.curIdx : 0
    paintOverlay(ctx, geom, {
      state: this.metadata.state,
      stateBits: s ? s.state[idx] : 0,
      dio: s ? s.dio[idx] : 0,
      show: this.overlay
    })
  }

  setOverlay (patch) {
    this.overlay = { ...this.overlay, ...patch }
    this._emit({ overlayEnabled: this.overlay.enabled })
    if (this.overlay.enabled) this._updateMetadata(true)
    this._repaint()
  }

  /** The records that apply at the playhead, for the inspector panel. */
  async metadataAt (ms) {
    if (!this.metadata) return null
    return this.metadata.recordAt(ms)
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
    if (this.metadata) { this.metadata.close(); this.metadata = null }
    if (this.reader) { this.reader.release(); this.reader = null }
    this.header = null
    this.index = null
    this.probe = null
    this.pstream = null
    this.blob = null
    this.curIdx = -1
    this.pendingSeek = null
    this._metaAt = null
    this.clock.setWallSource(performanceWall)
    this.clock.pause()
    this.clock.rate = 1
    this.clock.currentTime = 0
    this.renderer.forget()
    this.renderer.resetView()
    this.renderer.setDisplayAspect(0)
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

  /**
   * Sets the playback speed.
   *
   * Audio only runs at 1x. Resampling it to follow the video is what the
   * reference Blue Iris player declines to do as well, and pitch-shifted
   * surveillance audio would be worse than none: the useful thing at 4x is to
   * see the picture move, and at 0.25x to see it clearly. The clock itself is
   * rate-aware, so video timing needs nothing beyond this.
   */
  setRate (rate) {
    const next = clamp(Number(rate) || 1, 0.05, 16)
    if (next === this.clock.rate) return
    // Re-anchor before the rate changes, or elapsed time would be re-scaled
    // retroactively and the picture would jump.
    const at = this.clock.currentTime
    this.clock.rate = next
    this.clock.currentTime = at
    if (this.audio) {
      this.audio.stop()
      if (next === 1 && this.clock.playing) this.audio.seek(at)
    }
    this._emit({ rate: next })
  }

  onResize () {
    if (this.renderer.resize()) this._repaint()
  }

  /** Re-presents the current frame; used after a zoom, pan or overlay change. */
  repaint () {
    this._repaint()
  }

  /** Publishes the view state the UI shows, after the ViewController moved it. */
  notifyView () {
    this._emit({ zoom: this.renderer.view.zoom, zoomed: this.renderer.zoomed })
  }

  /**
   * The frame on screen, drawn into a canvas of its own.
   *
   * The pipeline's copy is preferred over whatever the renderer last drew: a
   * VideoFrame the decoder has since recycled cannot be drawn from again, and
   * asking for it by index is the same lookup a repaint does. Returns null when
   * there is no picture to save, which the caller reports rather than throws.
   */
  snapshotCanvas () {
    let frame = null
    if (this.curIdx >= 0 && this.video) frame = this.video.get(this.curIdx)
    try {
      return this.renderer.snapshot(frame || undefined)
    } catch {
      return null
    }
  }

  /** What a saved still should be named after: the clip, and where in it. */
  snapshotContext () {
    const s = this.pstream
    const idx = this.curIdx >= 0 ? this.curIdx : 0
    return {
      fileName: this._state.fileName,
      frameIndex: idx,
      timeMs: s ? s.ts[idx] : this._state.currentTime,
      utcMs: s && s.utc ? s.utc[idx] : 0
    }
  }

  /**
   * Everything an export needs, gathered in one place so the dialog never has to
   * reach into the player's internals.
   */
  exportContext () {
    if (!this.pstream || !this.index) return null
    return {
      blob: this.blob,
      header: this.header,
      index: this.index,
      pstream: this.pstream,
      fileName: this._state.fileName,
      // The probe already settled this against a real key frame, and it is what
      // a transcode has to configure its decoder with.
      decoderConfig: this.codecInfo && this.codecInfo.kind === 'video' ? this.codecInfo.config : null,
      audioStarts: this.audio ? this.audio.packetStartMs : null
    }
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
    // Overlays are folded forward before the frame is painted, so a record that
    // is already resident lands on the same frame it describes.
    this._updateMetadata(false)
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
      this._emit({
        currentTime: now,
        frameIndex: idx,
        currentUtc: utc,
        stateBits: this.curIdx >= 0 ? s.state[this.curIdx] : 0,
        dioInputs: this.curIdx >= 0 ? s.dio[this.curIdx] : 0
      })
    }
  }
}
