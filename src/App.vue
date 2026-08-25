<template>
  <div
    ref="root"
    class="app"
    :class="{ 'app--idle': !hasFile, 'app--hide-ui': !uiVisible, 'app--dragpanel': !!dragging }"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
    @pointermove="onPointerMove"
    @pointerdown="onPointerDown"
    @pointerleave="onPointerLeave"
  >
    <div class="app__body" ref="body">
      <!-- One element per dock. Which side of the video each lands on is CSS
           `order`, so the stage can stay in one place in the markup. -->
      <aside
        v-for="side in SIDES"
        :key="side"
        class="dock"
        :class="[
          'dock--' + side,
          'dock--' + docks[side].mode,
          { 'dock--drop': dragging && dropHint.side === side }
        ]"
        :style="dockStyle(side)"
      >
        <div
          v-if="docks[side].mode === 'open'"
          class="dock__resizer"
          role="separator"
          :aria-label="`Resize the ${side} panels`"
          @pointerdown="startResize(side, $event)"
        ></div>

        <div v-if="docks[side].mode === 'rail'" class="dock__rail">
          <button
            v-for="id in dockIds(side)"
            :key="id"
            type="button"
            class="rail__btn"
            :class="{ 'rail__btn--on': id === activePanel }"
            :title="`Show ${panelTitle(id)}`"
            @click="focusPanel(id)"
          >
            <AppIcon :name="panelIcon(id)" :size="18" />
            <span class="rail__label">{{ panelShort(id) }}</span>
          </button>
        </div>

        <div :id="'dock-stack-' + side" class="dock__stack"></div>
      </aside>

      <div class="stage" ref="stage" @click="onStageClick" @dblclick="onStageDblClick">
        <canvas ref="canvas" class="stage__canvas" :class="{ 'stage__canvas--grab': state.zoomed }"></canvas>

        <div v-if="!hasFile" class="dropzone">
          <div class="dropzone__card">
            <AppIcon name="film" :size="46" />
            <h1 class="dropzone__title">BVR Player</h1>
            <p class="dropzone__text">
              Drop a Blue Iris <code>.bvr</code> recording here, or choose one to open.
              Files are decoded locally in your browser and never uploaded.
            </p>
            <div class="dropzone__buttons">
              <button type="button" class="btn btn--accent" @click.stop="pickFile">
                <AppIcon name="folder" :size="18" />
                <span>Open .bvr file</span>
              </button>
              <button v-if="canBrowse" type="button" class="btn" @click.stop="openLibrary">
                <AppIcon name="library" :size="18" />
                <span>Browse a folder</span>
              </button>
            </div>
            <p v-if="!webCodecsOk" class="dropzone__warn">
              <AppIcon name="alert" :size="16" />
              <span>This browser has no WebCodecs support. Use a recent Chrome, Edge or Opera.</span>
            </p>
          </div>
        </div>

        <div v-if="state.status === 'loading'" class="overlay">
          <div class="overlay__box">
            <div class="spinner"></div>
            <p class="overlay__title">Indexing {{ state.fileName }}</p>
            <div class="progress"><div class="progress__bar" :style="{ width: (state.loadProgress * 100).toFixed(1) + '%' }"></div></div>
            <p class="overlay__sub">{{ (state.loadProgress * 100).toFixed(0) }}% of {{ formatBytes(state.fileSize) }}</p>
            <p v-if="state.codecWarning" class="overlay__warn">
              <AppIcon name="alert" :size="15" />
              <span>{{ state.codecWarning }}</span>
            </p>
          </div>
        </div>

        <div v-if="state.status === 'error'" class="overlay">
          <div class="overlay__box overlay__box--error">
            <AppIcon name="alert" :size="34" />
            <p class="overlay__title">Could not play this file</p>
            <p class="overlay__sub overlay__sub--wrap">{{ state.error }}</p>
            <button type="button" class="btn" @click.stop="pickFile">Choose another file</button>
          </div>
        </div>

        <button
          v-if="hasFile && !state.playing && state.status === 'ready' && !state.buffering"
          type="button"
          class="bigplay"
          aria-label="Play"
          @click.stop="togglePlay"
        >
          <AppIcon name="play" :size="42" />
        </button>

        <header class="topbar">
          <div class="topbar__left">
            <AppIcon name="film" :size="18" />
            <span class="topbar__name">{{ state.fileName || 'BVR Player' }}</span>
            <span v-if="state.truncated" class="topbar__flag" title="The final frame is incomplete; playback stops at the last whole frame.">truncated</span>
          </div>
          <div class="topbar__right">
            <button v-if="installPrompt" type="button" class="btn btn--ghost" @click.stop="install">Install</button>
            <button v-if="canBrowse" type="button" class="btn btn--ghost" title="Browse a folder (L)" @click.stop="openLibrary">
              <AppIcon name="library" :size="16" />
              <span class="topbar__btntext">Browse</span>
            </button>
            <button type="button" class="btn btn--ghost" title="Open a file (O)" @click.stop="pickFile">
              <AppIcon name="folder" :size="16" />
              <span>Open</span>
            </button>
          </div>
        </header>

        <!-- Only while a title bar is in flight: somewhere to aim at, including
             for a side that holds no panels yet and so has no dock on screen. -->
        <template v-if="dragging">
          <div class="dropedge dropedge--left" :class="{ 'dropedge--on': dropHint.side === 'left' }">
            <AppIcon name="dockLeft" :size="20" />
          </div>
          <div class="dropedge dropedge--right" :class="{ 'dropedge--on': dropHint.side === 'right' }">
            <AppIcon name="dockRight" :size="20" />
          </div>
        </template>

        <ControlBar
          v-if="state.status === 'ready'"
          class="controlbar"
          :state="state"
          :settings="settings"
          :fullscreen="isFullscreen"
          :panel-open="panelOpen"
          :trim="panelOpen.export ? trim : null"
          @toggle-play="togglePlay"
          @skip="onSkip"
          @step="onStep"
          @seek="onSeek"
          @scrubbing="onScrubbing"
          @volume="onVolume"
          @toggle-mute="onToggleMute"
          @toggle-fullscreen="toggleFullscreen"
          @stream="onStream"
          @rate="onRate"
          @reset-zoom="resetZoom"
          @toggle-panel="togglePanel"
          @trim="onTrim"
          @menu-open="onMenuOpen"
          @snapshot="saveSnapshot"
        />

        <!-- One element per snapshot, each running its own animation and each
             thrown away when it finishes. Sharing one would mean restarting an
             animation mid-flight, and a burst of snapshots would read as a
             single long flash rather than as one cue per still. -->
        <div class="snapcues" aria-hidden="true">
          <span v-for="id in snapCues" :key="id" class="snapcue">
            <span class="snapcue__badge"><AppIcon name="photoCamera" :size="40" /></span>
          </span>
        </div>
      </div>
    </div>

    <!-- Every open panel is rendered exactly once and teleported to wherever it
         currently lives: a dock stack, or the body of its own popup window. The
         component instance is the same either way, so moving a panel keeps its
         scroll position, its tab and any half-configured export. -->
    <template v-for="id in openIds" :key="id">
      <Teleport v-if="panelTarget(id)" :to="panelTarget(id)">
        <PanelFrame
          :title="panelTitle(id)"
          :icon="panelIcon(id)"
          :order="panelOrderIn(id)"
          :collapsed="collapsedMap[id]"
          :popped="!!popTargets[id]"
          :active="id === activePanel"
          @activate="activatePanel(id)"
          @toggle="toggleCollapsed(id)"
          @popout="togglePop(id)"
          @close="closePanel(id)"
          @flip="flipSide(id)"
          @drag-start="onPanelDragStart(id)"
          @drag-move="onPanelDragMove"
          @drag-end="onPanelDragEnd"
        >
          <SettingsPanel
            v-if="id === 'settings'"
            :settings="settings"
            :state="state"
            :snapshot-folder="snapshotFolderName"
            :has-snapshot-folder="snapshotFolderReady"
            @patch="patchSettings"
            @stream="onStream"
            @overlay="onOverlay"
            @rate="onRate"
          />
          <MetadataPanel
            v-else-if="id === 'metadata'"
            :state="state"
            :context="fileContext"
            :show="overlayShow"
            :metadata-at="metadataAt"
            @seek="(ms) => onSeek(ms, false)"
            @overlay="onOverlay"
          />
          <ExportPanel
            v-else
            :context="fileContext"
            :trim="trim"
            :current-time="state.currentTime"
            :duration="state.duration"
            @close="closePanel('export')"
            @trim="onTrim"
            @notice="showNotice"
          />
        </PanelFrame>
      </Teleport>
    </template>

    <FolderBrowser
      v-if="libraryOpen"
      :view="settings.libraryView"
      :sort="settings.librarySort"
      :current-name="state.fileName"
      @close="libraryOpen = false"
      @open="onLibraryOpen"
      @patch="patchSettings"
      @notice="showNotice"
      @folder="onFolderOpened"
    />

    <div v-if="dragDepth > 0" class="dragmask">
      <div class="dragmask__inner">Drop the .bvr file to open it</div>
    </div>

    <transition name="toast">
      <div v-if="notice" class="toast" role="status">
        <AppIcon name="info" :size="17" />
        <span>{{ notice }}</span>
        <button type="button" class="toast__close" aria-label="Dismiss" @click="notice = ''">
          <AppIcon name="close" :size="15" />
        </button>
      </div>
    </transition>

    <input
      ref="fileInput"
      class="hidden-input"
      type="file"
      accept=".bvr,application/octet-stream"
      @change="onFileInput"
    />
  </div>
</template>

<script>
import AppIcon from './components/AppIcon.vue'
import ControlBar from './components/ControlBar.vue'
import FolderBrowser from './components/FolderBrowser.vue'
import MetadataPanel from './components/MetadataPanel.vue'
import ExportPanel from './components/ExportPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import PanelFrame from './components/PanelFrame.vue'
import { BvrPlayer, createBlankState, PLAYBACK_RATES } from './player/BvrPlayer.js'
import { ViewController } from './player/ViewController.js'
import {
  canBrowseDirectories, canPickDirectory, directoryPermission, openEntry, writeFileTo
} from './library/directory.js'
import { loadDirectoryHandle } from './library/thumbCache.js'
import { downloadSnapshot, encodeSnapshot, snapshotName } from './player/snapshot.js'
import { loadSettings, saveSettings } from './util/settings.js'
import { formatBytes } from './util/format.js'
import { PANELS, panelDef } from './panels/panels.js'
import { solveDocks, maxExpanded, MIN_DOCK, MAX_DOCK } from './panels/layout.js'
import { openPanelWindow, closePanelWindow } from './panels/popout.js'

// How long the chrome lingers after the last pointer activity. Touch gets a
// longer grace period because there is no hover to bring it back - only a tap.
const UI_IDLE_MS = 2600
const UI_IDLE_TOUCH_MS = 4200

// A pointer resting anywhere inside these keeps the chrome up indefinitely.
const CHROME_SELECTOR = '.topbar, .controlbar, .dock'

const SIDES = ['left', 'right']

// Long enough for the cue's own animation to finish; the element is only kept
// alive to be animated, so it is dropped a beat afterwards.
const SNAP_CUE_MS = 700

const blankPanelMap = (value) => Object.fromEntries(PANELS.map((p) => [p.id, value]))

export default {
  name: 'App',
  components: {
    AppIcon, ControlBar, FolderBrowser, MetadataPanel, ExportPanel, SettingsPanel, PanelFrame
  },
  data () {
    const settings = loadSettings()
    return {
      SIDES,
      state: createBlankState(),
      settings,
      dragDepth: 0,
      notice: '',
      isFullscreen: false,
      uiVisible: true,
      menuOpen: false,
      scrubbing: false,
      pointerOverChrome: false,
      installPrompt: null,
      libraryOpen: false,
      mounted: false,

      // ------------------------------------------------------------- panels
      panelOpen: blankPanelMap(false),
      // Collapsed *by the viewer*. A panel can also be collapsed because the
      // dock ran out of height; see collapsedMap.
      panelCollapsed: blankPanelMap(false),
      // id -> the element inside its popup window, when it has one.
      popTargets: {},
      // Monotonic per panel: the most recently touched panels are the ones a
      // short dock keeps expanded.
      activatedAt: blankPanelMap(0),
      activePanel: '',
      activeSide: 'right',
      dockWidth: { left: settings.dockLeftWidth, right: settings.dockRightWidth },
      dragging: null,
      dropHint: { side: 'right', index: 0 },
      // Measured from the row the docks and the video share, not from the
      // window: that row is what they are actually dividing up, and it is also
      // the one that shrinks when the app goes fullscreen on a second monitor.
      viewportWidth: 0,
      dockHeight: 0,

      fileContext: null,
      trim: { start: 0, end: 0 },

      // ----------------------------------------------------------- snapshots
      // Ids of the cues currently on screen, one per still saved.
      snapCues: [],
      // The folder stills may be written into, once one has been opened. The
      // handle itself is not reactive (see snapshotDir); these two are what the
      // settings panel needs to describe it.
      snapshotFolderName: '',
      snapshotFolderReady: false,

      canBrowse: canBrowseDirectories(),
      webCodecsOk: typeof window !== 'undefined' && typeof window.VideoDecoder !== 'undefined'
    }
  },
  computed: {
    hasFile () {
      return this.state.status === 'ready' || this.state.status === 'loading' || this.state.status === 'error'
    },
    overlayShow () {
      return {
        shapes: this.settings.overlayShapes,
        text: this.settings.overlayText,
        graphics: this.settings.overlayGraphics
      }
    },

    /** Open panels in dock order, popped-out ones included. */
    openIds () {
      return this.settings.panelOrder.filter((id) => this.panelOpen[id])
    },
    counts () {
      return { left: this.dockIds('left').length, right: this.dockIds('right').length }
    },
    docks () {
      return solveDocks({
        viewportWidth: this.viewportWidth,
        counts: this.counts,
        widths: this.dockWidth,
        activeSide: this.activeSide
      })
    },
    /**
     * Whether each panel is actually shown collapsed.
     *
     * Two reasons it might be: the viewer collapsed it, or the dock is too short
     * to give every panel a usable body. In the second case the most recently
     * used panels are the ones that stay open, which is what makes clicking a
     * title bar feel like switching panels rather than fighting the layout.
     */
    collapsedMap () {
      const out = blankPanelMap(false)
      for (const side of SIDES) {
        const ids = this.dockIds(side)
        const limit = maxExpanded(this.dockHeight, ids.length)
        const wanted = ids.filter((id) => !this.panelCollapsed[id])
        const keep = new Set(
          wanted.slice().sort((a, b) => this.activatedAt[b] - this.activatedAt[a]).slice(0, limit)
        )
        for (const id of ids) out[id] = this.panelCollapsed[id] || !keep.has(id)
      }
      return out
    }
  },
  watch: {
    'state.ended' (ended) {
      if (ended && this.settings.loop) {
        this.player.seek(0)
        this.player.play()
      }
    },
    'state.codecWarning' (msg) {
      // The probe settles this before indexing finishes, so it lands early.
      if (msg) this.showNotice(msg)
    },
    'state.playing' () {
      // Pausing no longer pins the chrome open; it re-arms the same idle timer.
      this.wakeUi()
    },
    'state.status' (status) {
      this.wakeUi()
      if (status === 'ready') this.onFileReady()
      else if (status !== 'loading') this.closeFilePanels()
    },
    'settings.matchAspect' (on) {
      if (this.player) this.player.setMatchAspect(on)
    },
    // Docks change how much room the video has, so the canvas has to be
    // re-measured whenever one appears, moves or is resized. The computed hands
    // back a fresh object every time it re-runs, so no deep comparison is needed
    // to notice -- and `resize()` itself early-outs when nothing moved.
    docks () {
      this.$nextTick(() => this.player && this.player.onResize())
    }
  },
  created () {
    // Deliberately not reactive: these only ever feed decisions taken inside
    // event handlers, and nothing renders from them.
    this.hideTimer = null
    this.lastPointerWasTouch = false
    this.uiVisibleBeforePointer = true
    this.keyboardNav = false
    this.popWindows = {}
    this.activateSeq = 0
    this.resizeDrag = null
    // A directory handle is not data to render, and making one reactive would
    // hand Vue a proxy where the File System Access API expects the handle.
    this.snapshotDir = null
    this.snapCueSeq = 0
  },
  mounted () {
    this.player = new BvrPlayer({
      canvas: this.$refs.canvas,
      onState: (s) => { this.state = s },
      onError: (e) => console.error(e),
      onNotice: (msg) => this.showNotice(msg)
    })
    this.player.streamMode = this.settings.streamMode
    this.player.matchAspect = this.settings.matchAspect
    this.player.setVolume(this.settings.volume)
    if (this.settings.muted) this.player.toggleMute()
    this.player.setOverlay({
      enabled: this.settings.overlay,
      shapes: this.settings.overlayShapes,
      text: this.settings.overlayText,
      graphics: this.settings.overlayGraphics
    })

    // Zoom and pan touch nothing but the renderer's view transform, so they run
    // beside the player rather than through it.
    this.view = new ViewController({
      element: this.$refs.canvas,
      renderer: this.player.renderer,
      onChange: () => {
        this.player.notifyView()
        this.player.repaint()
      }
    })
    this.view.attach()

    this.ro = new ResizeObserver(() => this.player.onResize())
    this.ro.observe(this.$refs.stage)
    this.dockRo = new ResizeObserver((records) => {
      for (const r of records) this.measureBody(r.contentRect)
    })
    this.dockRo.observe(this.$refs.body)
    this.measureBody(this.$refs.body.getBoundingClientRect())
    this.player.onResize()

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('beforeunload', this.closeAllPopouts)
    document.addEventListener('fullscreenchange', this.onFullscreenChange)
    window.addEventListener('beforeinstallprompt', this.onInstallPrompt)
    // The dock stacks exist from here on, so a Teleport may safely look for one.
    this.mounted = true
    this.consumeLaunchFiles()
    this.restoreSnapshotFolder()
  },
  beforeUnmount () {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('beforeunload', this.closeAllPopouts)
    document.removeEventListener('fullscreenchange', this.onFullscreenChange)
    window.removeEventListener('beforeinstallprompt', this.onInstallPrompt)
    if (this.ro) this.ro.disconnect()
    if (this.dockRo) this.dockRo.disconnect()
    if (this.view) this.view.detach()
    this.clearHideTimer()
    this.closeAllPopouts()
    if (this.player) this.player.destroy()
  },
  methods: {
    formatBytes,

    // ------------------------------------------------------------ file input
    pickFile () {
      this.$refs.fileInput.click()
    },
    onFileInput (event) {
      const file = event.target.files && event.target.files[0]
      if (file) this.openFile(file)
      event.target.value = ''
    },
    async openFile (file) {
      this.notice = ''
      this.uiVisible = true
      // The panels stay open across files now that they sit beside the video
      // rather than over it -- reopening the inspector for every clip in a
      // folder was only ever a consequence of it having been an overlay. Their
      // context is dropped until the new index is built.
      this.fileContext = null
      await this.player.open(file)
      this.player.setVolume(this.settings.volume)
      if (this.settings.muted !== this.player.muted) this.player.toggleMute()
    },
    /** Fresh index, fresh trim range, and the context the panels read from. */
    onFileReady () {
      this.trim = { start: 0, end: this.state.duration }
      this.fileContext = this.player.exportContext()
      // A speed carried over from the last clip is more surprising than useful,
      // so each file starts at 1x however the last one was left.
      if (this.state.rate !== 1) this.player.setRate(1)
      if (this.settings.autoplay) this.player.play()
    },
    async onLibraryOpen (clip) {
      try {
        const file = await openEntry(clip)
        this.libraryOpen = false
        await this.openFile(file)
      } catch (e) {
        this.showNotice(`Could not open ${clip.name}: ${e.message}`)
      }
    },
    openLibrary () {
      this.libraryOpen = true
      this.wakeUi()
    },
    onDragEnter () { this.dragDepth++ },
    onDragOver (event) {
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave () { this.dragDepth = Math.max(0, this.dragDepth - 1) },
    onDrop (event) {
      this.dragDepth = 0
      const files = event.dataTransfer && event.dataTransfer.files
      if (files && files.length) this.openFile(files[0])
    },
    async consumeLaunchFiles () {
      // PWA file handler: opening a .bvr from the OS shell once installed.
      if (!('launchQueue' in window)) return
      try {
        window.launchQueue.setConsumer(async (params) => {
          if (!params || !params.files || !params.files.length) return
          const handle = params.files[0]
          const file = await handle.getFile()
          this.openFile(file)
        })
      } catch { /* unsupported launch parameters */ }
    },

    // ------------------------------------------------------------- transport
    togglePlay () {
      if (this.state.status !== 'ready') return
      this.player.togglePlay()
    },
    onSkip (seconds) { this.player.skip(seconds) },
    onStep (delta) { this.player.stepFrames(delta) },
    onSeek (ms, preview) { this.player.seek(ms, { preview: !!preview }) },
    onScrubbing (on) {
      this.scrubbing = on
      this.player.setScrubbing(on)
      this.wakeUi()
    },
    onVolume (v) {
      this.player.setVolume(v)
      this.patchSettings({ volume: v, muted: this.player.muted })
    },
    onToggleMute () {
      this.player.toggleMute()
      this.patchSettings({ muted: this.player.muted })
    },
    onStream (mode) {
      this.patchSettings({ streamMode: mode })
      this.player.setStreamMode(mode)
    },
    onRate (rate) {
      this.player.setRate(rate)
      this.patchSettings({ playbackRate: rate })
      this.wakeUi()
    },
    /** Steps through the offered speeds; used by the bracket keys. */
    stepRate (delta) {
      const at = PLAYBACK_RATES.indexOf(this.state.rate)
      const from = at >= 0 ? at : PLAYBACK_RATES.indexOf(1)
      const next = PLAYBACK_RATES[Math.min(PLAYBACK_RATES.length - 1, Math.max(0, from + delta))]
      if (next !== this.state.rate) this.onRate(next)
    },
    onStageClick (event) {
      if (event.target !== this.$refs.canvas) return
      if (!this.hasFile || this.state.status !== 'ready') return
      // A drag that panned the picture ends with a click here; it must not also
      // toggle playback.
      if (this.view && this.view.takeClickSuppression()) return
      // Touch has no hover, so a tap on a bare video surface is the only way to
      // bring the chrome back - it must not also toggle playback.
      if (this.lastPointerWasTouch && !this.uiVisibleBeforePointer) {
        this.wakeUi()
        return
      }
      this.togglePlay()
    },
    onStageDblClick (event) {
      // Only the video surface responds. Without this check, any fast double
      // click inside the stage - frame-step button, number spinner, chip -
      // bubbles up here.
      if (event.target !== this.$refs.canvas) return
      // Zoomed in, the natural meaning of a double click is "back out"; that
      // takes precedence over fullscreen, which the F key and the button still
      // reach.
      if (this.view && this.view.reset()) return
      this.toggleFullscreen()
    },
    resetZoom () {
      if (this.view) this.view.reset()
    },

    // ---------------------------------------------------------------- panels
    panelTitle (id) { return (panelDef(id) || {}).title || id },
    panelShort (id) { return (panelDef(id) || {}).short || id },
    panelIcon (id) { return (panelDef(id) || {}).icon || 'layers' },
    sideOf (id) { return this.settings.panelSides[id] === 'left' ? 'left' : 'right' },

    /** Open, docked (not popped out) panels on one side, in dock order. */
    dockIds (side) {
      return this.openIds.filter((id) => !this.popTargets[id] && this.sideOf(id) === side)
    },
    panelOrderIn (id) {
      return Math.max(0, this.dockIds(this.sideOf(id)).indexOf(id))
    },
    /**
     * Where a panel's DOM belongs right now.
     *
     * A popped-out panel goes to its window; a docked one to its side's stack,
     * which stays in the document even while that dock is a rail, so switching
     * back costs nothing and the panel keeps its state.
     */
    panelTarget (id) {
      if (!this.mounted) return null
      if (this.popTargets[id]) return this.popTargets[id]
      return `#dock-stack-${this.sideOf(id)}`
    },
    dockStyle (side) {
      const d = this.docks[side]
      if (d.mode === 'hidden') return { display: 'none' }
      return { width: `${d.width}px` }
    },

    togglePanel (id) {
      if (this.panelOpen[id]) this.closePanel(id)
      else this.openPanel(id)
    },
    openPanel (id) {
      const def = panelDef(id)
      if (!def) return
      if (def.needsFile && this.state.status !== 'ready') return
      if (def.needsFile && !this.fileContext) this.fileContext = this.player.exportContext()
      if (id === 'export' && this.trim.end <= this.trim.start) {
        this.trim = { start: 0, end: this.state.duration }
      }
      this.panelOpen = { ...this.panelOpen, [id]: true }
      this.panelCollapsed = { ...this.panelCollapsed, [id]: false }
      this.activatePanel(id)
      this.wakeUi()
    },
    closePanel (id) {
      if (this.popTargets[id]) this.dockPanel(id)
      this.panelOpen = { ...this.panelOpen, [id]: false }
      if (this.activePanel === id) this.activePanel = ''
      this.wakeUi()
    },
    /** Panels that describe the loaded recording; the settings panel survives. */
    closeFilePanels () {
      for (const p of PANELS) {
        if (p.needsFile && this.panelOpen[p.id]) this.closePanel(p.id)
      }
      this.fileContext = null
    },
    /**
     * Marks a panel as the one being worked in.
     *
     * Called from a capturing pointerdown on the whole panel, so it runs on
     * every click inside one -- the early return is what keeps that from
     * re-rendering the dock on each of them.
     */
    activatePanel (id) {
      const popped = !!this.popTargets[id]
      if (this.activePanel === id && (popped || this.activeSide === this.sideOf(id))) return
      this.activatedAt = { ...this.activatedAt, [id]: ++this.activateSeq }
      this.activePanel = id
      if (!popped) this.activeSide = this.sideOf(id)
    },
    toggleCollapsed (id) {
      const now = this.collapsedMap[id]
      this.panelCollapsed = { ...this.panelCollapsed, [id]: !now }
      // Expanding is also a request to be one of the panels that stays open.
      if (now) this.activatePanel(id)
    },
    /** A rail button: bring that side forward and show the panel behind it. */
    focusPanel (id) {
      this.panelCollapsed = { ...this.panelCollapsed, [id]: false }
      this.activatePanel(id)
      this.activeSide = this.sideOf(id)
    },
    flipSide (id) {
      const to = this.sideOf(id) === 'left' ? 'right' : 'left'
      this.movePanel(id, to, this.dockIds(to).length)
    },
    /**
     * Moves a panel to `side`, landing at `index` among the panels already
     * there.
     *
     * One flat order is kept across both docks and each dock reads its own
     * subsequence, so inserting before whoever currently holds that index puts
     * the panel in the right place on the target side without disturbing the
     * other one.
     */
    movePanel (id, side, index) {
      const sides = { ...this.settings.panelSides, [id]: side }
      const rest = this.settings.panelOrder.filter((x) => x !== id)
      const onSide = rest.filter((x) =>
        sides[x] === side && this.panelOpen[x] && !this.popTargets[x])
      const before = onSide[index]
      let order
      if (before === undefined) {
        order = [...rest, id]
      } else {
        const at = rest.indexOf(before)
        order = [...rest.slice(0, at), id, ...rest.slice(at)]
      }
      this.patchSettings({ panelSides: sides, panelOrder: order })
      this.activeSide = side
      this.activatePanel(id)
    },

    // ------------------------------------------------------- panel dragging
    onPanelDragStart (id) {
      this.dragging = id
      this.dropHint = { side: this.sideOf(id), index: this.panelOrderIn(id) }
    },
    onPanelDragMove (at) {
      if (!this.dragging) return
      this.dropHint = this.dropTargetAt(at.x, at.y)
    },
    onPanelDragEnd (at) {
      const id = this.dragging
      this.dragging = null
      if (!id) return
      const target = at ? this.dropTargetAt(at.x, at.y) : this.dropHint
      this.movePanel(id, target.side, target.index)
    },
    /**
     * Which dock, and how far down it, a pointer position means.
     *
     * The insertion point is read from where the panels actually are on screen
     * rather than from the model, because CSS `order` decides that and only the
     * layout knows the answer.
     */
    dropTargetAt (x, y) {
      const row = this.$refs.body ? this.$refs.body.getBoundingClientRect() : { left: 0, width: this.viewportWidth }
      const side = x < row.left + row.width / 2 ? 'left' : 'right'
      let index = 0
      const stack = document.getElementById(`dock-stack-${side}`)
      if (stack && this.docks[side].mode === 'open') {
        const tops = Array.from(stack.children)
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.height > 0)
          .sort((a, b) => a.top - b.top)
        index = tops.filter((r) => y > r.top + r.height / 2).length
      }
      return { side, index }
    },

    // -------------------------------------------------------- dock resizing
    startResize (side, event) {
      if (event.button !== undefined && event.button !== 0) return
      event.preventDefault()
      const el = event.currentTarget
      this.resizeDrag = {
        side,
        id: event.pointerId,
        el,
        startX: event.clientX,
        startWidth: this.docks[side].width
      }
      el.setPointerCapture(event.pointerId)
      el.addEventListener('pointermove', this.onResizeMove)
      el.addEventListener('pointerup', this.onResizeEnd)
      el.addEventListener('pointercancel', this.onResizeEnd)
    },
    onResizeMove (event) {
      const d = this.resizeDrag
      if (!d || event.pointerId !== d.id) return
      // The handle is on the inner edge, so a left dock grows as the pointer
      // moves right and a right dock grows as it moves left.
      const delta = (event.clientX - d.startX) * (d.side === 'left' ? 1 : -1)
      const width = Math.min(MAX_DOCK, Math.max(MIN_DOCK, Math.round(d.startWidth + delta)))
      this.dockWidth = { ...this.dockWidth, [d.side]: width }
      this.activeSide = d.side
    },
    onResizeEnd (event) {
      const d = this.resizeDrag
      if (!d || event.pointerId !== d.id) return
      this.resizeDrag = null
      d.el.removeEventListener('pointermove', this.onResizeMove)
      d.el.removeEventListener('pointerup', this.onResizeEnd)
      d.el.removeEventListener('pointercancel', this.onResizeEnd)
      if (d.el.hasPointerCapture && d.el.hasPointerCapture(d.id)) {
        try { d.el.releasePointerCapture(d.id) } catch { /* pointer already gone */ }
      }
      // Written once, at the end, rather than on every pointer move.
      this.patchSettings({
        dockLeftWidth: this.dockWidth.left,
        dockRightWidth: this.dockWidth.right
      })
    },
    measureBody (rect) {
      this.viewportWidth = Math.round(rect.width)
      this.dockHeight = Math.round(rect.height)
    },

    // ------------------------------------------------------------- pop-outs
    togglePop (id) {
      if (this.popTargets[id]) this.dockPanel(id)
      else this.popOut(id)
    },
    popOut (id) {
      const def = panelDef(id)
      const handle = openPanelWindow({
        id,
        title: `${def.title} — BVR Player`,
        width: Math.max(360, Math.round(this.dockWidth[this.sideOf(id)]) + 24),
        height: Math.min(900, Math.max(420, Math.round(window.innerHeight * 0.8))),
        onClose: () => this.onPopClosed(id)
      })
      if (!handle) {
        this.showNotice('The browser blocked the pop-out window. Allow pop-ups for this page to use it.')
        return
      }
      this.popWindows[id] = handle
      this.popTargets = { ...this.popTargets, [id]: handle.mount }
      this.activatePanel(id)
    },
    /**
     * The popup was closed from its own title bar.
     *
     * Deferred by a turn: this runs while that document is being torn down, and
     * Vue has to move the panel's nodes back into the dock afterwards rather
     * than into a document mid-unload.
     */
    onPopClosed (id) {
      if (!this.popTargets[id]) return
      setTimeout(() => this.dockPanel(id), 0)
    },
    dockPanel (id) {
      if (!this.popTargets[id]) return
      const handle = this.popWindows[id]
      delete this.popWindows[id]
      const next = { ...this.popTargets }
      delete next[id]
      this.popTargets = next
      this.activatePanel(id)
      closePanelWindow(handle)
    },
    closeAllPopouts () {
      for (const id of Object.keys(this.popWindows)) closePanelWindow(this.popWindows[id])
      this.popWindows = {}
      if (Object.keys(this.popTargets).length) this.popTargets = {}
    },

    // ------------------------------------------------------------ snapshots
    /**
     * Saves the frame on screen as an image file.
     *
     * The picture is taken synchronously, before anything is awaited: whatever
     * follows -- a permission prompt, the encoder, the write -- happens to a
     * copy of the frame that was on screen at the moment of the click, which is
     * the frame the viewer meant. Nothing here serialises, so a rapid burst
     * produces one still per press rather than one per encode.
     */
    async saveSnapshot () {
      if (this.state.status !== 'ready') return
      const canvas = this.player.snapshotCanvas()
      if (!canvas) {
        this.showNotice('There is no frame on screen to save yet.')
        return
      }
      const context = this.player.snapshotContext()
      this.flashSnapshot()
      try {
        // Resolved before encoding so that a permission prompt still has the
        // user activation from the click that asked for the snapshot.
        const dir = await this.snapshotDirectory()
        const encoded = await encodeSnapshot(canvas, {
          format: this.settings.snapshotFormat,
          quality: this.settings.snapshotQuality
        })
        if (!encoded) throw new Error('the image could not be encoded')
        const name = snapshotName(context, encoded.ext)
        if (dir) await writeFileTo(dir, name, encoded.blob)
        else downloadSnapshot(encoded.blob, name)
      } catch (e) {
        const why = e && e.message ? e.message : String(e)
        this.showNotice(`The snapshot could not be saved: ${why}`)
      }
    },
    /** A cue per still, each with a life of its own. */
    flashSnapshot () {
      const id = ++this.snapCueSeq
      this.snapCues = [...this.snapCues, id]
      setTimeout(() => {
        this.snapCues = this.snapCues.filter((x) => x !== id)
      }, SNAP_CUE_MS)
    },
    /**
     * The folder a still should be written into, or null to download it.
     *
     * Browsing a folder only asks for read access, so the first snapshot written
     * into one has to ask for write access as well. A refusal is not a failure:
     * the still still gets saved, by the route that needs no permission at all.
     */
    async snapshotDirectory () {
      if (!this.settings.snapshotToFolder || !canPickDirectory()) return null
      const handle = this.snapshotDir || await loadDirectoryHandle()
      if (!handle) return null
      const granted = await directoryPermission(handle, true, 'readwrite')
      if (granted !== 'granted') {
        this.showNotice(`Write access to ${handle.name} was declined, so the snapshot was downloaded instead.`)
        return null
      }
      this.setSnapshotFolder(handle)
      return handle
    },
    /** Names the last-browsed folder in the settings panel, without prompting. */
    async restoreSnapshotFolder () {
      if (!canPickDirectory()) return
      const handle = await loadDirectoryHandle()
      if (!handle || this.snapshotDir) return
      this.setSnapshotFolder(handle)
    },
    onFolderOpened (handle) {
      this.setSnapshotFolder(handle)
    },
    /**
     * A directory handle is not required to have a name -- the origin-private
     * file system's root has none -- so whether there is a folder and what to
     * call it are two separate facts.
     */
    setSnapshotFolder (handle) {
      this.snapshotDir = handle || null
      this.snapshotFolderReady = !!handle
      this.snapshotFolderName = (handle && handle.name) || (handle ? 'the open folder' : '')
    },

    // ----------------------------------------------------------------- misc
    metadataAt (ms) {
      return this.player ? this.player.metadataAt(ms) : Promise.resolve(null)
    },
    onOverlay (patch) {
      this.player.setOverlay(patch)
      const map = {
        enabled: 'overlay',
        shapes: 'overlayShapes',
        text: 'overlayText',
        graphics: 'overlayGraphics'
      }
      const out = {}
      for (const [from, to] of Object.entries(map)) {
        if (patch[from] !== undefined) out[to] = patch[from]
      }
      if (Object.keys(out).length) this.patchSettings(out)
    },
    onTrim (range) {
      this.trim = {
        start: Math.max(0, Math.min(range.start, this.state.duration)),
        end: Math.max(0, Math.min(range.end, this.state.duration))
      }
    },

    // -------------------------------------------------------------- settings
    patchSettings (patch) {
      this.settings = { ...this.settings, ...patch }
      saveSettings(this.settings)
    },
    showNotice (msg) {
      this.notice = msg
      if (this.noticeTimer) clearTimeout(this.noticeTimer)
      this.noticeTimer = setTimeout(() => { this.notice = '' }, 6000)
    },

    // ------------------------------------------------------------ fullscreen
    async toggleFullscreen () {
      try {
        if (document.fullscreenElement) await document.exitFullscreen()
        else await this.$refs.root.requestFullscreen({ navigationUI: 'hide' })
      } catch (e) {
        this.showNotice('Fullscreen was refused by the browser.')
      }
    },
    onFullscreenChange () {
      this.isFullscreen = !!document.fullscreenElement
      this.wakeUi()
      // The stage changes size, which changes how far the picture may be panned.
      this.$nextTick(() => this.player.onResize())
    },

    // ------------------------------------------------------------- chrome/UI
    onPointerMove (event) { this.wakeUi(event) },
    onPointerDown (event) {
      this.lastPointerWasTouch = event.pointerType === 'touch'
      this.uiVisibleBeforePointer = this.uiVisible
      this.keyboardNav = false
      this.wakeUi(event)
    },
    onPointerLeave (event) {
      // The pointer left the window: nothing can be near the controls any more,
      // so drop the chrome at once rather than waiting out the idle timer.
      if (event.pointerType === 'touch') return
      this.pointerOverChrome = false
      if (!this.canHideUi()) return
      this.clearHideTimer()
      this.uiVisible = false
    },
    wakeUi (event) {
      // Hovering the bars themselves pins them open - a motionless pointer over
      // the controls still counts as "near" them.
      if (event && event.target && event.target.closest) {
        this.pointerOverChrome = !!event.target.closest(CHROME_SELECTOR)
      }
      this.uiVisible = true
      this.scheduleHide()
    },
    canHideUi () {
      if (!this.hasFile || this.state.status !== 'ready') return false
      if (this.menuOpen || this.scrubbing || this.pointerOverChrome) return false
      if (this.libraryOpen || this.dragging || this.resizeDrag) return false
      return !this.chromeHasKeyboardFocus()
    },
    /**
     * Hiding a control that someone tabbed to would strand them, so keyboard
     * focus inside the chrome pins it open.
     *
     * Plain :focus is the wrong test - a click leaves the button focused, which
     * would pin the chrome open after every click - and :focus-visible is a
     * browser heuristic rather than a promise. Tracking the last input device
     * ourselves is the only version that behaves the same everywhere.
     */
    chromeHasKeyboardFocus () {
      if (!this.keyboardNav) return false
      const el = document.activeElement
      if (!el || el === document.body || !el.closest) return false
      return !!el.closest(CHROME_SELECTOR)
    },
    clearHideTimer () {
      if (this.hideTimer) clearTimeout(this.hideTimer)
      this.hideTimer = null
    },
    scheduleHide () {
      this.clearHideTimer()
      if (!this.canHideUi()) return
      const delay = this.lastPointerWasTouch ? UI_IDLE_TOUCH_MS : UI_IDLE_MS
      this.hideTimer = setTimeout(() => {
        this.hideTimer = null
        if (this.canHideUi()) this.uiVisible = false
      }, delay)
    },
    onMenuOpen (open) {
      this.menuOpen = open
      this.wakeUi()
    },
    onInstallPrompt (event) {
      event.preventDefault()
      this.installPrompt = event
    },
    async install () {
      const prompt = this.installPrompt
      this.installPrompt = null
      if (prompt) await prompt.prompt()
    },

    // -------------------------------------------------------------- keyboard
    onKeyDown (event) {
      // Any key counts as keyboard navigation, Tab included - that is the one
      // that parks focus on a control the chrome must then keep on screen.
      this.keyboardNav = true

      const el = event.target
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      // A clicked button keeps focus, and the browser activates it on Space or
      // Enter. Handling those here too would fire the action twice - which reads
      // as the control doing nothing at all.
      if (el && el.tagName === 'BUTTON' && (event.key === ' ' || event.key === 'Enter')) return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      // The folder browser covers the whole window; only its own Escape applies.
      if (this.libraryOpen) {
        if (event.key === 'Escape') { this.libraryOpen = false; event.preventDefault() }
        return
      }

      const skip = this.settings.skipSeconds
      let handled = true
      switch (event.key) {
        case ' ':
        case 'k':
        case 'K':
          this.togglePlay(); break
        case 'ArrowLeft':
          if (event.shiftKey) this.onStep(-1); else this.onSkip(-skip); break
        case 'ArrowRight':
          if (event.shiftKey) this.onStep(1); else this.onSkip(skip); break
        case ',':
        case '<':
          this.onStep(-1); break
        case '.':
        case '>':
          this.onStep(1); break
        case 'ArrowUp':
          this.onVolume(Math.min(1, this.state.volume + 0.05)); break
        case 'ArrowDown':
          this.onVolume(Math.max(0, this.state.volume - 0.05)); break
        case 'm':
        case 'M':
          this.onToggleMute(); break
        case 'f':
        case 'F':
          this.toggleFullscreen(); break
        case 'Home':
          this.onSeek(0, false); break
        case 'End':
          this.onSeek(this.state.duration, false); break
        case 'o':
        case 'O':
          this.pickFile(); break
        case 'l':
        case 'L':
          if (this.canBrowse) this.openLibrary(); else handled = false
          break
        case 'i':
        case 'I':
          if (this.state.hasMetadata) this.togglePanel('metadata'); else handled = false
          break
        case 'e':
        case 'E':
          this.togglePanel('export'); break
        case 's':
        case 'S':
          // Auto-repeat would write a file every frame the key is held.
          if (!event.repeat) this.saveSnapshot()
          break
        case '[':
          this.stepRate(-1); break
        case ']':
          this.stepRate(1); break
        case 'z':
        case 'Z':
          this.resetZoom(); break
        case '+':
        case '=':
          if (this.view) this.view.nudge(1.4); break
        case '-':
        case '_':
          if (this.view) this.view.nudge(1 / 1.4); break
        case 'Escape':
          // The panel most recently worked in is the one Escape means.
          if (this.activePanel && this.panelOpen[this.activePanel]) this.closePanel(this.activePanel)
          else if (this.openIds.length) this.closePanel(this.openIds[this.openIds.length - 1])
          else handled = false
          break
        default:
          if (/^[0-9]$/.test(event.key) && this.state.duration > 0) {
            this.onSeek((Number(event.key) / 10) * this.state.duration, false)
          } else {
            handled = false
          }
      }
      if (handled) {
        event.preventDefault()
        this.wakeUi()
      }
    }
  }
}
</script>
