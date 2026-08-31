<template>
  <div
    class="volume"
    :class="{ 'volume--disabled': !enabled, 'volume--inline': inline }"
    @pointerenter="onPointerEnter"
    @pointerleave="onPointerLeave"
  >
    <button
      ref="button"
      type="button"
      class="ctl-btn"
      :title="buttonTitle"
      :aria-label="buttonLabel"
      :aria-haspopup="inline ? null : 'true'"
      :aria-expanded="inline ? null : (open ? 'true' : 'false')"
      :disabled="!enabled"
      @click="onButton"
    >
      <AppIcon :name="iconName" />
    </button>

    <!--
      The wide slider is always in the DOM, shown or hidden by `display` alone.
      It has to be here even while hidden so the control bar can measure the row
      both ways in a single frame -- see ControlBar.measureVolumeFit -- and it is
      `display` rather than a width that changes, because an animated width was
      the whole of the problem this replaced.
    -->
    <input
      class="volume__slider"
      type="range"
      min="0"
      max="100"
      step="1"
      :value="sliderValue"
      :disabled="!enabled"
      aria-label="Volume"
      @input="onInput"
      @keydown.stop
    />

    <!-- No room for it in the row, so it goes over the picture instead: the same
         control stood on end, absolutely positioned, and therefore incapable of
         moving anything. Mute comes with it, because the button that normally
         carries mute is the one that opens this. -->
    <div
      v-if="open"
      class="volume__pop"
      role="group"
      aria-label="Volume"
      @pointerenter="cancelClose"
    >
      <span class="volume__pct">{{ muted ? 'off' : Math.round(volume * 100) }}</span>
      <input
        ref="slider"
        class="volume__slider volume__slider--vert"
        type="range"
        min="0"
        max="100"
        step="1"
        :value="sliderValue"
        aria-label="Volume"
        @input="onInput"
        @keydown.stop
      />
      <button
        type="button"
        class="ctl-btn ctl-btn--small volume__mute"
        :class="{ 'ctl-btn--active': muted }"
        :title="muteTitle"
        :aria-label="muteTitle"
        :aria-pressed="muted ? 'true' : 'false'"
        @click="$emit('toggle-mute')"
      >
        <AppIcon :name="iconName" :size="18" />
      </button>
    </div>
  </div>
</template>

<script>
import AppIcon from './AppIcon.vue'

// How long the pointer may be off the control before the pop-out goes away.
// There is a gap between the button and the panel above it, and a pointer
// crossing that gap has left both; the panel's own hover bridge covers most of
// it and this covers the rest.
const CLOSE_DELAY_MS = 160

export default {
  name: 'VolumeControl',
  components: { AppIcon },
  props: {
    volume: { type: Number, default: 1 },
    muted: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true },
    /**
     * Whether the wide slider fits in the row without pushing anything onto
     * another line. Measured by the control bar, which is the only thing that
     * can see the whole row; this component just does as it is told.
     */
    inline: { type: Boolean, default: false }
  },
  emits: ['update:volume', 'toggle-mute', 'open-change'],
  data () {
    return { open: false }
  },
  computed: {
    iconName () {
      if (this.muted || this.volume === 0) return 'volumeMute'
      return this.volume < 0.5 ? 'volumeLow' : 'volumeHigh'
    },
    sliderValue () { return this.muted ? 0 : Math.round(this.volume * 100) },
    muteTitle () { return this.muted || this.volume === 0 ? 'Unmute (M)' : 'Mute (M)' },
    /** The button does two different jobs, so it says which one it is doing. */
    buttonTitle () { return this.inline ? this.muteTitle : 'Volume' },
    buttonLabel () {
      if (this.inline) return this.muted || this.volume === 0 ? 'Unmute' : 'Mute'
      return this.open ? 'Close volume' : 'Volume'
    }
  },
  watch: {
    // A recording with no audio, or a speed that silences it, leaves nothing for
    // an open pop-out to adjust; and the row growing enough to hold the wide
    // slider makes it redundant.
    enabled (on) { if (!on) this.close() },
    inline (on) { if (on) this.close() }
  },
  beforeUnmount () {
    this.cancelClose()
    document.removeEventListener('pointerdown', this.onOutside, true)
    document.removeEventListener('keydown', this.onEscape, true)
  },
  methods: {
    onInput (event) {
      this.$emit('update:volume', Number(event.target.value) / 100)
    },
    onButton () {
      if (this.inline) { this.$emit('toggle-mute'); return }
      this.open ? this.close() : this.show()
    },
    /**
     * Hover opens it, for the same reason the wide slider used to grow on hover:
     * reaching the volume should not cost a click. Only for a mouse -- a tap
     * synthesises this event too, and would open the pop-out and then have the
     * click that follows close it again.
     */
    onPointerEnter (event) {
      this.cancelClose()
      if (event.pointerType === 'mouse') this.show()
    },
    onPointerLeave (event) {
      if (event.pointerType !== 'mouse') return
      this.cancelClose()
      this._closeTimer = setTimeout(() => this.close(), CLOSE_DELAY_MS)
    },
    cancelClose () {
      if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null }
    },
    show () {
      if (this.open || this.inline || !this.enabled) return
      this.open = true
      this.$emit('open-change', true)
      document.addEventListener('pointerdown', this.onOutside, true)
      document.addEventListener('keydown', this.onEscape, true)
    },
    close () {
      this.cancelClose()
      if (!this.open) return
      this.open = false
      this.$emit('open-change', false)
      document.removeEventListener('pointerdown', this.onOutside, true)
      document.removeEventListener('keydown', this.onEscape, true)
    },
    onOutside (event) {
      if (!this.$el.contains(event.target)) this.close()
    },
    onEscape (event) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      this.close()
      if (this.$refs.button) this.$refs.button.focus()
    }
  }
}
</script>

<style scoped>
.volume {
  position: relative;
  display: flex;
  align-items: stretch;
}

.volume--disabled {
  opacity: 0.45;
}

/*
 * Shown or not shown, never part-way. The old behaviour grew this from nothing
 * on hover, which on a row with no width to spare rewrapped the whole control
 * bar, moved the button out from under the pointer, and unwrapped it again --
 * a loop the viewer could not get out of except by moving away. So it is only
 * ever laid out where it already fits, and the pop-out covers everywhere else.
 */
.volume__slider {
  display: none;
  accent-color: var(--accent);
  cursor: pointer;
}

.volume--inline .volume__slider {
  display: block;
  align-self: center;
  width: 78px;
  height: 18px;
  margin: 0 6px 0 0;
}

/* --------------------------------------------------------------- pop-out */

.volume__pop {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 6px 6px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(14px);
  z-index: 30;
}

/* Bridges the gap between the panel and the button, so a pointer travelling
   from one to the other never leaves the control. */
.volume__pop::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 100%;
  height: 10px;
}

.volume__pct {
  font: 500 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
}

/* `writing-mode` plus `direction: rtl` stands a range control on end with its
   minimum at the bottom. The `-webkit-appearance: slider-vertical` this replaced
   does the same on engines older than Chrome 121, but it is deprecated, warns on
   every load in current ones, and this app needs a newer Chromium than that for
   WebCodecs anyway. */
.volume__slider--vert {
  display: block;
  writing-mode: vertical-lr;
  direction: rtl;
  width: 20px;
  height: 108px;
  margin: 0;
  align-self: center;
}

.volume__mute {
  flex: none;
}
</style>
