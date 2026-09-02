import { BlobReader } from '../bvr/blobReader.js'
import { frameIndexForTime } from '../bvr/indexer.js'
import { openContainer } from '../container/open.js'
import {
  autoStreamSources, buildPlaybackStream, resolveStreamMode, estimateFrameInterval, collectMarkers
} from './playbackStream.js'
import { fileCoverage, gapThreshold } from './coverage.js'
import { VideoPipeline } from './VideoPipeline.js'
import { AudioPipeline } from './AudioPipeline.js'
import { MetadataPipeline } from './MetadataPipeline.js'
import { MediaClock, performanceWall } from './MediaClock.js'
import { Renderer } from './Renderer.js'
import { paintOverlay } from './overlayPainter.js'
import { snapshotOverlay } from '../bvr/metadata.js'
import { audioCodecLabel } from './audioCodecs.js'
import { describeNoVideo, streamLabelFor } from '../container/mediaInfo.js'
import { STREAM_MAIN, STREAM_SUB } from '../bvr/constants.js'

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/** Rates offered by the UI. Audio is muted away from 1x (see setRate). */
export const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2, 4, 8]

/**
 * How long a scrub frame may be in flight before the viewer is told about it.
 *
 * A drag renders at whatever rate the decoder can keep up with, which on a long
 * recording is a handful of frames a second; announcing each of those gaps as
 * buffering makes ordinary scrubbing look like it is failing. Past this, the
 * wait is long enough to be worth explaining.
 */
const SCRUB_BUSY_MS = 400

/**
 * ...and how long before a scrub frame that has not arrived is presumed stuck.
 *
 * A drag deliberately never cancels the picture it is waiting for, so a decode
 * that will never produce one would otherwise freeze the drag outright. Well
 * past any plausible key-frame decode, so this only ever fires on trouble.
 */
const SCRUB_STALL_MS = 1200

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
    // Which container the open file is: 'bvr' or 'mp4'. The panels use it to
    // stop offering things the format has no answer for.
    container: '',
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
    // Which of the file's streams `auto` will actually draw on, in preference
    // order. One entry means auto settles on a single stream; two means it
    // switches between them. The stream menu labels itself from this.
    autoStreams: [],
    // Where each stream has pictures, for the scrub bar. See coverage.js.
    coverage: null,
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
    this.container = ''
    this.movie = null

    this.streamMode = 'auto'
    this.matchAspect = true
    this.frameIntervalMs = 33.367
    this.duration = 0
    // How long each of the file's streams may go without a frame before that is
    // a hole to be skipped rather than a slow frame rate; see coverage.js.
    this.gapBySource = [0, 0]

    this.curIdx = -1
    this.pendingSeek = null
    this.ended = false
    // Source stream -> the reorder depth that stream's decoder turned out to
    // want, learned once per file. Keyed by the stream and not by the mode
    // playing it: how much input a decoder swallows follows from the picture it
    // is decoding, so what the main stream wanted on its own is what it wants
    // again inside an `auto` sequence.
    this._reorderSeen = []

    // Scrubbing. `scrubTarget` is the position the pointer has reached while the
    // picture for an earlier one is still being decoded; the two settings are
    // written straight from the settings panel. See seek() and setScrubbing().
    this.scrubbing = false
    this.scrubTarget = null
    this.scrubExact = false
    this.pauseWhileSeeking = false
    this._seekStartedAt = 0
    this._resumeAfterScrub = false
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
      this._reorderSeen = []
      this.reader = new BlobReader(file)

      // One call for both formats; `container/open.js` is the only code left in
      // the app that knows the difference. The probe arrives through a callback
      // rather than with everything else because a BVR file has to be read end
      // to end before its frame table exists, and a machine with no HEVC decoder
      // should hear so in the first moment rather than after a gigabyte has gone
      // past. An MP4 reaches the same point at once and reports the same way.
      const opened = await openContainer(this.reader, {
        onProbe: (probe, header) => {
          if (gen !== this._generation) return
          this.header = header
          this.probe = probe
          this._emitProbe()
        },
        onProgress: (p) => { if (gen === this._generation) this._emit({ loadProgress: p }) },
        shouldStop: () => gen !== this._generation
      })
      if (gen !== this._generation) return

      this.container = opened.container
      this.header = opened.header
      this.index = opened.index
      this.probe = opened.probe
      this.movie = opened.movie || null
      this._emit({ container: opened.container })
      this._emitProbe()

      if (this.index.streams[0].count === 0 && this.index.streams[1].count === 0) {
        // Not just "no video frames": the file is plainly not empty, so the
        // message says what it does hold and points at the report that says the
        // rest. See describeNoVideo.
        throw new Error(describeNoVideo(this.header, this.index))
      }
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
        switchingMode: this.index.switchingMode,
        autoStreams: autoStreamSources(this.index, this.header, this._playable(), this._probedSizes()),
        coverage: fileCoverage(this.index, this._headerIntervalMs())
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

    const playable = this._playable()
    const effective = resolveStreamMode(this.index, playable, mode)
    this.streamMode = effective

    const pstream = buildPlaybackStream(this.index, this.header, effective, playable, this._probedSizes())
    if (pstream.count === 0) throw new Error('The selected stream contains no frames.')

    const codecInfo = this._codecFor(pstream)
    if (!codecInfo) throw new Error('The selected stream could not be identified.')
    const unsupported = (codecInfo.bySource ? Object.values(codecInfo.bySource) : [codecInfo])
      .find((c) => c && c.kind === 'unsupported')
    if (unsupported) {
      throw new Error(`Unsupported video codec: ${unsupported.label}. Browsers cannot decode this stream.`)
    }

    // How much input each stream's decoder wanted, kept across a switch.
    // Working it out costs a fraction of a second of the picture not moving --
    // see VideoPipeline._feedAhead -- and paying that again every time someone
    // compares the two streams is exactly the sort of thing to remember. The
    // deepest reading wins, since the allowance is only ever too small.
    if (this.video) {
      const seen = this.video.reorder
      for (let si = 0; si < seen.length; si++) {
        if (seen[si] > (this._reorderSeen[si] || 0)) this._reorderSeen[si] = seen[si]
      }
      this.video.close()
    }
    this.video = new VideoPipeline({
      reader: this.reader,
      onError: (e) => this._onPipelineError(e),
      reorderHints: this._reorderSeen
    })
    await this.video.open(pstream, codecInfo)

    this.pstream = pstream
    this.codecInfo = codecInfo
    this.frameIntervalMs = estimateFrameInterval(pstream, this.header.frameInterval)
    this.curIdx = -1
    this.scrubTarget = null
    this.video.setScrubbing(this.scrubbing)
    this.renderer.forget()

    // The timeline is the recording's, not the selected stream's.
    //
    // A file whose main stream covers twenty minutes of an hour is still an hour
    // long: its audio runs the whole way, its sub stream runs the whole way, and
    // a scrub bar that shrank to twenty minutes when the main stream was picked
    // would be describing the stream rather than the recording -- with no way to
    // see, or reach, the fifty minutes the other stream has. So every mode
    // shares one duration and the coverage banding says what is where.
    const duration = Math.max(pstream.ts[pstream.count - 1], this.index.durationMs) + this.frameIntervalMs
    this.duration = duration
    this._sizeGaps()
    const { marks, segments } = collectMarkers(this.index)
    // Where the playhead lands in the *new* sequence. Frame indices only mean
    // anything against the table they were counted in, and the three modes count
    // different tables -- an hour of sub stream is seventy thousand frames where
    // the triggered main stream is six -- so publishing the new frame table
    // without the index into it would leave everything reading the pair
    // describing a frame that does not exist.
    const startIdx = frameIndexForTime(pstream, atTime)
    this._emit({
      duration,
      frameCount: pstream.count,
      frameIndex: startIdx,
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
      await this._gotoIndex(startIdx)
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
  _referenceShape () {
    if (!this.matchAspect || !this.header) return null
    for (const bmih of [this.header.bmih[0], this.header.bmih[1]]) {
      const w = bmih ? bmih.width : 0
      const h = bmih ? bmih.height : 0
      if (w <= 0 || h <= 0) continue
      const ratio = w / h
      // A header carrying a nonsense resolution is worse than no reference.
      if (ratio < 0.2 || ratio > 5) continue
      // The two integers are kept, not just their quotient: an export turns them
      // into an exact MP4 pixel aspect ratio, which a float cannot do.
      return { width: w, height: h, ratio }
    }
    return null
  }

  _targetAspect () {
    const reference = this._referenceShape()
    return reference ? reference.ratio : 0
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

  _playable () {
    return [this._streamPlayable(0), this._streamPlayable(1)]
  }

  /** The header's nominal frame interval in ms, as a last-resort fallback. */
  _headerIntervalMs () {
    const us = this.header ? this.header.frameInterval : 0
    return us > 0 ? us / 1000 : 40
  }

  /**
   * The decoder configuration for a playback stream, from the probe.
   *
   * A merged sequence carries one per source stream, because the pipeline runs
   * one decoder per source stream: main and sub need not share a codec, and even
   * when they do they do not share a resolution, so a decoder each is both
   * simpler and more accurate than one decoder reconfigured on the fly.
   */
  _codecFor (pstream) {
    const sources = pstream.sources || [pstream.codecSource]
    const primary = this.probe && this.probe.streams[pstream.codecSource]
    if (!primary) return null
    if (sources.length < 2) return primary.codec

    const bySource = []
    for (const si of sources) {
      const probed = this.probe.streams[si]
      if (!probed) return null
      bySource[si] = probed.codec
    }
    return { ...primary.codec, bySource }
  }

  /**
   * How long each stream may go without a frame before playback should jump the
   * hole rather than sit on the last picture.
   *
   * Per source, because the whole point is that the two streams can run at
   * wildly different rates -- and in a merged sequence the frame before a hole
   * and the frame after it may belong to different streams. A hole is only
   * skipped when it is longer than what *both* of those streams call ordinary,
   * which is the conservative reading and the one that never fast-forwards
   * through a slow stream.
   */
  _sizeGaps () {
    const fallback = this._headerIntervalMs()
    this.gapBySource = [
      gapThreshold(this.index.streams[0], fallback),
      gapThreshold(this.index.streams[1], fallback)
    ]
  }

  _gapAfter (i) {
    const s = this.pstream
    const a = s.srcStream ? s.srcStream[i] : s.codecSource
    const b = s.srcStream ? s.srcStream[Math.min(i + 1, s.count - 1)] : a
    return Math.max(this.gapBySource[a] || 0, this.gapBySource[b] || 0)
  }

  /**
   * Moves the playhead across a stretch the sequence being played has no
   * pictures for.
   *
   * A continuous-sub, motion-triggered-main recording played on `main` alone is
   * mostly hole: the first picture may be twenty minutes in and the last twenty
   * minutes from the end. Left alone the player sits on one frame while the
   * audio runs, which looks exactly like a decoder that has given up. Jumping to
   * the next picture that exists is both what is wanted and what the scrub bar's
   * coverage banding has already told the viewer to expect.
   *
   * The wait before jumping is half the gap threshold, so a stream with a slow
   * but steady rate is never hurried along -- by construction its ordinary
   * spacing is well inside the threshold, so this cannot fire on it at all.
   */
  _skipEmptyStretch () {
    const s = this.pstream
    if (!s || s.count === 0) return false
    const t = this.clock.currentTime

    const lead = this._gapAfter(0)
    if (lead > 0 && t < s.ts[0] - lead / 2) { this.seek(s.ts[0]); return true }

    const i = frameIndexForTime(s, t)
    if (i < 0 || i >= s.count - 1) return false
    const gap = this._gapAfter(i)
    if (!gap || s.ts[i + 1] - s.ts[i] <= gap) return false
    if (t - s.ts[i] <= gap / 2) return false
    this.seek(s.ts[i + 1])
    return true
  }

  /**
   * Whether the sequence being played has nothing left to show.
   *
   * The recording ends where the recording ends, which on a stream that stops
   * early is well past its own last picture. Running the clock out to there
   * left the last frame frozen on screen while the audio played on, which reads
   * as a decoder that has given up rather than as a stream that has finished --
   * so once that frame has had its time on screen, playback is over.
   *
   * The wait matches `_skipEmptyStretch`: half the gap threshold, which is at
   * least half a second and by construction longer than the stream's own frame
   * spacing, so a stream that simply runs to the end of the recording reaches
   * `duration` first and ends there instead.
   */
  _outOfPictures () {
    const s = this.pstream
    if (!s || s.count === 0) return false
    const last = s.count - 1
    if (this.curIdx < last) return false
    return this.clock.currentTime - s.ts[last] > this._gapAfter(last) / 2
  }

  /** Parks the playhead at the end of the recording and reports the stop. */
  _finish () {
    this.clock.currentTime = this.duration
    this.pause()
    this.ended = true
    this._emit({ ended: true, currentTime: this.clock.currentTime })
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
    const declared = this.header.audioConfig && this.header.audioConfig.label
    this._emit({ hasAudio: true, audioLabel: declared || audioCodecLabel(this.header.wfx) })
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
    this.container = ''
    this.movie = null
    this.curIdx = -1
    this.pendingSeek = null
    this.scrubTarget = null
    this.duration = 0
    this.gapBySource = [0, 0]
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

  /**
   * Closes the file and returns the player to the state the app started in.
   *
   * `closeFile` drops everything the file owned but leaves the published state
   * describing it, which is what an open needs -- the next `open` overwrites it
   * a moment later. Going *back* has nothing coming after it, so the state has
   * to be reset as well or the app would keep showing the recording's chrome
   * over an empty canvas.
   */
  close () {
    this.closeFile()
    this._emit(createBlankState())
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
   * Seeks to a media time.
   *
   * `preview` marks the scrub-bar path, where two things are true that are not
   * true of any other seek. It settles for the key frame enclosing the target
   * rather than the frame itself, which is one decode instead of a whole GOP of
   * them -- unless the viewer has asked otherwise. And, while the pointer is
   * still down, it will not interrupt a picture that is already on its way: a
   * drag asks for new positions far faster than any decoder can answer, and
   * restarting on each one meant a quick drag rendered nothing whatsoever. A
   * request that arrives mid-decode is remembered instead and issued the moment
   * that picture lands, so what the viewer sees is every few frames of what they
   * dragged past rather than none of it. Media time still follows the pointer
   * exactly; only the picture runs a beat behind.
   */
  seek (ms, { preview = false } = {}) {
    if (!this.pstream) return
    const t = clamp(ms, 0, Math.max(0, this.duration - this.frameIntervalMs))
    this.clock.currentTime = t
    this.ended = false
    this._emit({ currentTime: t, ended: false })

    if (preview && this.scrubbing && this.pendingSeek != null) {
      this.scrubTarget = t
      return
    }
    this.scrubTarget = null
    this._startSeek(t, preview)
  }

  /** The half of seek() that actually moves the decoder. */
  _startSeek (t, preview) {
    const s = this.pstream
    const exactIdx = frameIndexForTime(s, t)
    const idx = preview && !this.scrubExact
      ? Math.max(0, s.keyIdx[exactIdx])
      : exactIdx
    // Dragging across a long GOP asks for the same picture many times over;
    // re-presenting it on each pointer move is a full canvas repaint for no
    // change at all. Nothing is being waited for on this path, so the hold a
    // previous wait may have left behind has to come off here.
    if (idx === this.curIdx && this.pendingSeek == null && this.video && this.video.has(idx)) {
      this.clock.setHeld(false)
      return
    }
    this.pendingSeek = idx
    this._seekStartedAt = performance.now()
    this._applySeek()
  }

  skip (seconds) {
    this.seek(this.clock.currentTime + seconds * 1000)
  }

  /**
   * Enters or leaves a drag on the scrub bar.
   *
   * While the pointer is down the pipeline decodes no further than the frame
   * being asked for and seek requests queue rather than cancel one another. On
   * release the drag's last position is decoded exactly -- and there, cancelling
   * whatever is still in flight for a position the pointer left long ago is
   * exactly the right thing to do.
   */
  setScrubbing (on) {
    on = !!on
    if (on === this.scrubbing) return
    this.scrubbing = on
    if (this.video) this.video.setScrubbing(on)

    if (on) {
      // Held playback would otherwise sound out a blip of audio between one seek
      // and the next; some viewers navigate by those, so it is a preference.
      this._resumeAfterScrub = this.pauseWhileSeeking && this.clock.playing
      if (this._resumeAfterScrub) this.pause()
      return
    }

    this.scrubTarget = null
    if (this.pstream) this.seek(this.clock.currentTime)
    if (this._resumeAfterScrub) {
      this._resumeAfterScrub = false
      // Resuming from the last moment of the clip would restart it from zero,
      // which is not what letting go of the scrub bar at the end asked for.
      if (this.clock.currentTime < this._state.duration - 1) this.play()
    }
  }

  async stepFrames (delta) {
    if (!this.pstream) return
    this.pause()
    const s = this.pstream
    // A seek still being decoded counts from where it was going, not from the
    // last picture that made it to the screen. Stepping a frame straight after
    // clicking the scrub bar is an ordinary thing to do, and on a stream slow
    // enough that the click has not landed yet, `curIdx` is still wherever
    // playback left off -- which could be minutes away.
    const from = this.pendingSeek != null ? this.pendingSeek
      : this.curIdx >= 0 ? this.curIdx
        : frameIndexForTime(s, this.clock.currentTime)
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
   * What the metadata report needs from a file that is already open: the three
   * objects the container reader produced, and the blob they describe.
   *
   * Null once nothing is open, which includes every failed open -- the report is
   * most wanted exactly then, so it reads the file again for itself rather than
   * this holding a half-opened file alive on the chance somebody asks.
   */
  metadataContext () {
    if (!this.blob || !this.header || !this.index) return null
    return {
      blob: this.blob,
      fileName: this._state.fileName,
      header: this.header,
      index: this.index,
      probe: this.probe
    }
  }

  /**
   * Everything an export needs, gathered in one place so the dialog never has to
   * reach into the player's internals.
   */
  exportContext () {
    if (!this.index || !this.header) return null
    return {
      blob: this.blob,
      header: this.header,
      index: this.index,
      fileName: this._state.fileName,
      // The stream the player happens to be showing. Only the export's *initial*
      // choice: it builds its own sequence from there, so which stream gets
      // exported is the dialog's to decide and can be changed without disturbing
      // playback. Tying the two together is what used to make the export's
      // options depend on how the player was set when the file was opened.
      streamMode: this.streamMode,
      // What the merged sequence is allowed to draw on, and the real picture
      // sizes to build any of the three sequences with.
      playable: this._playable(),
      probedSizes: this._probedSizes(),
      // Everything the export needs to know about each of the file's video
      // streams, whether or not it is the one on screen.
      streamInfo: this._streamInfo(),
      // The shape the picture is being shown in, so an export comes out looking
      // like what was on screen. Null when the correction is switched off.
      reference: this._referenceShape(),
      audioStarts: this.audio ? this.audio.packetStartMs : null
    }
  }

  /**
   * Each video stream the file holds, as the export dialog needs to see it.
   *
   * Sparse by stream id, and drawn from the probe rather than from whatever is
   * playing: the dialog offers all of them, so it needs the size, the codec and
   * the decoder configuration of the stream that is *not* on screen just as much
   * as the one that is. `config` is null for a stream this device cannot decode,
   * which rules out re-encoding it but not copying it.
   */
  _streamInfo () {
    const both = this.index.streams[STREAM_MAIN].count > 0 &&
      this.index.streams[STREAM_SUB].count > 0
    const sizes = this._probedSizes()
    const out = []
    for (const si of [STREAM_MAIN, STREAM_SUB]) {
      const s = this.index.streams[si]
      if (!s || s.count === 0) { out[si] = null; continue }
      const probed = this.probe && this.probe.streams[si]
      const bmih = this.header.bmih[si] || this.header.bmih[0]
      const size = (sizes && sizes[si]) || null
      out[si] = {
        label: streamLabelFor(this.header.container, si, both),
        width: (size && size.width) || (bmih && bmih.width) || 0,
        height: (size && size.height) || (bmih && bmih.height) || 0,
        fourcc: (bmih && bmih.fourcc) || '',
        codecLabel: probed ? probed.codec.label : '',
        supported: probed ? probed.supported : true,
        config: probed && probed.codec.kind === 'video' ? probed.codec.config : null,
        frames: s.count
      }
    }
    return out
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
    // Wherever the drag got to while this picture was being decoded: its turn
    // now. Nothing further can queue behind it until it too has been presented,
    // so this recurses at most one level deep.
    if (this.scrubTarget != null) {
      const t = this.scrubTarget
      this.scrubTarget = null
      this._startSeek(t, true)
    }
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
        const waited = performance.now() - this._seekStartedAt
        if (!this._state.buffering && (!this.scrubbing || waited > SCRUB_BUSY_MS)) {
          this._emit({ buffering: true })
        }
        // Nothing has come back for far longer than a key frame can take, so the
        // picture being waited on is not coming. Rather than leave the drag
        // frozen on one the pointer left seconds ago, let the newest position
        // start over.
        if (this.scrubTarget != null && waited > SCRUB_STALL_MS) {
          const t = this.scrubTarget
          this.scrubTarget = null
          this.pendingSeek = null
          this._startSeek(t, true)
        }
        this.video.pump()
        return
      }
      if (this._state.buffering) this._emit({ buffering: false })
    }

    if (!this.scrubbing && this.clock.playing && !this._skipEmptyStretch()) {
      const t = this.clock.currentTime
      const target = frameIndexForTime(s, t)
      if (target > this.curIdx) {
        const show = this.video.has(target) ? target : this.video.bestAtOrBefore(target)
        const past = show > this.curIdx ? -1 : this.video.nextAfter(target)
        if (show > this.curIdx) {
          this._present(show, this.video.get(show))
          this.clock.setHeld(false)
          if (this._state.buffering) this._emit({ buffering: false })
        } else if (past >= 0) {
          // Nothing at or before the frame being waited on, but something after
          // it, so that frame is not coming; see `VideoPipeline.nextAfter`.
          // Waiting anyway is a stall with no way out of it, because holding the
          // clock freezes the very time that decides which frame is asked for --
          // the player would sit on the same absent picture for as long as the
          // page stayed open. Land on the next picture there actually is.
          this.seek(s.ts[past])
          return
        } else if (this.curIdx < s.count - 1) {
          this.clock.setHeld(true)
          if (!this._state.buffering) this._emit({ buffering: true })
        }
      }
      if (t >= this.duration || this._outOfPictures()) this._finish()
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
