<template>
  <div
    ref="root"
    class="app"
    :class="{ 'app--idle': !hasFile, 'app--hide-ui': !uiVisible }"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
    @pointermove="onPointerMove"
    @pointerdown="onPointerDown"
    @pointerleave="onPointerLeave"
  >
    <div class="stage" ref="stage" @click="onStageClick" @dblclick="onStageDblClick">
      <canvas ref="canvas" class="stage__canvas"></canvas>

      <div v-if="!hasFile" class="dropzone">
        <div class="dropzone__card">
          <AppIcon name="film" :size="46" />
          <h1 class="dropzone__title">BVR Player</h1>
          <p class="dropzone__text">
            Drop a Blue Iris <code>.bvr</code> recording here, or choose one to open.
            Files are decoded locally in your browser and never uploaded.
          </p>
          <button type="button" class="btn btn--accent" @click.stop="pickFile">
            <AppIcon name="folder" :size="18" />
            <span>Open .bvr file</span>
          </button>
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
          <span v-if="hasFile" class="topbar__meta">{{ state.width }}&times;{{ state.height }} &middot; {{ state.videoLabel }}</span>
          <span v-if="state.truncated" class="topbar__flag" title="The final frame is incomplete; playback stops at the last whole frame.">truncated</span>
        </div>
        <div class="topbar__right">
          <button v-if="installPrompt" type="button" class="btn btn--ghost" @click.stop="install">Install</button>
          <button type="button" class="btn btn--ghost" @click.stop="pickFile">
            <AppIcon name="folder" :size="16" />
            <span>Open</span>
          </button>
        </div>
      </header>

      <ControlBar
        v-if="state.status === 'ready'"
        class="controlbar"
        :state="state"
        :settings="settings"
        :fullscreen="isFullscreen"
        @toggle-play="togglePlay"
        @skip="onSkip"
        @step="onStep"
        @seek="onSeek"
        @scrubbing="onScrubbing"
        @volume="onVolume"
        @toggle-mute="onToggleMute"
        @toggle-fullscreen="toggleFullscreen"
        @patch="patchSettings"
        @stream="onStream"
        @menu-open="onMenuOpen"
      />
    </div>

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
import { BvrPlayer } from './player/BvrPlayer.js'
import { loadSettings, saveSettings } from './util/settings.js'
import { formatBytes } from './util/format.js'

// How long the chrome lingers after the last pointer activity. Touch gets a
// longer grace period because there is no hover to bring it back - only a tap.
const UI_IDLE_MS = 2600
const UI_IDLE_TOUCH_MS = 4200

// A pointer resting anywhere inside these keeps the chrome up indefinitely.
const CHROME_SELECTOR = '.topbar, .controlbar'

export default {
  name: 'App',
  components: { AppIcon, ControlBar },
  data () {
    return {
      state: {
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
        mainWidth: 0,
        mainHeight: 0,
        subWidth: 0,
        subHeight: 0,
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
        error: ''
      },
      settings: loadSettings(),
      dragDepth: 0,
      notice: '',
      isFullscreen: false,
      uiVisible: true,
      menuOpen: false,
      scrubbing: false,
      pointerOverChrome: false,
      installPrompt: null,
      webCodecsOk: typeof window !== 'undefined' && typeof window.VideoDecoder !== 'undefined'
    }
  },
  computed: {
    hasFile () {
      return this.state.status === 'ready' || this.state.status === 'loading' || this.state.status === 'error'
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
    'state.status' () {
      this.wakeUi()
    }
  },
  created () {
    // Deliberately not reactive: these only ever feed decisions taken inside
    // event handlers, and nothing renders from them.
    this.hideTimer = null
    this.lastPointerWasTouch = false
    this.uiVisibleBeforePointer = true
    this.keyboardNav = false
  },
  mounted () {
    this.player = new BvrPlayer({
      canvas: this.$refs.canvas,
      onState: (s) => { this.state = s },
      onError: (e) => console.error(e),
      onNotice: (msg) => this.showNotice(msg)
    })
    this.player.streamMode = this.settings.streamMode
    this.player.setVolume(this.settings.volume)
    if (this.settings.muted) this.player.toggleMute()

    this.ro = new ResizeObserver(() => this.player.onResize())
    this.ro.observe(this.$refs.stage)
    this.player.onResize()

    window.addEventListener('keydown', this.onKeyDown)
    document.addEventListener('fullscreenchange', this.onFullscreenChange)
    window.addEventListener('beforeinstallprompt', this.onInstallPrompt)
    this.consumeLaunchFiles()
  },
  beforeUnmount () {
    window.removeEventListener('keydown', this.onKeyDown)
    document.removeEventListener('fullscreenchange', this.onFullscreenChange)
    window.removeEventListener('beforeinstallprompt', this.onInstallPrompt)
    if (this.ro) this.ro.disconnect()
    this.clearHideTimer()
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
      await this.player.open(file)
      this.player.setVolume(this.settings.volume)
      if (this.settings.muted !== this.player.muted) this.player.toggleMute()
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
    onStageClick (event) {
      if (event.target !== this.$refs.canvas) return
      if (!this.hasFile || this.state.status !== 'ready') return
      // Touch has no hover, so a tap on a bare video surface is the only way to
      // bring the chrome back - it must not also toggle playback.
      if (this.lastPointerWasTouch && !this.uiVisibleBeforePointer) {
        this.wakeUi()
        return
      }
      this.togglePlay()
    },
    onStageDblClick (event) {
      // Only the video surface toggles fullscreen. Without this check, any fast
      // double click inside the stage - frame-step button, number spinner, chip
      // - bubbles up here and flips fullscreen underneath the user's cursor.
      if (event.target !== this.$refs.canvas) return
      this.toggleFullscreen()
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
