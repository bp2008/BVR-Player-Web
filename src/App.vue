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
              Drop a Blue Iris <code>.bvr</code> recording or an <code>.mp4</code> here,
              or choose one to open. Files are decoded locally in your browser and
              never uploaded.
            </p>
            <!-- The URL named a recording, and the browser wants a click before
                 it will hand the folder back. See resumeFromUrl. -->
            <div v-if="resumePrompt" class="dropzone__resume">
              <button type="button" class="btn btn--accent" @click.stop="acceptResume">
                <AppIcon name="play" :size="18" />
                <span class="dropzone__resumename">Resume {{ resumePrompt.name }}</span>
              </button>
              <p class="dropzone__resumetext">
                This page was last showing that recording. Reopening it needs
                permission for <strong>{{ resumePrompt.dir }}</strong> again.
              </p>
            </div>
            <div class="dropzone__buttons">
              <button type="button" class="btn btn--accent" @click.stop="pickFile">
                <AppIcon name="folder" :size="18" />
                <span>Open a recording</span>
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
            <!-- A file the player refuses is the file somebody most needs
                 described. Reading it again costs a scan, hence the progress. -->
            <div class="overlay__buttons">
              <ExportMetadataMenu
                v-if="lastFile"
                :busy="analyzing"
                :busy-label="analyzeLabel"
                :name="state.fileName"
                @choose="exportMetadata"
              />
              <button type="button" class="btn" :title="backTitle" @click.stop="goBack">
                <AppIcon name="chevronLeft" :size="16" />
                <span>Back</span>
              </button>
            </div>
          </div>
        </div>

        <button
          v-if="showBigPlay"
          type="button"
          class="bigplay"
          aria-label="Play"
          @click.stop="togglePlay"
          @wheel="onChromeWheel"
        >
          <AppIcon name="play" :size="42" />
        </button>

        <header class="topbar" @wheel="onChromeWheel">
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
          @seek-to="openSeekDialog"
          @wheel="onChromeWheel"
        />

        <SeekDialog
          v-if="seekOpen"
          :current-time="state.currentTime"
          :duration="state.duration"
          :start-utc="state.startUtc"
          :pstream="playbackStream"
          :initial-mode="settings.timeDisplay"
          @seek="onSeekDialog"
          @close="seekOpen = false"
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
            :pstream="playbackStream"
            :show="overlayShow"
            :metadata-at="metadataAt"
            :analyzing="analyzing"
            :analyze-label="analyzeLabel"
            @seek="(ms) => onSeek(ms, false)"
            @overlay="onOverlay"
            @analyze="exportMetadata"
          />
          <ExportPanel
            v-else
            :context="fileContext"
            :trim="trim"
            :current-time="state.currentTime"
            :duration="state.duration"
            @close="closePanel('export')"
            @trim="onTrim"
            @seek="onExportSeek"
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
      <div class="dragmask__inner">Drop the recording to open it</div>
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
      accept=".bvr,.mp4,.m4v,.mov,video/mp4,video/quicktime,application/octet-stream"
      @change="onFileInput"
    />
  </div>
</template>

<script>
import AppIcon from './components/AppIcon.vue'
import ControlBar from './components/ControlBar.vue'
import FolderBrowser from './components/FolderBrowser.vue'
import MetadataPanel from './components/MetadataPanel.vue'
import ExportMetadataMenu from './components/ExportMetadataMenu.vue'
import ExportPanel from './components/ExportPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import PanelFrame from './components/PanelFrame.vue'
import SeekDialog from './components/SeekDialog.vue'
import { BvrPlayer, createBlankState, PLAYBACK_RATES } from './player/BvrPlayer.js'
import { ViewController } from './player/ViewController.js'
import { adjacentMainStart, mainStartPoints } from './player/coverage.js'
import {
  canBrowseDirectories, canPickDirectory, directoryPermission, openEntry, openFileNamed,
  writeFileTo
} from './library/directory.js'
import { loadDirectoryHandle } from './library/thumbCache.js'
import { downloadSnapshot, encodeSnapshot, snapshotName } from './player/snapshot.js'
import { analyzeRecording } from './container/analyze.js'
import { downloadBlob } from './util/download.js'
import { loadSettings, saveSettings } from './util/settings.js'
import { readSessionUrl, sessionHash, writeSessionHash } from './util/sessionUrl.js'
import { formatBytes } from './util/format.js'
import { acceptsTypedText, isSpaceKey } from './util/keys.js'
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

// How often the playhead is allowed to reach the address bar. Everything else
// -- a panel opening, a pause, a file -- is written the moment it happens; the
// position alone waits, because it moves sixty times a second and nobody is
// reading it at that rate. Two seconds is what a reload loses at worst.
const URL_SYNC_MS = 2000

// Long enough for the cue's own animation to finish; the element is only kept
// alive to be animated, so it is dropped a beat afterwards.
const SNAP_CUE_MS = 700

// Which key, held with Ctrl, jumps which way between main-stream starts. Both
// pairs are here because neither is obvious on its own: the punctuation sits
// beside the frame-step keys it borrows, and the arrows are what a hand already
// on them reaches for.
const MAIN_JUMP_KEYS = {
  ',': -1, '<': -1, ArrowLeft: -1,
  '.': 1, '>': 1, ArrowRight: 1
}

const blankPanelMap = (value) => Object.fromEntries(PANELS.map((p) => [p.id, value]))

export default {
  name: 'App',
  components: {
    AppIcon, ControlBar, FolderBrowser, MetadataPanel, ExportPanel, SettingsPanel, PanelFrame,
    ExportMetadataMenu, SeekDialog
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
      // Set when the URL names a recording the browser will only hand back
      // after a click: `{ name, dir }`, and the dropzone's Resume button.
      resumePrompt: null,
      // The "seek to a time" dialog. Not a panel: see SeekDialog.vue.
      seekOpen: false,
      // Whether there is a folder to go back to. Escape returns to the browser
      // wherever there is one, which means remembering that a folder was opened
      // even by the `webkitdirectory` route, where there is no handle to keep.
      folderKnown: false,
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
      // The file last handed to the player, kept because "Export metadata" has
      // to work after a failed open, when the player is holding nothing.
      lastFile: null,
      // Where the current file was opened from, so Back knows what "back" is:
      // the folder browser it was picked out of, or the start screen.
      fileOrigin: '',
      analyzing: false,
      analyzeProgress: 0,
      // The sequence the player is showing, kept apart from `fileContext`
      // because the two change at different moments: the context describes the
      // recording and lasts as long as it is open, while this is rebuilt every
      // time the stream selection changes.
      playbackStream: null,
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
    /** Progress only means something on the path that re-reads the file. */
    analyzeLabel () {
      return this.analyzeProgress > 0 && this.analyzeProgress < 1
        ? `Reading... ${(this.analyzeProgress * 100).toFixed(0)}%`
        : 'Reading the file...'
    },
    /** Where Back lands, said plainly enough to be a tooltip. */
    backTitle () {
      return this.backToLibrary
        ? 'Back to the folder this clip was picked from'
        : 'Back to the start screen'
    },
    backToLibrary () {
      return this.fileOrigin === 'library' && this.canBrowse
    },
    hasFile () {
      return this.state.status === 'ready' || this.state.status === 'loading' || this.state.status === 'error'
    },
    /**
     * Whether the big play button over the middle of the picture is drawn.
     *
     * It is only ever shown on a paused, ready recording, and it is optional on
     * top of that: it sits over the part of the frame most likely to hold the
     * thing being looked at, and for anyone reviewing stills that is a badge in
     * the way rather than an invitation. On by default all the same -- a paused
     * video with no play button on it is the surprising one.
     */
    showBigPlay () {
      if (!this.settings.bigPlayButton) return false
      if (this.seekOpen) return false
      return this.hasFile && !this.state.playing && this.state.status === 'ready' && !this.state.buffering
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
      this.syncUrl()
    },
    // The playhead, thirty to sixty times a second while playing and once per
    // seek while paused. syncUrl is what decides that most of those are not
    // worth an address bar rewrite; the point of watching it at all is that
    // there is then only one place the URL is built from.
    'state.currentTime' () {
      this.syncUrl()
    },
    'state.status' (status) {
      this.wakeUi()
      // Nothing to seek within any more, and the bounds it was offering belong
      // to a recording that is no longer open.
      if (status !== 'ready') this.seekOpen = false
      if (status === 'ready') this.onFileReady()
      else if (status !== 'loading') this.closeFilePanels()
      // A recording that was found and then refused is as resumed as it is ever
      // going to be; there is nothing left to put back. The URL keeps naming it
      // all the same, so a reload shows the same refusal rather than silently
      // forgetting which file it was about.
      if (status === 'error') {
        this.resumeState = null
        this.resumeTarget = null
      }
      this.syncUrl()
    },
    // Which panels are open, and in what order down each dock.
    openIds () {
      this.syncUrl()
    },
    // Collapsed *by the viewer*: the other kind is a consequence of how tall
    // the dock happens to be, and reproduces itself on its own.
    panelCollapsed () {
      this.syncUrl()
    },
    'settings.panelSides' () {
      this.syncUrl()
    },
    // Switching stream builds a whole new frame table -- an hour of continuous
    // sub stream counts seventy thousand frames where the triggered main stream
    // counts six -- so the panel that reports on the frame at the playhead has
    // to be handed the table the published frame index counts in. Left on the
    // one the file was opened with, it described a frame from the other stream,
    // or, past its end, no frame at all.
    'state.streamMode' () {
      if (this.fileContext) this.playbackStream = this.player.pstream
    },
    // Turning it on has to put the chrome back immediately -- the timer that
    // hid it has already run -- and turning it off should start the fade again
    // rather than wait for the next pointer move.
    'settings.alwaysShowControls' () {
      this.wakeUi()
    },
    'settings.matchAspect' (on) {
      if (this.player) this.player.setMatchAspect(on)
    },
    'settings.scrubExact' (on) {
      if (this.player) this.player.scrubExact = on
    },
    'settings.pauseWhileSeeking' (on) {
      if (this.player) this.player.pauseWhileSeeking = on
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

    // ---------------------------------------------------------- the URL
    // Nothing is written until the fragment the page was loaded with has been
    // read: the first thing every one of these watchers does is fire, and a
    // URL rewritten from a blank app before it has been restored is the state
    // it was meant to restore, gone.
    this.urlReady = false
    // The last fragment written, and the same thing without the playhead in it.
    // Comparing the first says whether anything changed at all; comparing the
    // second says whether what changed was worth writing immediately.
    this.urlHash = null
    this.urlStable = null
    this.urlWrittenAt = 0
    this.urlTrailing = null
    // Where the open recording lives, when it lives somewhere a reload could
    // find it again: `{ dir, name }`, or null for a file that was dropped,
    // chosen from the file picker or handed over by the OS -- none of which
    // leaves the page anything to reopen.
    this.fileRef = null
    // What the URL asked for, from the moment it is read until the recording it
    // names is open (or the attempt is given up on).
    this.resumeTarget = null
    // `{ time, playing, panels }` for the file currently being opened, consumed
    // once its index is built. See onFileReady.
    this.resumeState = null
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
    this.player.scrubExact = this.settings.scrubExact
    this.player.pauseWhileSeeking = this.settings.pauseWhileSeeking
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

    window.addEventListener('keydown', this.onSpaceKey, true)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('beforeunload', this.closeAllPopouts)
    document.addEventListener('fullscreenchange', this.onFullscreenChange)
    window.addEventListener('beforeinstallprompt', this.onInstallPrompt)
    // The dock stacks exist from here on, so a Teleport may safely look for one.
    this.mounted = true
    this.consumeLaunchFiles()
    this.restoreSnapshotFolder()
    this.restoreFromUrl()
  },
  beforeUnmount () {
    window.removeEventListener('keydown', this.onSpaceKey, true)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('beforeunload', this.closeAllPopouts)
    document.removeEventListener('fullscreenchange', this.onFullscreenChange)
    window.removeEventListener('beforeinstallprompt', this.onInstallPrompt)
    if (this.ro) this.ro.disconnect()
    if (this.dockRo) this.dockRo.disconnect()
    if (this.view) this.view.detach()
    this.clearHideTimer()
    if (this.urlTrailing) clearTimeout(this.urlTrailing)
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
    /**
     * `ref` says where this file can be found again -- `{ dir, name }` for one
     * picked out of a folder the browser will still have a handle for after a
     * reload, and null for anything dropped, chosen from the file picker or
     * handed over by the OS, none of which survives the page. `resume` is the
     * state a reload is putting back; see onFileReady.
     */
    async openFile (file, origin = 'dropzone', { ref = null, resume = null } = {}) {
      this.notice = ''
      this.uiVisible = true
      // The panels stay open across files now that they sit beside the video
      // rather than over it -- reopening the inspector for every clip in a
      // folder was only ever a consequence of it having been an overlay. Their
      // context is dropped until the new index is built.
      this.fileContext = null
      this.playbackStream = null
      this.lastFile = file
      this.fileOrigin = origin
      this.fileRef = ref
      this.resumeState = resume
      // Opening a file by hand supersedes whatever the URL was still hoping to
      // reopen. A resume opening its own file does not: it stays the page's
      // description of itself until the recording is actually back where it
      // was, which on a large one is several seconds of indexing.
      if (!resume) this.cancelResume()
      else this.syncUrl()
      await this.player.open(file)
      this.player.setVolume(this.settings.volume)
      if (this.settings.muted !== this.player.muted) this.player.toggleMute()
    },
    /**
     * Leaves the recording for wherever it was opened from.
     *
     * Two places, and the app already knew both: a clip picked out of the folder
     * browser goes back to the folder, and anything dropped or opened by hand
     * goes back to the start screen. Escape does the same thing from a playing
     * file (see the key handler); this is that gesture given a button, because
     * "Choose another file" was the only way out of a refusal and it threw away
     * the folder the viewer was working through.
     */
    goBack () {
      const toLibrary = this.backToLibrary
      this.player.close()
      this.lastFile = null
      this.fileRef = null
      this.fileOrigin = ''
      this.notice = ''
      if (toLibrary) this.openLibrary()
    },
    /**
     * Hands the panels the recording and the sequence being played.
     *
     * Both at once, because a panel opened between the two would read one of
     * them from the previous file.
     */
    adoptFileContext () {
      this.fileContext = this.player.exportContext()
      this.playbackStream = this.player.pstream
    },
    /** Fresh index, fresh trim range, and the context the panels read from. */
    onFileReady () {
      this.trim = { start: 0, end: this.state.duration }
      this.adoptFileContext()
      // A speed carried over from the last clip is more surprising than useful,
      // so each file starts at 1x however the last one was left.
      if (this.state.rate !== 1) this.player.setRate(1)

      // The first moment a resumed recording can be put back the way it was:
      // the panels that describe it have something to describe, and the
      // playhead has a duration to sit within. What the URL says beats the
      // autoplay setting -- it is a record of how this page was left, not a
      // preference about how a freshly opened one should start.
      const resume = this.resumeState
      this.resumeState = null
      this.resumeTarget = null
      if (resume) {
        this.openUrlPanels(resume.panels, resume.collapsed)
        if (resume.time > 0) this.onSeek(Math.min(resume.time, this.state.duration), false)
        if (resume.playing) this.player.play()
      } else if (this.settings.autoplay) {
        this.player.play()
      }
    },
    async onLibraryOpen (clip) {
      try {
        const file = await openEntry(clip)
        this.folderKnown = true
        this.libraryOpen = false
        // Only a clip that came from a directory handle can be found again from
        // a URL; one out of a `webkitdirectory` listing has no way back.
        await this.openFile(file, 'library', {
          ref: clip.dir ? { dir: clip.dir.name, name: clip.name } : null
        })
      } catch (e) {
        this.showNotice(`Could not open ${clip.name}: ${e.message}`)
      }
    },
    openLibrary () {
      // The browser covers the whole window, so playback would run on unseen -
      // and unpausable, with Space suppressed below - behind it.
      this.player.pause()
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
      // PWA file handler: opening a recording from the OS shell once installed.
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
    /**
     * The keyboard half of the main-stream jump buttons; coverage.js says what
     * counts as a start. Silent when there is none that way, exactly as the
     * button is dead when there is none.
     */
    jumpMainStart (dir) {
      const target = adjacentMainStart(mainStartPoints(this.state.coverage), this.state.currentTime, dir)
      if (target !== null) this.onSeek(target, false)
    },
    /**
     * Opens the "seek to a time" dialog, paused.
     *
     * Pausing is the point as much as the dialog is: typing a timestamp takes
     * seconds, and a recording left running underneath would have carried the
     * playhead somewhere else by the time the answer was entered -- so the
     * position the dialog opened on would no longer be the one it was offering
     * to edit.
     */
    openSeekDialog () {
      if (this.state.status !== 'ready') return
      if (this.state.playing) this.player.pause()
      this.seekOpen = true
      this.wakeUi()
    },
    onSeekDialog (ms) {
      this.seekOpen = false
      this.onSeek(ms, false)
    },
    /**
     * A wheel that landed on the chrome, handed to the zoom underneath it.
     *
     * The top bar, the control bar and the centre play button all float over the
     * picture, so a wheel aimed at the video hits one of them whenever the
     * pointer happens to be near an edge or in the middle. None of them has any
     * use for a wheel of their own, and the gesture dying wherever they happen to
     * be reads as the zoom being unreliable. See ViewController.wheel.
     */
    onChromeWheel (event) {
      if (!this.view || this.state.status !== 'ready') return
      this.view.wheel(event)
      this.wakeUi(event)
    },
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
      if (def.needsFile && !this.fileContext) this.adoptFileContext()
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
      this.playbackStream = null
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
    /**
     * Writes the metadata report and hands it to the browser's downloader.
     *
     * Two routes in, and they differ only in cost. With a file open the report
     * is built from the header, index and probe already in memory and appears at
     * once. After a failed open there is nothing in memory -- the player drops
     * everything when an open throws -- so the file is read again from the blob
     * the last open was given, and that scan is what the progress counts.
     */
    async exportMetadata (format = 'text') {
      if (this.analyzing) return
      const context = this.player.metadataContext()
      const file = context ? context.blob : this.lastFile
      if (!file) {
        this.showNotice('There is no file open to describe.')
        return
      }
      this.analyzing = true
      // With the file open the text report needs no reading at all, so its bar
      // would only ever flash; the detailed one still has every overlay record
      // to fetch, and that is worth watching.
      this.analyzeProgress = (context && format === 'text') ? 1 : 0
      try {
        const report = await analyzeRecording(file, {
          ...(context || {}),
          format,
          fileName: (context && context.fileName) || this.state.fileName || file.name,
          onProgress: (p) => { this.analyzeProgress = p }
        })
        downloadBlob(new Blob([report.text], { type: report.mime }), report.name)
        this.showNotice(`Saved ${report.name}.`)
      } catch (e) {
        const why = e && e.message ? e.message : String(e)
        this.showNotice(`The metadata report could not be written: ${why}`)
      } finally {
        this.analyzing = false
        this.analyzeProgress = 0
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
      if (handle) this.folderKnown = true
      this.snapshotDir = handle || null
      this.snapshotFolderReady = !!handle
      this.snapshotFolderName = (handle && handle.name) || (handle ? 'the open folder' : '')
    },

    // ---------------------------------------------------- session in the URL
    /**
     * Everything the address bar is written from, in one place.
     *
     * Called from wherever the app changes -- a panel opening, a pause, a seek,
     * the playhead itself sixty times a second -- and it is this function, not
     * its callers, that decides which of those are worth a rewrite. A fragment
     * identical to the one already there is dropped; one that differs only in
     * the playhead waits out `URL_SYNC_MS`, with a single trailing timer so the
     * last position of a burst still lands; anything else goes out at once.
     *
     * `replaceState` never navigates, so none of this touches the back button,
     * reloads the page, or disturbs the recording being decoded.
     */
    syncUrl () {
      if (!this.urlReady) return
      // Until a pending resume is settled the URL keeps describing the
      // recording it is waiting on rather than the empty player in front of it.
      // Otherwise the very first write would erase the thing the Resume button
      // exists to act on.
      const waiting = this.resumeTarget
      const { hash, stable } = sessionHash({
        file: waiting ? waiting.file : this.fileRef,
        time: waiting ? waiting.time : this.state.currentTime,
        playing: waiting ? waiting.playing : this.state.playing,
        panels: this.urlPanels()
      })
      if (hash === this.urlHash) return
      const wait = URL_SYNC_MS - (Date.now() - this.urlWrittenAt)
      if (stable === this.urlStable && wait > 0) {
        if (!this.urlTrailing) {
          this.urlTrailing = setTimeout(() => {
            this.urlTrailing = null
            this.syncUrl()
          }, wait)
        }
        return
      }
      if (this.urlTrailing) {
        clearTimeout(this.urlTrailing)
        this.urlTrailing = null
      }
      this.urlHash = hash
      this.urlStable = stable
      this.urlWrittenAt = Date.now()
      writeSessionHash(hash)
    },
    /** Which panels are open, down which dock, and which the viewer collapsed. */
    urlPanels () {
      const out = { left: [], right: [], collapsed: [] }
      for (const id of this.openIds) {
        // A popped-out panel is recorded on the side it came from. Restoring it
        // into a window is not on offer: a page reopening pop-ups by itself is
        // exactly what a pop-up blocker exists to stop.
        out[this.sideOf(id)].push(id)
        if (this.panelCollapsed[id]) out.collapsed.push(id)
      }
      // Panels that describe a recording cannot be open before there is one, so
      // for as long as a resume is still waiting they live in the URL alone.
      const waiting = this.resumeTarget
      if (waiting) {
        for (const id of waiting.deferred) {
          if (this.panelOpen[id]) continue
          out[this.sideOf(id)].push(id)
          if (waiting.collapsed.includes(id)) out.collapsed.push(id)
        }
        const rank = (id) => this.settings.panelOrder.indexOf(id)
        for (const side of SIDES) out[side].sort((a, b) => rank(a) - rank(b))
      }
      return out
    },

    /**
     * The other direction, once: what the page was loaded with.
     *
     * Panels go back immediately -- they cost nothing and need no permission.
     * The recording is a question the browser has to be asked, so it is handed
     * to `resumeFromUrl` and the URL is left describing it until that settles.
     */
    restoreFromUrl () {
      const saved = readSessionUrl()
      const deferred = this.applyUrlPanels(saved.panels)
      if (saved.file) {
        this.resumeTarget = {
          file: saved.file,
          time: saved.time,
          playing: saved.playing,
          // The panels that had to wait for a recording to describe.
          deferred,
          collapsed: saved.panels.collapsed
        }
      }
      // From here on the URL follows the app rather than the other way round.
      this.urlReady = true
      this.syncUrl()
      if (this.resumeTarget) this.resumeFromUrl()
    },
    /**
     * Puts the docks back, and says which panels could not be opened yet.
     *
     * The sides and the order are written through to the saved settings rather
     * than held apart from them: the URL is the more recent record of the two,
     * having been written by this app the last time these panels were touched,
     * and two disagreeing sources of the same preference is worse than either.
     */
    applyUrlPanels (panels) {
      const listed = [...panels.left, ...panels.right]
      if (!listed.length) return []
      const sides = { ...this.settings.panelSides }
      for (const id of panels.left) sides[id] = 'left'
      for (const id of panels.right) sides[id] = 'right'
      // One flat order across both docks, each reading its own subsequence out
      // of it -- so the left stack followed by the right one reproduces both,
      // and panels the URL never mentioned keep their place behind them.
      const order = [...listed, ...this.settings.panelOrder.filter((id) => !listed.includes(id))]
      this.patchSettings({ panelSides: sides, panelOrder: order })
      return this.openUrlPanels(listed, panels.collapsed)
    },
    /**
     * Opens what it can and returns what it could not.
     *
     * The metadata and export panels are descriptions of a recording, so before
     * there is one they are not opened but deferred -- to `onFileReady`, if a
     * recording is on its way, and to nothing at all if it is not.
     */
    openUrlPanels (ids, collapsed = []) {
      const later = []
      for (const id of ids || []) {
        const def = panelDef(id)
        if (!def) continue
        if (def.needsFile && this.state.status !== 'ready') {
          later.push(id)
          continue
        }
        this.openPanel(id)
      }
      // After opening, never before: opening a panel expands it.
      const marks = (collapsed || []).filter((id) => this.panelOpen[id])
      if (marks.length) {
        this.panelCollapsed = {
          ...this.panelCollapsed,
          ...Object.fromEntries(marks.map((id) => [id, true]))
        }
      }
      return later
    },

    /**
     * Whether the recording the URL names can be opened again, and how.
     *
     * A directory handle kept in IndexedDB survives a reload; the permission
     * grant attached to it may or may not, and that is the whole question. A
     * grant that persisted means the file can simply be opened, and the reload
     * lands more or less where it left off. A grant that did not means the
     * browser wants a gesture first, and there is no honest way around that --
     * so it becomes a button rather than a prompt nobody asked for.
     */
    async resumeFromUrl () {
      const want = this.resumeTarget
      if (!want) return
      try {
        // Only the directory route leaves anything behind to reopen with, and a
        // browser without it cannot have written this fragment to begin with.
        if (!canPickDirectory()) return this.cancelResume()
        const handle = await loadDirectoryHandle()
        // What the browser kept is the last folder *browsed*, which need not be
        // the one this fragment was written against -- another tab may have
        // moved on since. A name is all a directory handle offers to compare,
        // and guessing wrong would open a different recording of the same name.
        if (!handle || handle.name !== want.file.dir) return this.cancelResume()
        const state = await directoryPermission(handle, false)
        if (state === 'granted') await this.resumeNow(handle)
        else if (state === 'prompt') this.resumePrompt = { name: want.file.name, dir: want.file.dir }
        else this.cancelResume()
      } catch {
        // No IndexedDB, a private window, a storage policy: all of them mean
        // the same thing here, which is that there is nothing to go back to.
        this.cancelResume()
      }
    },
    /** Reopens the file by name -- one round trip, no folder listing. */
    async resumeNow (handle) {
      const want = this.resumeTarget
      if (!want) return
      // Something got there first: a file dropped on the page while the
      // permission check was in flight, or one the OS handed over. That is the
      // recording somebody actually asked for.
      if (this.state.status !== 'idle') return this.cancelResume()
      this.resumePrompt = null
      try {
        const file = await openFileNamed(handle, want.file.name)
        this.folderKnown = true
        await this.openFile(file, 'library', {
          ref: { dir: handle.name, name: want.file.name },
          resume: {
            time: want.time,
            playing: want.playing,
            panels: want.deferred,
            collapsed: want.collapsed
          }
        })
      } catch (e) {
        // Renamed, moved, deleted, or on a share that is no longer mounted.
        this.cancelResume()
        this.showNotice(`${want.file.name} could not be reopened: ${(e && e.message) || e}`)
      }
    },
    /** The Resume button: the click is the user activation the browser wanted. */
    async acceptResume () {
      const want = this.resumeTarget
      if (!want) {
        this.resumePrompt = null
        return
      }
      const handle = await loadDirectoryHandle()
      if (!handle || handle.name !== want.file.dir) return this.cancelResume()
      const state = await directoryPermission(handle, true)
      if (state !== 'granted') {
        this.showNotice(`Access to ${want.file.dir} was declined, so ${want.file.name} was not reopened.`)
        return
      }
      await this.resumeNow(handle)
    },
    /** Nothing to go back to, so the URL stops claiming there is. */
    cancelResume () {
      if (!this.resumeTarget && !this.resumePrompt) return
      this.resumeTarget = null
      this.resumePrompt = null
      this.syncUrl()
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
    /**
     * A time typed into the export range.
     *
     * Stop and show that exact frame: typing one of these is how a moment is
     * picked in a recording too long for the scrub bar to resolve, so the point
     * of it is to see precisely what was chosen.
     */
    onExportSeek (ms) {
      this.player.pause()
      this.player.seek(ms, { preview: false })
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
      if (this.settings.alwaysShowControls) return false
      if (!this.hasFile || this.state.status !== 'ready') return false
      if (this.menuOpen || this.scrubbing || this.pointerOverChrome) return false
      if (this.libraryOpen || this.seekOpen || this.dragging || this.resizeDrag) return false
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

    /**
     * Space is the player's, wherever focus happens to be.
     *
     * A control keeps focus after it is clicked, and a browser treats Space on a
     * focused button, checkbox or radio as a second click on it -- so opening a
     * panel and then reaching for the space bar closed the panel again instead
     * of pausing. This runs in the capture phase because those controls either
     * act on the key natively or stop it before it ever reaches the window, and
     * it takes the key away from both. Nothing is lost by it: everything Space
     * used to activate is activated by Enter as well.
     *
     * The one exception is a field you type into, where a space is a space.
     */
    onSpaceKey (event) {
      if (!isSpaceKey(event)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (acceptsTypedText(event.target)) return
      this.keyboardNav = true
      // Both the page scroll and the focused control's own activation.
      event.preventDefault()
      event.stopPropagation()
      // The folder browser covers the whole window and opening it pauses, so
      // there is nothing behind it for Space to act on; the seek dialog opens
      // paused for the same reason and its buttons answer to Enter.
      if (this.libraryOpen || this.seekOpen) return
      this.togglePlay()
      this.wakeUi()
    },

    onKeyDown (event) {
      // Any key counts as keyboard navigation, Tab included - that is the one
      // that parks focus on a control the chrome must then keep on screen.
      this.keyboardNav = true

      const el = event.target
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      // A clicked button keeps focus and the browser activates it on Enter.
      // Handling that here too would fire the action twice - which reads as the
      // control doing nothing at all. Space never arrives: see onSpaceKey.
      if (el && el.tagName === 'BUTTON' && event.key === 'Enter') return

      // Ctrl + , / . and Ctrl + arrows jump between main-stream starts, ahead of
      // the modifier guard below and regardless of whether the buttons for them
      // are turned on: that setting is about what the control row has room for,
      // not about whether the feature is there. Held with Ctrl so the keys they
      // borrow -- frame step and skip -- keep their unmodified meaning.
      if (event.ctrlKey && !event.metaKey && !event.altKey && !this.libraryOpen && !this.seekOpen) {
        const dir = MAIN_JUMP_KEYS[event.key]
        if (dir) {
          this.jumpMainStart(dir)
          event.preventDefault()
          this.wakeUi()
          return
        }
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return

      // The folder browser covers the whole window; only its own Escape applies.
      if (this.libraryOpen) {
        if (event.key === 'Escape') { this.libraryOpen = false; event.preventDefault() }
        return
      }

      // Same for the seek dialog. Its own field handles Escape before this ever
      // runs; this is the case where focus has moved to one of its buttons.
      if (this.seekOpen) {
        if (event.key === 'Escape') { this.seekOpen = false; event.preventDefault() }
        return
      }

      const skip = this.settings.skipSeconds
      let handled = true
      switch (event.key) {
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
          this.togglePanel('metadata'); break
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
          // Nothing left to close, and a folder to go back to: Escape is the
          // way out of a recording as much as out of a panel, and the place it
          // came from is the folder it was picked from. The browser's own
          // Escape closes it again, so the key goes both ways.
          else if (this.canBrowse && this.folderKnown) this.openLibrary()
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
