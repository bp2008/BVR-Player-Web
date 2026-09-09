<template>
  <!-- Dismissed on the backdrop's own click rather than its pointerdown: closing
       on the press would take the dialog out from under a pointer that has not
       finished its click, and the click would then land on the video behind and
       start it playing. -->
  <div class="seekto" @click.self="$emit('close')">
    <form
      class="seekto__box"
      role="dialog"
      aria-modal="true"
      aria-label="Seek to a time"
      @submit.prevent="submit"
    >
      <h2 class="seekto__title">Seek to</h2>

      <!-- Only offered where the recording knows when it started; an MP4, or a
           BVR whose header carries no start time, has nothing to date from. -->
      <div v-if="canClock" class="seekto__modes" role="radiogroup" aria-label="Timestamp kind">
        <button
          v-for="m in MODES"
          :key="m.value"
          type="button"
          class="seekto__mode"
          :class="{ 'seekto__mode--on': mode === m.value }"
          role="radio"
          :aria-checked="mode === m.value ? 'true' : 'false'"
          @click="setMode(m.value)"
        >{{ m.label }}</button>
      </div>

      <!-- Enter is bound rather than left to the form's implicit submission: the
           field has to stop its keys reaching the player's own shortcuts, and a
           browser is entitled to skip implicit submission on a one-field form. -->
      <input
        ref="input"
        v-model="text"
        class="seekto__input"
        :class="{ 'seekto__input--bad': text.trim() !== '' && parsed === null }"
        type="text"
        inputmode="numeric"
        spellcheck="false"
        autocomplete="off"
        :placeholder="placeholder"
        :aria-label="mode === 'clock' ? 'Date and time' : 'Position in the recording'"
        :aria-invalid="parsed === null ? 'true' : 'false'"
        @keydown.enter.stop.prevent="submit"
        @keydown.esc.stop.prevent="$emit('close')"
        @keydown.stop
      />

      <p class="seekto__hint" :class="{ 'seekto__hint--bad': hintBad }">{{ hint }}</p>
      <p class="seekto__range">{{ rangeLabel }}</p>

      <div class="seekto__buttons">
        <button type="button" class="btn" @click="$emit('close')">Cancel</button>
        <button type="submit" class="btn btn--accent" :disabled="parsed === null">Go</button>
      </div>
    </form>
  </div>
</template>

<script>
import { formatTime, formatUtc, parseClock, parseTime } from '../util/format.js'

const MODES = [
  { value: 'elapsed', label: 'Elapsed' },
  { value: 'clock', label: 'Date & time' }
]

/**
 * Type a position and go there.
 *
 * The scrub bar is a fraction of a bar wide per minute of recording, which is
 * fine for finding roughly where something is and useless for going back to the
 * exact frame a colleague quoted. This is the other half: the same two readings
 * the control bar shows -- elapsed and wall clock -- accepted back, to the
 * millisecond, in the shapes `formatTime` and `formatUtc` write them.
 *
 * It is a dialog rather than a panel, which the rest of the app avoids, because
 * it is one field answered once. A panel would outlive the question.
 *
 * The clip is the bound. Anything readable outside it lands on the nearest end
 * rather than being refused: a value one frame past the end is a real answer to
 * "where does this stop", and there is nowhere else it could have meant.
 */
export default {
  name: 'SeekDialog',
  props: {
    currentTime: { type: Number, default: 0 },
    duration: { type: Number, default: 0 },
    /** Unix ms of the first frame, or 0 where the recording does not say. */
    startUtc: { type: Number, default: 0 },
    /** Which reading to open on; the control bar's own time display. */
    initialMode: { type: String, default: 'elapsed' }
  },
  emits: ['seek', 'close'],
  data () {
    const mode = this.startUtc > 0 && this.initialMode === 'clock' ? 'clock' : 'elapsed'
    return { MODES, mode, text: this.writeTime(mode, this.currentTime) }
  },
  computed: {
    canClock () { return this.startUtc > 0 },
    /** Where the typed text points, in media time, or null if it is unreadable. */
    parsed () {
      const s = this.text.trim()
      if (!s) return null
      if (this.mode === 'clock') {
        const utc = parseClock(s)
        return utc === null ? null : utc - this.startUtc
      }
      return parseTime(s)
    },
    /** Where a seek would actually land, once the clip has had its say. */
    target () {
      if (this.parsed === null) return null
      return Math.min(this.duration, Math.max(0, this.parsed))
    },
    clipped () { return this.parsed !== null && this.parsed !== this.target },
    placeholder () {
      return this.mode === 'clock' ? 'yyyy-mm-dd hh:mm:ss.mmm' : 'h:mm:ss.mmm'
    },
    hintBad () { return this.parsed === null || this.clipped },
    /**
     * One line that always says what pressing Go will do, because for most of
     * the keystrokes it takes to type a timestamp the field holds something
     * unreadable, and a field that only complains once you submit is worse than
     * one that keeps up.
     */
    hint () {
      if (!this.text.trim()) return 'Type a position, or the moment it happened.'
      if (this.parsed === null) {
        return this.mode === 'clock'
          ? 'Not a date and time. Try 2026-08-25 17:04:31.500'
          : 'Not a position. Try 1:04:31.500, 4:31.5 or 271'
      }
      if (this.clipped) {
        const end = this.target === 0 ? 'start' : 'end'
        return `Outside this recording — Go lands on the ${end}, ${this.show(this.target)}.`
      }
      return `Go to ${this.show(this.target)}.`
    },
    rangeLabel () {
      return `This recording runs ${this.show(0)} to ${this.show(this.duration)}.`
    }
  },
  mounted () {
    this.focusInput()
  },
  methods: {
    /** A media time written the way the current mode reads it back. */
    writeTime (mode, ms) {
      const at = Math.min(this.duration, Math.max(0, ms))
      return mode === 'clock' ? formatUtc(this.startUtc + at) : formatTime(at)
    },
    /** The same, for prose: the clock reading is meaningless without its date. */
    show (ms) { return this.writeTime(this.mode, ms) },
    /**
     * Switching reading keeps the position, not the text. Anything readable is
     * carried across as the moment it named; anything half-typed is dropped for
     * the playhead, since there is no position in it to preserve.
     */
    setMode (mode) {
      if (mode === this.mode) return
      const at = this.parsed === null ? this.currentTime : this.target
      this.mode = mode
      this.text = this.writeTime(mode, at)
      this.$nextTick(this.focusInput)
    },
    focusInput () {
      const el = this.$refs.input
      if (!el) return
      el.focus()
      el.select()
    },
    submit () {
      if (this.target === null) return
      this.$emit('seek', this.target)
    }
  }
}
</script>

<style scoped>
/* Over the picture and over the control bar that opened it, but under the
   folder browser, which replaces the whole view rather than sitting on it. */
.seekto {
  position: absolute;
  inset: 0;
  z-index: 26;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(5, 7, 11, 0.62);
  backdrop-filter: blur(3px);
}

.seekto__box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(380px, 100%);
  padding: 20px;
  border-radius: 14px;
  background: var(--panel);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.seekto__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.seekto__modes {
  display: flex;
  gap: 0;
  align-self: flex-start;
  padding: 2px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.07);
}

.seekto__mode {
  padding: 5px 12px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.seekto__mode:hover {
  color: var(--text);
}

.seekto__mode--on {
  background: rgba(255, 255, 255, 0.16);
  color: var(--text);
}

.seekto__mode:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.seekto__input {
  width: 100%;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(0, 0, 0, 0.32);
  color: var(--text);
  font: 500 15px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

.seekto__input:focus {
  outline: none;
  border-color: var(--accent);
}

.seekto__input--bad {
  border-color: rgba(255, 123, 114, 0.6);
}

.seekto__hint,
.seekto__range {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}

.seekto__hint--bad {
  color: var(--warn);
}

.seekto__buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 2px;
}
</style>
