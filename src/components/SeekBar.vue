<template>
  <div
    ref="track"
    class="seekbar"
    :class="{ 'seekbar--trimming': trim }"
    role="slider"
    tabindex="0"
    :aria-valuemin="0"
    :aria-valuemax="Math.round(duration)"
    :aria-valuenow="Math.round(currentTime)"
    :aria-valuetext="valueText"
    aria-label="Seek"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @pointerleave="hoverRatio = null"
    @keydown="onKey"
  >
    <div class="seekbar__hit"></div>
    <div class="seekbar__rail">
      <!-- The trim range dims everything outside it, so the selection reads as
           the part of the recording that will be kept. -->
      <template v-if="trim">
        <div class="seekbar__outside" :style="{ left: 0, width: trimStartPct + '%' }"></div>
        <div class="seekbar__outside" :style="{ left: trimEndPct + '%', right: 0 }"></div>
        <div class="seekbar__range" :style="{ left: trimStartPct + '%', width: (trimEndPct - trimStartPct) + '%' }"></div>
      </template>

      <div class="seekbar__fill" :style="{ width: pct + '%' }"></div>
      <div v-if="hoverRatio !== null" class="seekbar__hover" :style="{ width: hoverRatio * 100 + '%' }"></div>

      <!-- Segment starts: a recording that stopped and resumed, or a camera that
           reconnected. Worth showing because time may have jumped there. -->
      <div
        v-for="(seg, i) in segmentTicks"
        :key="'s' + i"
        class="seekbar__seg"
        :style="{ left: seg + '%' }"
        title="Recording segment start"
      ></div>

      <div
        v-for="(mark, i) in markTicks"
        :key="'m' + i"
        class="seekbar__mark"
        :style="{ left: mark + '%' }"
        title="Mark"
      ></div>

      <div class="seekbar__knob" :style="{ left: pct + '%' }"></div>

      <template v-if="trim">
        <button
          type="button"
          class="seekbar__handle seekbar__handle--in"
          :style="{ left: trimStartPct + '%' }"
          aria-label="Trim start"
          @pointerdown.stop="onHandleDown('in', $event)"
        ></button>
        <button
          type="button"
          class="seekbar__handle seekbar__handle--out"
          :style="{ left: trimEndPct + '%' }"
          aria-label="Trim end"
          @pointerdown.stop="onHandleDown('out', $event)"
        ></button>
      </template>
    </div>

    <div
      v-if="hoverRatio !== null && duration > 0"
      class="seekbar__tip"
      :style="{ left: hoverRatio * 100 + '%' }"
    >{{ formatTime(hoverRatio * duration, false) }}</div>
  </div>
</template>

<script>
import { formatTime } from '../util/format.js'

export default {
  name: 'SeekBar',
  props: {
    currentTime: { type: Number, default: 0 },
    duration: { type: Number, default: 0 },
    marks: { type: Array, default: () => [] },
    segments: { type: Array, default: () => [] },
    trim: { type: Object, default: null }
  },
  emits: ['seek', 'scrubbing', 'trim'],
  data () {
    return { dragging: false, hoverRatio: null, handle: null }
  },
  computed: {
    pct () {
      if (!this.duration) return 0
      return Math.min(100, Math.max(0, (this.currentTime / this.duration) * 100))
    },
    /**
     * Ticks are capped: a long recording can hold thousands of marks, and past a
     * few hundred they stop being individually meaningful and start costing a
     * DOM node each.
     */
    markTicks () { return this.ticks(this.marks) },
    segmentTicks () { return this.ticks(this.segments) },
    trimStartPct () {
      if (!this.trim || !this.duration) return 0
      return Math.min(100, Math.max(0, (this.trim.start / this.duration) * 100))
    },
    trimEndPct () {
      if (!this.trim || !this.duration) return 100
      return Math.min(100, Math.max(0, (this.trim.end / this.duration) * 100))
    },
    valueText () {
      return `${formatTime(this.currentTime, false)} of ${formatTime(this.duration, false)}`
    }
  },
  methods: {
    formatTime,
    ticks (list) {
      if (!this.duration || !list.length) return []
      const LIMIT = 200
      const step = Math.ceil(list.length / LIMIT)
      const out = []
      for (let i = 0; i < list.length; i += step) {
        out.push(Math.min(100, Math.max(0, (list[i].ts / this.duration) * 100)))
      }
      return out
    },
    ratioAt (event) {
      const rect = this.$refs.track.getBoundingClientRect()
      if (rect.width <= 0) return 0
      return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    },
    onHandleDown (which, event) {
      event.preventDefault()
      this.$refs.track.setPointerCapture(event.pointerId)
      this.handle = which
      // A handle drag is a scrub like any other: the playhead follows it, so the
      // picture shows what is actually being trimmed to instead of leaving the
      // choice to be made blind.
      this.$emit('scrubbing', true)
      this.moveHandle(this.ratioAt(event))
    },
    onDown (event) {
      if (!this.duration) return
      event.preventDefault()
      this.$refs.track.setPointerCapture(event.pointerId)
      this.dragging = true
      this.$emit('scrubbing', true)
      const r = this.ratioAt(event)
      this.hoverRatio = r
      this.$emit('seek', r * this.duration, true)
    },
    onMove (event) {
      if (!this.duration) return
      const r = this.ratioAt(event)
      this.hoverRatio = r
      if (this.handle) { this.moveHandle(r); return }
      if (this.dragging) this.$emit('seek', r * this.duration, true)
    },
    moveHandle (ratio) {
      const at = ratio * this.duration
      // The two handles cannot cross; each stops a moment short of the other.
      const gap = Math.min(500, this.duration / 50)
      const next = this.handle === 'in'
        ? { start: Math.min(at, this.trim.end - gap), end: this.trim.end }
        : { start: this.trim.start, end: Math.max(at, this.trim.start + gap) }
      this.$emit('trim', next)
      // Where the handle landed rather than where the pointer is, so the frame
      // on screen still matches the marker once the two ends start pushing each
      // other along.
      this.$emit('seek', this.handle === 'in' ? next.start : next.end, true)
    },
    onUp (event) {
      if (this.handle) {
        this.handle = null
        try { this.$refs.track.releasePointerCapture(event.pointerId) } catch { /* pointer already gone */ }
        this.$emit('scrubbing', false)
        return
      }
      if (!this.dragging) return
      this.dragging = false
      try { this.$refs.track.releasePointerCapture(event.pointerId) } catch { /* pointer already gone */ }
      this.$emit('seek', this.ratioAt(event) * this.duration, true)
      this.$emit('scrubbing', false)
    },
    onKey (event) {
      const big = this.duration / 10
      let delta = 0
      if (event.key === 'ArrowLeft') delta = -5000
      else if (event.key === 'ArrowRight') delta = 5000
      else if (event.key === 'PageDown') delta = -big
      else if (event.key === 'PageUp') delta = big
      else if (event.key === 'Home') { event.stopPropagation(); event.preventDefault(); this.$emit('seek', 0, false); return }
      else if (event.key === 'End') { event.stopPropagation(); event.preventDefault(); this.$emit('seek', this.duration, false); return }
      if (!delta) return
      event.stopPropagation()
      event.preventDefault()
      this.$emit('seek', Math.min(this.duration, Math.max(0, this.currentTime + delta)), false)
    }
  }
}
</script>

<style scoped>
.seekbar {
  position: relative;
  height: 18px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
  outline: none;
}

.seekbar__hit {
  position: absolute;
  inset: -6px 0;
}

.seekbar__rail {
  position: relative;
  width: 100%;
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
  transition: height 0.12s ease;
}

.seekbar:hover .seekbar__rail,
.seekbar:focus-visible .seekbar__rail,
.seekbar--trimming .seekbar__rail {
  height: 7px;
}

.seekbar__fill,
.seekbar__hover,
.seekbar__range,
.seekbar__outside {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
}

.seekbar__fill {
  background: var(--accent);
  z-index: 1;
}

.seekbar__hover {
  background: rgba(255, 255, 255, 0.28);
}

.seekbar__outside {
  background: rgba(0, 0, 0, 0.55);
  z-index: 2;
}

.seekbar__range {
  background: rgba(210, 153, 34, 0.34);
  box-shadow: inset 0 0 0 1px rgba(210, 153, 34, 0.7);
  z-index: 2;
}

.seekbar__seg,
.seekbar__mark {
  position: absolute;
  top: 50%;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  transform: translateY(-50%);
  z-index: 3;
  pointer-events: none;
}

.seekbar__seg {
  height: 11px;
  background: rgba(255, 255, 255, 0.55);
}

.seekbar__mark {
  height: 13px;
  width: 3px;
  margin-left: -1.5px;
  background: var(--warn);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
}

.seekbar__knob {
  position: absolute;
  top: 50%;
  width: 13px;
  height: 13px;
  margin-left: -6.5px;
  border-radius: 50%;
  background: var(--accent);
  transform: translateY(-50%) scale(0);
  transition: transform 0.12s ease;
  z-index: 4;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
}

.seekbar:hover .seekbar__knob,
.seekbar:focus-visible .seekbar__knob {
  transform: translateY(-50%) scale(1);
}

.seekbar__handle {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 20px;
  margin-left: -6px;
  padding: 0;
  border: 1px solid rgba(0, 0, 0, 0.5);
  border-radius: 3px;
  background: var(--warn);
  transform: translateY(-50%);
  cursor: ew-resize;
  z-index: 5;
}

.seekbar__handle:hover {
  background: #e8b53a;
}

.seekbar__handle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.seekbar__tip {
  position: absolute;
  bottom: 22px;
  transform: translateX(-50%);
  padding: 3px 7px;
  border-radius: 5px;
  background: rgba(12, 14, 18, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.12);
  font: 500 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #e8eaed;
  pointer-events: none;
  white-space: nowrap;
}
</style>
