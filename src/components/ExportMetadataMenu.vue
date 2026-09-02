<template>
  <div class="expmeta" @keydown.esc.stop="close">
    <button
      ref="button"
      type="button"
      class="btn expmeta__btn"
      :class="{ 'expmeta__btn--wide': wide }"
      :disabled="busy"
      aria-haspopup="true"
      :aria-expanded="open ? 'true' : 'false'"
      :title="busy ? '' : `Write a report describing every part of ${name || 'this recording'}`"
      @click.stop="toggle"
    >
      <AppIcon :name="busy ? 'refresh' : 'download'" :size="16" />
      <span>{{ busy ? busyLabel : 'Export metadata' }}</span>
    </button>

    <div v-if="open" class="expmeta__menu" role="menu" aria-label="Metadata report format">
      <button
        v-for="f in formats"
        :key="f.value"
        type="button"
        class="expmeta__item"
        role="menuitem"
        @click.stop="choose(f.value)"
      >
        <span class="expmeta__row">
          <span class="expmeta__name">{{ f.name }}</span>
          <span class="expmeta__kind">{{ f.detail }}</span>
        </span>
        <span class="expmeta__hint">{{ f.hint }}</span>
      </button>
    </div>
  </div>
</template>

<script>
import AppIcon from './AppIcon.vue'
import { REPORT_FORMATS } from '../container/analyze.js'

/**
 * The "Export metadata" button, and the two things it can write.
 *
 * Shared because it appears twice -- at the foot of the metadata panel, and
 * under the message shown when a file will not play, which is where it is most
 * wanted. The two reports differ in cost as well as in shape, so each option
 * says what it holds rather than only what it is called.
 *
 * The menu opens upward. In the panel the button is the last thing in a
 * scrolling column, so downward would open into nothing; over the video it sits
 * mid-screen and either direction works.
 */
export default {
  name: 'ExportMetadataMenu',
  components: { AppIcon },
  props: {
    // True while a report is being written, which on a file the player never
    // finished opening means reading it end to end.
    busy: { type: Boolean, default: false },
    busyLabel: { type: String, default: 'Reading the file...' },
    name: { type: String, default: '' },
    wide: { type: Boolean, default: false }
  },
  emits: ['choose'],
  data () {
    return { open: false, formats: REPORT_FORMATS }
  },
  methods: {
    toggle () { this.open ? this.close() : this.show() },
    show () {
      this.open = true
      document.addEventListener('pointerdown', this.onOutside, true)
    },
    close () {
      if (!this.open) return
      this.open = false
      document.removeEventListener('pointerdown', this.onOutside, true)
    },
    onOutside (event) {
      if (!this.$el.contains(event.target)) this.close()
    },
    choose (format) {
      this.close()
      this.$emit('choose', format)
    }
  },
  beforeUnmount () {
    document.removeEventListener('pointerdown', this.onOutside, true)
  }
}
</script>

<style scoped>
.expmeta {
  position: relative;
  display: flex;
}

.expmeta__btn {
  justify-content: center;
}

.expmeta__btn--wide {
  width: 100%;
}

.expmeta__menu {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  min-width: 232px;
  padding: 5px;
  border-radius: 11px;
  background: var(--panel);
  border: 1px solid rgba(255, 255, 255, 0.13);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.55);
  z-index: 30;
  text-align: left;
}

.expmeta__item {
  display: block;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.expmeta__item:hover {
  background: rgba(255, 255, 255, 0.11);
}

.expmeta__item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.expmeta__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.expmeta__name {
  flex: 1 1 auto;
  font-size: 13px;
}

.expmeta__kind {
  color: var(--text-dim);
  font-size: 11px;
  white-space: nowrap;
}

.expmeta__hint {
  display: block;
  margin-top: 2px;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.4;
}
</style>
