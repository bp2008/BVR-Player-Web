<template>
  <div class="volume" :class="{ 'volume--disabled': !enabled }">
    <button
      type="button"
      class="ctl-btn"
      :title="muted || volume === 0 ? 'Unmute (M)' : 'Mute (M)'"
      :aria-label="muted || volume === 0 ? 'Unmute' : 'Mute'"
      :disabled="!enabled"
      @click="$emit('toggle-mute')"
    >
      <AppIcon :name="iconName" />
    </button>
    <input
      class="volume__slider"
      type="range"
      min="0"
      max="100"
      step="1"
      :value="muted ? 0 : Math.round(volume * 100)"
      :disabled="!enabled"
      aria-label="Volume"
      @input="$emit('update:volume', Number($event.target.value) / 100)"
      @keydown.stop
    />
  </div>
</template>

<script>
import AppIcon from './AppIcon.vue'

export default {
  name: 'VolumeControl',
  components: { AppIcon },
  props: {
    volume: { type: Number, default: 1 },
    muted: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true }
  },
  emits: ['update:volume', 'toggle-mute'],
  computed: {
    iconName () {
      if (this.muted || this.volume === 0) return 'volumeMute'
      return this.volume < 0.5 ? 'volumeLow' : 'volumeHigh'
    }
  }
}
</script>

<style scoped>
.volume {
  display: flex;
  align-items: center;
}

.volume--disabled {
  opacity: 0.45;
}

.volume__slider {
  width: 0;
  opacity: 0;
  margin: 0;
  transition: width 0.16s ease, opacity 0.16s ease, margin 0.16s ease;
  accent-color: var(--accent);
  cursor: pointer;
  height: 18px;
}

.volume:hover .volume__slider,
.volume:focus-within .volume__slider {
  width: 78px;
  opacity: 1;
  margin-right: 6px;
}

@media (max-width: 700px) {
  .volume__slider { display: none; }
}
</style>
