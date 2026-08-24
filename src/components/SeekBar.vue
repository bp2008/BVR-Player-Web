<template>
  <div
    ref="track"
    class="seekbar"
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
      <div class="seekbar__fill" :style="{ width: pct + '%' }"></div>
      <div v-if="hoverRatio !== null" class="seekbar__hover" :style="{ width: hoverRatio * 100 + '%' }"></div>
      <div class="seekbar__knob" :style="{ left: pct + '%' }"></div>
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
    duration: { type: Number, default: 0 }
  },
  emits: ['seek', 'scrubbing'],
  data () {
    return { dragging: false, hoverRatio: null }
  },
  computed: {
    pct () {
      if (!this.duration) return 0
      return Math.min(100, Math.max(0, (this.currentTime / this.duration) * 100))
    },
    valueText () {
      return `${formatTime(this.currentTime, false)} of ${formatTime(this.duration, false)}`
    }
  },
  methods: {
    formatTime,
    ratioAt (event) {
      const rect = this.$refs.track.getBoundingClientRect()
      if (rect.width <= 0) return 0
      return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
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
      if (this.dragging) this.$emit('seek', r * this.duration, true)
    },
    onUp (event) {
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
.seekbar:focus-visible .seekbar__rail {
  height: 7px;
}

.seekbar__fill,
.seekbar__hover {
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
  z-index: 2;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
}

.seekbar:hover .seekbar__knob,
.seekbar:focus-visible .seekbar__knob {
  transform: translateY(-50%) scale(1);
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
