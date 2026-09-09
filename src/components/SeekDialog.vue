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
      aria-label="Seek to a position"
      @submit.prevent="submit"
    >
      <h2 class="seekto__title">Seek to</h2>

      <!-- Only drawn where there is a choice to make. Both of the readings
           beside elapsed can be missing: an MP4, or a BVR whose header carries
           no start time, has nothing to date from, and nothing can be counted in
           frames until there is a frame table to count in. -->
      <div v-if="modes.length > 1" class="seekto__modes" role="radiogroup" aria-label="What to type">
        <button
          v-for="m in modes"
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
        :class="{ 'seekto__input--bad': text.trim() !== '' && target === null }"
        type="text"
        inputmode="numeric"
        spellcheck="false"
        autocomplete="off"
        :placeholder="placeholder"
        :aria-label="fieldLabel"
        :aria-invalid="target === null ? 'true' : 'false'"
        @input="edited = true"
        @keydown.enter.stop.prevent="submit"
        @keydown.esc.stop.prevent="$emit('close')"
        @keydown.stop
      />

      <p class="seekto__hint" :class="{ 'seekto__hint--bad': hintBad }">{{ hint }}</p>
      <p class="seekto__range">{{ rangeLabel }}</p>

      <div class="seekto__buttons">
        <button type="button" class="btn" @click="$emit('close')">Cancel</button>
        <button type="submit" class="btn btn--accent" :disabled="target === null">Go</button>
      </div>
    </form>
  </div>
</template>

<script>
import { formatTime, formatUtc, parseClock, parseFrame, parseTime } from '../util/format.js'
import { frameIndexForTime } from '../bvr/indexer.js'

/**
 * Type a position and go there.
 *
 * The scrub bar is a fraction of a bar wide per minute of recording, which is
 * fine for finding roughly where something is and useless for going back to the
 * exact frame a colleague quoted. This is the other half: every reading the
 * control bar puts on screen -- elapsed, wall clock, frame number -- accepted
 * back, at the precision it is shown to, in the shape the app itself writes it.
 *
 * It is a dialog rather than a panel, which the rest of the app avoids, because
 * it is one field answered once. A panel would outlive the question.
 *
 * The clip is the bound. Anything readable outside it lands on the nearest end
 * rather than being refused: a value one frame past the end is a real answer to
 * "where does this stop", and there is nowhere else it could have meant. Each
 * mode clamps in the units it was typed in and only then says what position it
 * arrived at -- frame 9,999 is past the last frame whatever time that works out
 * to, and clamping it as a time first would have to invent one to clamp.
 */
export default {
  name: 'SeekDialog',
  props: {
    currentTime: { type: Number, default: 0 },
    duration: { type: Number, default: 0 },
    /** Unix ms of the first frame, or 0 where the recording does not say. */
    startUtc: { type: Number, default: 0 },
    /**
     * The frame table being played. Frame numbers only mean anything against one
     * of these -- an hour of sub stream counts seventy thousand frames where the
     * triggered main stream counts six -- so the sequence on screen is the one
     * they are read and written in.
     */
    pstream: { type: Object, default: null },
    /** Which reading to open on; the control bar's own time display. */
    initialMode: { type: String, default: 'elapsed' }
  },
  emits: ['seek', 'close'],
  data () {
    const canClock = this.startUtc > 0
    return {
      mode: this.initialMode === 'clock' && canClock ? 'clock' : 'elapsed',
      text: '',
      // Whether the viewer has touched the field. Until they have, it follows
      // the playhead; see the `currentTime` watcher.
      edited: false
    }
  },
  computed: {
    canClock () { return this.startUtc > 0 },
    canFrame () { return this.frameCount > 0 },
    frameCount () { return this.pstream ? this.pstream.count : 0 },
    /** The readings this recording can actually be addressed in. */
    modes () {
      return [
        { value: 'elapsed', label: 'Elapsed', ok: true },
        { value: 'clock', label: 'Date & time', ok: this.canClock },
        { value: 'frame', label: 'Frame', ok: this.canFrame }
      ].filter((m) => m.ok)
    },
    /**
     * What the field says, before the clip has had any say: a frame number in
     * frame mode, media milliseconds in the other two, and null for anything
     * unreadable -- which is most of the keystrokes it takes to type either.
     */
    typed () {
      const s = this.text.trim()
      if (!s) return null
      if (this.mode === 'frame') return parseFrame(s)
      if (this.mode === 'clock') {
        const utc = parseClock(s)
        return utc === null ? null : utc - this.startUtc
      }
      return parseTime(s)
    },
    /** The same, held inside the recording, still in the units it was typed in. */
    bounded () {
      if (this.typed === null) return null
      if (this.mode === 'frame') return Math.min(this.frameCount, Math.max(1, this.typed))
      return Math.min(this.duration, Math.max(0, this.typed))
    },
    /** Where a seek would land, in media time, or null if nothing readable. */
    target () {
      if (this.bounded === null) return null
      return this.mode === 'frame' ? this.pstream.ts[this.bounded - 1] : this.bounded
    },
    /** Whether what was typed pointed outside the recording, and which way. */
    clipped () { return this.typed !== null && this.typed !== this.bounded },
    clippedLow () { return this.clipped && this.typed < this.bounded },
    placeholder () {
      if (this.mode === 'clock') return 'yyyy-mm-dd hh:mm:ss.mmm'
      return this.mode === 'frame' ? 'frame number' : 'h:mm:ss.mmm'
    },
    fieldLabel () {
      if (this.mode === 'clock') return 'Date and time'
      return this.mode === 'frame' ? 'Frame number' : 'Position in the recording'
    },
    hintBad () { return this.target === null || this.clipped },
    /**
     * One line that always says what pressing Go will do, because for most of
     * the keystrokes it takes to type a timestamp the field holds something
     * unreadable, and a field that only complains once you submit is worse than
     * one that keeps up.
     */
    hint () {
      if (!this.text.trim()) return this.emptyHint
      if (this.target === null) return this.badHint
      if (this.clipped) {
        const end = this.clippedLow ? 'start' : 'end'
        return `Outside this recording — Go lands on the ${end}, ${this.describe(this.target)}.`
      }
      return `Go to ${this.describe(this.target)}.`
    },
    emptyHint () {
      if (this.mode === 'frame') return 'Type a frame number.'
      return 'Type a position, or the moment it happened.'
    },
    badHint () {
      if (this.mode === 'clock') return 'Not a date and time. Try 2026-08-25 17:04:31.500'
      if (this.mode === 'frame') return 'Not a frame number. Try 254'
      return 'Not a position. Try 1:04:31.500, 4:31.5 or 271'
    },
    /**
     * The bounds, in the units being typed. Frames get their own line rather
     * than going through `describe`: a recording's duration runs one frame's
     * worth past the last frame's own timestamp, so quoting the two together
     * would put a time on the end frame that disagrees with the one the readout
     * shows once you are there.
     */
    rangeLabel () {
      if (this.mode === 'frame') {
        return `This recording runs frame 1 to frame ${this.frameCount.toLocaleString()}.`
      }
      return `This recording runs ${this.describe(0)} to ${this.describe(this.duration)}.`
    }
  },
  watch: {
    /**
     * An untouched field shows the playhead, wherever it has got to.
     *
     * Not merely a nicety: the dialog is opened by pausing, and the clock
     * settles onto the frame actually on screen a tick after the pause, which
     * is after this has been mounted and seeded. Left alone, the field opened
     * holding a position a dozen frames ahead of the one the readout beside it
     * was showing -- and in frame mode that disagreement is spelt out in whole
     * numbers. Anything the viewer types wins from the first keystroke.
     */
    currentTime (ms) {
      if (!this.edited) this.text = this.fieldText(this.mode, ms)
    }
  },
  created () {
    // Not seeded in data(): writing the field the way the opening mode reads it
    // back is the same job `setMode` does on every switch afterwards, and it
    // needs the computed properties that describe the mode.
    this.text = this.fieldText(this.mode, this.currentTime)
  },
  mounted () {
    this.focusInput()
  },
  methods: {
    /** The frame at a media time, one-based, as the control bar counts them. */
    frameAt (ms) {
      return frameIndexForTime(this.pstream, ms) + 1
    },
    /** A position written so that this mode's own parser reads it straight back. */
    fieldText (mode, ms) {
      const at = Math.min(this.duration, Math.max(0, ms))
      if (mode === 'clock') return formatUtc(this.startUtc + at)
      if (mode === 'frame') return String(this.frameAt(at))
      return formatTime(at)
    },
    /**
     * A position in prose, in the current mode. Frames carry their time along
     * with them: a frame number on its own says where in the recording it is
     * only to someone who already knows the frame rate.
     */
    describe (ms) {
      if (this.mode === 'clock') return formatUtc(this.startUtc + ms)
      if (this.mode === 'frame') return `frame ${this.frameAt(ms).toLocaleString()}, ${formatTime(ms)}`
      return formatTime(ms)
    },
    /**
     * Switching reading keeps the position, not the text. Anything readable is
     * carried across as the moment it named; anything half-typed is dropped for
     * the playhead, since there is no position in it to preserve.
     */
    setMode (mode) {
      if (mode === this.mode) return
      const at = this.target === null ? this.currentTime : this.target
      this.mode = mode
      this.text = this.fieldText(mode, at)
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
