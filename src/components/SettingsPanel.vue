<template>
  <div class="spanel">
    <h3 class="spanel__h">Playback</h3>

    <label class="spanel__row spanel__row--toggle">
      <span class="spanel__label">
        Play on open
        <em class="spanel__sub">Start as soon as a recording is ready</em>
      </span>
      <input
        type="checkbox"
        class="spanel__check"
        :checked="settings.autoplay"
        @change="emitPatch({ autoplay: $event.target.checked })"
        @keydown.stop
        @dblclick.stop
      />
    </label>

    <label class="spanel__row spanel__row--toggle">
      <span class="spanel__label">Loop playback</span>
      <input
        type="checkbox"
        class="spanel__check"
        :checked="settings.loop"
        @change="emitPatch({ loop: $event.target.checked })"
        @keydown.stop
        @dblclick.stop
      />
    </label>

    <label class="spanel__row">
      <span class="spanel__label">Playback speed</span>
      <select
        class="settings__select"
        :value="state.rate"
        @change="$emit('rate', Number($event.target.value))"
        @keydown.stop
        @dblclick.stop
      >
        <option v-for="r in rates" :key="r" :value="r">{{ r }}x{{ r === 1 ? '' : ' (muted)' }}</option>
      </select>
    </label>

    <label class="spanel__row">
      <span class="spanel__label">Skip interval</span>
      <span class="spanel__control">
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
        <span class="spanel__unit">sec</span>
      </span>
    </label>

    <h3 class="spanel__h">Picture</h3>

    <label v-if="showStreamPicker" class="spanel__row">
      <span class="spanel__label">Video stream</span>
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

    <label class="spanel__row spanel__row--toggle">
      <span class="spanel__label">
        Match stream shapes
        <em class="spanel__sub">{{ aspectSummary }}</em>
      </span>
      <input
        type="checkbox"
        class="spanel__check"
        :checked="settings.matchAspect"
        @change="emitPatch({ matchAspect: $event.target.checked })"
        @keydown.stop
        @dblclick.stop
      />
    </label>

    <label class="spanel__row">
      <span class="spanel__label">Time display</span>
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

    <template v-if="state.hasMetadata">
      <h3 class="spanel__h">Overlays</h3>
      <label class="spanel__row spanel__row--toggle">
        <span class="spanel__label">
          Draw overlays
          <em class="spanel__sub">{{ overlaySummary }}</em>
        </span>
        <input
          type="checkbox"
          class="spanel__check"
          :checked="state.overlayEnabled"
          @change="$emit('overlay', { enabled: $event.target.checked })"
          @keydown.stop
          @dblclick.stop
        />
      </label>
      <div v-if="state.overlayEnabled" class="spanel__subtoggles">
        <label>
          <input type="checkbox" :checked="settings.overlayShapes" @change="$emit('overlay', { shapes: $event.target.checked })" />
          boxes
        </label>
        <label>
          <input type="checkbox" :checked="settings.overlayText" @change="$emit('overlay', { text: $event.target.checked })" />
          text
        </label>
        <label>
          <input type="checkbox" :checked="settings.overlayGraphics" @change="$emit('overlay', { graphics: $event.target.checked })" />
          images
        </label>
      </div>
    </template>

    <h3 class="spanel__h">Keyboard</h3>
    <div class="spanel__keys">
      <span><kbd>Space</kbd> play/pause</span>
      <span><kbd>&larr;</kbd><kbd>&rarr;</kbd> skip</span>
      <span><kbd>,</kbd><kbd>.</kbd> frame step</span>
      <span><kbd>[</kbd><kbd>]</kbd> speed</span>
      <span><kbd>M</kbd> mute</span>
      <span><kbd>F</kbd> fullscreen</span>
      <span><kbd>Z</kbd> reset zoom</span>
      <span><kbd>I</kbd> metadata</span>
      <span><kbd>E</kbd> export</span>
      <span><kbd>O</kbd> open file</span>
      <span><kbd>L</kbd> browse folder</span>
    </div>
  </div>
</template>

<script>
import { streamOptions } from '../util/streams.js'
import { PLAYBACK_RATES } from '../player/BvrPlayer.js'

/**
 * The settings panel.
 *
 * It was a popup over the control bar until the dock existed; as a panel it has
 * room to group its rows and to grow, and the recording's own facts -- codec,
 * resolution, frame count -- moved to the metadata panel, where a description
 * of the file belongs.
 */
export default {
  name: 'SettingsPanel',
  props: {
    settings: { type: Object, required: true },
    state: { type: Object, required: true }
  },
  emits: ['patch', 'stream', 'overlay', 'rate'],
  data () {
    return { rates: PLAYBACK_RATES }
  },
  computed: {
    overlaySummary () {
      const n = this.state.overlayObjects
      const boxes = this.state.overlayShapes
      if (!n) return 'no objects at this position'
      return boxes ? `${n} object(s), ${boxes} box(es) here` : `${n} object(s)`
    },
    showStreamPicker () {
      return this.state.hasMainStream && this.state.hasSubStream
    },
    streamOptions () {
      return streamOptions(this.state)
    },
    /** Says what the setting is actually doing to the file that is open. */
    aspectSummary () {
      if (!this.state.hasMainStream || !this.state.hasSubStream) {
        return 'One stream in this file — nothing to match'
      }
      if (!this.settings.matchAspect) return 'Each stream shown as encoded'
      if (!this.state.displayAspect) return 'Both streams are already the same shape'
      const ratio = this.state.displayAspect
      return `Stretching to ${ratio.toFixed(2)}:1, from the larger stream`
    }
  },
  methods: {
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
    }
  }
}
</script>

<style scoped>
.spanel {
  padding: 4px 12px 14px;
}

.spanel__h {
  margin: 12px 0 2px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-dim);
}

.spanel__h:first-child {
  margin-top: 8px;
}

.spanel__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  font-size: 13px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.spanel__row--toggle {
  cursor: pointer;
}

.spanel__label {
  display: flex;
  flex-direction: column;
  min-width: 0;
  color: var(--text-dim);
}

.spanel__sub {
  font-size: 10.5px;
  font-style: normal;
  opacity: 0.75;
  overflow-wrap: anywhere;
}

.spanel__control {
  display: flex;
  align-items: center;
  gap: 5px;
}

.spanel__unit {
  color: var(--text-dim);
  font-size: 12px;
}

.spanel__check {
  flex: none;
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}

.spanel__subtoggles {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  padding: 8px 0 2px;
  color: var(--text-dim);
  font-size: 11.5px;
}

.spanel__subtoggles label {
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}

.spanel__subtoggles input {
  accent-color: var(--accent);
}

.spanel__keys {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 12px;
  padding-top: 6px;
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
