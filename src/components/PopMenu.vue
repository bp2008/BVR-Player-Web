<template>
  <div class="popmenu" @keydown.esc.stop="close">
    <!-- The pill is a span inside a full-height button: the chrome a chip wants
         to be is small, and the area a finger wants to hit is the whole row. -->
    <button
      ref="button"
      type="button"
      class="ctl-hit"
      :title="title"
      aria-haspopup="true"
      :aria-expanded="open ? 'true' : 'false'"
      @click="toggle"
      @dblclick.stop
    >
      <span class="chip chip--button" :class="{ 'chip--open': open, 'chip--on': active }">
        <span class="chip__text">{{ chip }}</span>
        <AppIcon class="chip__caret" name="caretUp" :size="13" />
      </span>
    </button>

    <div v-if="open" class="popmenu__panel" role="menu" :aria-label="label">
      <p class="popmenu__title">{{ label }}</p>
      <button
        v-for="opt in options"
        :key="String(opt.value)"
        type="button"
        class="popmenu__item"
        :class="{ 'popmenu__item--on': opt.value === value }"
        role="menuitemradio"
        :aria-checked="opt.value === value ? 'true' : 'false'"
        :disabled="opt.disabled"
        :title="opt.title || null"
        @click="choose(opt)"
        @dblclick.stop
      >
        <AppIcon class="popmenu__tick" name="check" :size="15" />
        <span class="popmenu__name">{{ opt.name }}</span>
        <span class="popmenu__detail">{{ opt.detail }}</span>
      </button>
    </div>
  </div>
</template>

<script>
import AppIcon from './AppIcon.vue'

/**
 * The chip-with-a-popup pattern the control bar uses for its short pick lists.
 *
 * Shared rather than repeated so the stream picker and the speed picker cannot
 * drift apart in how they open, dismiss or announce themselves.
 */
export default {
  name: 'PopMenu',
  components: { AppIcon },
  props: {
    label: { type: String, required: true },
    chip: { type: String, required: true },
    title: { type: String, default: '' },
    options: { type: Array, required: true },
    value: { type: [String, Number], default: '' },
    active: { type: Boolean, default: false }
  },
  emits: ['choose', 'open-change'],
  data () {
    return { open: false }
  },
  methods: {
    toggle () { this.open ? this.close() : this.show() },
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
      if (opt.value !== this.value) this.$emit('choose', opt.value)
      this.close()
    }
  },
  beforeUnmount () {
    document.removeEventListener('pointerdown', this.onOutside, true)
  }
}
</script>

<style scoped>
.popmenu {
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

.ctl-hit:hover .chip--button,
.chip--open {
  background: rgba(255, 255, 255, 0.16);
  border-color: rgba(255, 255, 255, 0.32);
  color: var(--text);
}

.chip--on {
  border-color: rgba(88, 166, 255, 0.5);
  color: var(--accent);
}

.chip__caret {
  opacity: 0.75;
}

.popmenu__panel {
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

.popmenu__title {
  margin: 2px 8px 6px;
  font-size: 11px;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--text-dim);
}

.popmenu__item {
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

.popmenu__item:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.11);
}

.popmenu__item:disabled {
  opacity: 0.42;
  cursor: default;
}

.popmenu__item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.popmenu__tick {
  visibility: hidden;
  color: var(--accent);
}

.popmenu__item--on .popmenu__tick {
  visibility: visible;
}

.popmenu__name {
  flex: 1 1 auto;
}

.popmenu__detail {
  color: var(--text-dim);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
