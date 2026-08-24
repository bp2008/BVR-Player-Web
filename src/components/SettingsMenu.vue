<template>
  <div class="settings" @keydown.esc.stop="close">
    <button
      ref="button"
      type="button"
      class="ctl-btn"
      :class="{ 'ctl-btn--active': open }"
      title="Settings"
      aria-label="Settings"
      :aria-expanded="open ? 'true' : 'false'"
      @click="toggle"
    >
      <AppIcon name="settings" />
    </button>

    <div v-if="open" ref="panel" class="settings__panel" role="dialog" aria-label="Player settings">
      <label class="settings__row">
        <span class="settings__label">Skip interval</span>
        <span class="settings__control">
          <input
            class="settings__number"
            type="number"
            inputmode="numeric"
            min="1"
            max="600"
            step="1"
            :value="settings.skipSeconds"
            @input="onSkipInput"
            @change="onSkipCommit"
            @keydown.stop
            @dblclick.stop
          />
          <span class="settings__unit">sec</span>
        </span>
      </label>

      <label class="settings__row">
        <span class="settings__label">Time display</span>
        <select
          class="settings__select"
          :value="settings.timeDisplay"
          @change="emitPatch({ timeDisplay: $event.target.value })"
          @keydown.stop
          @dblclick.stop
        >
          <option value="elapsed">Elapsed</option>
          <option value="clock">Wall clock</option>
        </select>
      </label>

      <label v-if="showStreamPicker" class="settings__row">
        <span class="settings__label">Video stream</span>
        <select
          class="settings__select"
          :value="state.streamMode"
          @change="$emit('stream', $event.target.value)"
          @keydown.stop
          @dblclick.stop
        >
          <option
            v-for="opt in streamOptions"
            :key="opt.value"
            :value="opt.value"
            :disabled="opt.disabled"
          >{{ opt.label }}</option>
        </select>
      </label>

      <label class="settings__row settings__row--toggle">
        <span class="settings__label">Loop playback</span>
        <input
          type="checkbox"
          class="settings__check"
          :checked="settings.loop"
          @change="emitPatch({ loop: $event.target.checked })"
          @keydown.stop
          @dblclick.stop
        />
      </label>

      <div class="settings__divider"></div>

      <dl class="settings__info">
        <div><dt>Video</dt><dd>{{ state.videoLabel || '--' }}</dd></div>
        <div><dt>Resolution</dt><dd>{{ state.width }} x {{ state.height }}</dd></div>
        <div><dt>Nominal rate</dt><dd>{{ state.fps ? state.fps.toFixed(2) + ' fps' : '--' }}</dd></div>
        <div><dt>Frames</dt><dd>{{ state.frameCount.toLocaleString() }}</dd></div>
        <div><dt>Audio</dt><dd>{{ state.hasAudio ? state.audioLabel : 'none' }}</dd></div>
        <div v-if="state.startUtc"><dt>Recorded</dt><dd>{{ recordedAt }}</dd></div>
        <div><dt>File</dt><dd>{{ formatBytes(state.fileSize) }}</dd></div>
      </dl>

      <div class="settings__divider"></div>
      <div class="settings__keys">
        <span><kbd>Space</kbd> play/pause</span>
        <span><kbd>&larr;</kbd><kbd>&rarr;</kbd> skip</span>
        <span><kbd>,</kbd><kbd>.</kbd> frame step</span>
        <span><kbd>M</kbd> mute</span>
        <span><kbd>F</kbd> fullscreen</span>
      </div>
    </div>
  </div>
</template>

<script>
import AppIcon from './AppIcon.vue'
import { formatBytes, formatUtc } from '../util/format.js'
import { streamOptions } from '../util/streams.js'

export default {
  name: 'SettingsMenu',
  components: { AppIcon },
  props: {
    settings: { type: Object, required: true },
    state: { type: Object, required: true }
  },
  emits: ['patch', 'stream', 'open-change'],
  data () {
    return { open: false }
  },
  computed: {
    showStreamPicker () {
      return this.state.hasMainStream && this.state.hasSubStream
    },
    streamOptions () {
      return streamOptions(this.state)
    },
    recordedAt () {
      return formatUtc(this.state.startUtc, false)
    }
  },
  methods: {
    formatBytes,
    clampSkip (raw) {
      const n = Math.round(Number(raw))
      if (!Number.isFinite(n)) return this.settings.skipSeconds
      return Math.min(600, Math.max(1, n))
    },
    /**
     * Live updates while typing or clicking the spinner, but only for values
     * that are already in range - clamping mid-keystroke would fight the user
     * (and an emptied field must be allowed to stay empty until it is committed).
     */
    onSkipInput (event) {
      const raw = event.target.value
      if (raw === '') return
      const n = Number(raw)
      if (!Number.isFinite(n)) return
      const clamped = this.clampSkip(n)
      if (clamped === n) this.emitPatch({ skipSeconds: clamped })
    },
    /**
     * Commit (blur / Enter). Writing the clamped value straight back to the DOM
     * matters: if the clamp lands on the value the prop already holds, Vue has
     * no patch to apply and the field would keep showing the rejected text.
     */
    onSkipCommit (event) {
      const clamped = this.clampSkip(event.target.value)
      event.target.value = String(clamped)
      this.emitPatch({ skipSeconds: clamped })
    },
    emitPatch (patch) {
      this.$emit('patch', patch)
    },
    toggle () {
      this.open ? this.close() : this.show()
    },
    show () {
      this.open = true
      this.$emit('open-change', true)
      document.addEventListener('pointerdown', this.onOutside, true)
    },
    close () {
      if (!this.open) return
      this.open = false
      this.$emit('open-change', false)
      document.removeEventListener('pointerdown', this.onOutside, true)
    },
    onOutside (event) {
      if (!this.$el.contains(event.target)) this.close()
    }
  },
  beforeUnmount () {
    document.removeEventListener('pointerdown', this.onOutside, true)
  }
}
</script>

<style scoped>
.settings {
  position: relative;
}

.settings__panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  width: 292px;
  max-height: min(64vh, 520px);
  overflow-y: auto;
  padding: 12px;
  border-radius: 12px;
  background: rgba(16, 19, 25, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(14px);
  z-index: 30;
}

.settings__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 2px;
  font-size: 13px;
}

.settings__label {
  color: var(--text-dim);
}

.settings__control {
  display: flex;
  align-items: center;
  gap: 5px;
}

.settings__number {
  width: 62px;
}

.settings__number,
.settings__select {
  /* Opaque on purpose - see --field in styles.css. */
  background: var(--field);
  border: 1px solid var(--field-border);
  border-radius: 7px;
  color: var(--text);
  padding: 4px 7px;
  font: inherit;
  font-size: 13px;
  color-scheme: dark;
}

.settings__number:hover,
.settings__select:hover {
  border-color: rgba(255, 255, 255, 0.28);
}

.settings__select {
  min-width: 132px;
  max-width: 168px;
}

.settings__number:focus-visible,
.settings__select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.settings__unit {
  color: var(--text-dim);
  font-size: 12px;
}

.settings__check {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}

.settings__divider {
  height: 1px;
  margin: 9px 0;
  background: rgba(255, 255, 255, 0.1);
}

.settings__info {
  margin: 0;
  font-size: 12px;
}

.settings__info > div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 2px;
}

.settings__info dt {
  color: var(--text-dim);
}

.settings__info dd {
  margin: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.settings__keys {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 11px;
  color: var(--text-dim);
}

kbd {
  display: inline-block;
  min-width: 15px;
  padding: 1px 4px;
  margin-right: 2px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.07);
  font: inherit;
  font-size: 10px;
  text-align: center;
}
</style>
