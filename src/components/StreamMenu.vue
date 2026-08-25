<template>
  <div class="streammenu" @keydown.esc.stop="close">
    <button
      ref="button"
      type="button"
      class="chip chip--button"
      :class="{ 'chip--open': open }"
      :title="`Video stream: ${currentName}. Click to choose.`"
      aria-haspopup="true"
      :aria-expanded="open ? 'true' : 'false'"
      @click="toggle"
      @dblclick.stop
    >
      <span class="chip__text">{{ chipLabel }}</span>
      <AppIcon class="chip__caret" name="caretUp" :size="13" />
    </button>

    <div v-if="open" class="streammenu__panel" role="menu" aria-label="Video stream">
      <p class="streammenu__title">Video stream</p>
      <button
        v-for="opt in options"
        :key="opt.value"
        type="button"
        class="streammenu__item"
        :class="{ 'streammenu__item--on': opt.value === state.streamMode }"
        role="menuitemradio"
        :aria-checked="opt.value === state.streamMode ? 'true' : 'false'"
        :disabled="opt.disabled"
        :title="opt.title || null"
        @click="choose(opt)"
        @dblclick.stop
      >
        <AppIcon class="streammenu__tick" name="check" :size="15" />
        <span class="streammenu__name">{{ opt.name }}</span>
        <span class="streammenu__detail">{{ opt.detail }}</span>
      </button>
    </div>
  </div>
</template>

<script>
import AppIcon from './AppIcon.vue'
import { streamOptions, streamChipLabel } from '../util/streams.js'

export default {
  name: 'StreamMenu',
  components: { AppIcon },
  props: {
    state: { type: Object, required: true }
  },
  emits: ['stream', 'open-change'],
  data () {
    return { open: false }
  },
  computed: {
    options () { return streamOptions(this.state) },
    chipLabel () { return streamChipLabel(this.state) },
    currentName () {
      const cur = this.options.find((o) => o.value === this.state.streamMode)
      return cur ? cur.label : this.state.streamMode
    }
  },
  methods: {
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
    },
    choose (opt) {
      if (opt.disabled) return
      if (opt.value !== this.state.streamMode) this.$emit('stream', opt.value)
      this.close()
    }
  },
  beforeUnmount () {
    document.removeEventListener('pointerdown', this.onOutside, true)
  }
}
</script>

<style scoped>
.streammenu {
  position: relative;
  display: flex;
  align-items: center;
}

.chip--button {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding-right: 4px;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
}

.chip--button:hover,
.chip--open {
  background: rgba(255, 255, 255, 0.16);
  border-color: rgba(255, 255, 255, 0.32);
  color: var(--text);
}

.chip--button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.chip__caret {
  opacity: 0.75;
}

.streammenu__panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  min-width: 196px;
  padding: 6px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(14px);
  z-index: 30;
}

.streammenu__title {
  margin: 2px 8px 6px;
  font-size: 11px;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--text-dim);
}

.streammenu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
}

.streammenu__item:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.11);
}

.streammenu__item:disabled {
  opacity: 0.42;
  cursor: default;
}

.streammenu__item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.streammenu__tick {
  visibility: hidden;
  color: var(--accent);
}

.streammenu__item--on .streammenu__tick {
  visibility: visible;
}

.streammenu__name {
  flex: 1 1 auto;
}

.streammenu__detail {
  color: var(--text-dim);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* The control row has no room for the chip on a phone, and dropping it there
   would push the settings and fullscreen buttons off the edge. The same picker
   lives in the settings panel, which stays reachable. Kept in this file so it
   outranks the unscoped `.streammenu` above on specificity. */
@media (max-width: 620px) {
  .streammenu { display: none; }
}
</style>
