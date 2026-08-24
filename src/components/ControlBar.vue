<template>
  <div class="controls">
    <SeekBar
      :current-time="state.currentTime"
      :duration="state.duration"
      @seek="(ms, preview) => $emit('seek', ms, preview)"
      @scrubbing="(on) => $emit('scrubbing', on)"
    />

    <div class="controls__row">
      <button
        type="button"
        class="ctl-btn ctl-btn--primary"
        :title="state.playing ? 'Pause (Space)' : 'Play (Space)'"
        :aria-label="state.playing ? 'Pause' : 'Play'"
        @click="$emit('toggle-play')"
      >
        <AppIcon :name="state.playing ? 'pause' : 'play'" :size="26" />
      </button>

      <button
        type="button"
        class="ctl-btn ctl-btn--skip"
        :title="`Back ${skipSeconds} seconds (Left arrow)`"
        :aria-label="`Skip back ${skipSeconds} seconds`"
        @click="$emit('skip', -skipSeconds)"
      >
        <AppIcon name="rewind" />
        <span class="ctl-btn__num">{{ skipLabel }}</span>
      </button>

      <button
        type="button"
        class="ctl-btn"
        title="Previous frame (,)"
        aria-label="Previous frame"
        @click="$emit('step', -1)"
      >
        <AppIcon name="stepBack" :size="20" />
      </button>

      <button
        type="button"
        class="ctl-btn"
        title="Next frame (.)"
        aria-label="Next frame"
        @click="$emit('step', 1)"
      >
        <AppIcon name="stepForward" :size="20" />
      </button>

      <button
        type="button"
        class="ctl-btn ctl-btn--skip"
        :title="`Forward ${skipSeconds} seconds (Right arrow)`"
        :aria-label="`Skip forward ${skipSeconds} seconds`"
        @click="$emit('skip', skipSeconds)"
      >
        <AppIcon name="forward" />
        <span class="ctl-btn__num">{{ skipLabel }}</span>
      </button>

      <VolumeControl
        :volume="state.volume"
        :muted="state.muted"
        :enabled="state.hasAudio"
        @update:volume="(v) => $emit('volume', v)"
        @toggle-mute="$emit('toggle-mute')"
      />

      <div class="readout">
        <span class="readout__time">{{ primaryTime }}</span>
        <span class="readout__sep">/</span>
        <span class="readout__total">{{ totalTime }}</span>
        <span class="readout__frame">frame {{ (state.frameIndex + 1).toLocaleString() }} of {{ state.frameCount.toLocaleString() }}</span>
      </div>

      <div class="controls__spacer"></div>

      <span v-if="state.buffering" class="chip chip--busy">buffering</span>
      <span v-if="showStreamChip" class="chip">{{ shortStream }}</span>

      <SettingsMenu
        :settings="settings"
        :state="state"
        @patch="(p) => $emit('patch', p)"
        @stream="(m) => $emit('stream', m)"
        @open-change="(o) => $emit('menu-open', o)"
      />

      <button
        type="button"
        class="ctl-btn"
        :title="fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'"
        :aria-label="fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'"
        @click="$emit('toggle-fullscreen')"
      >
        <AppIcon :name="fullscreen ? 'fullscreenExit' : 'fullscreen'" />
      </button>
    </div>
  </div>
</template>

<script>
import AppIcon from './AppIcon.vue'
import SeekBar from './SeekBar.vue'
import VolumeControl from './VolumeControl.vue'
import SettingsMenu from './SettingsMenu.vue'
import { formatTime, formatUtc } from '../util/format.js'

export default {
  name: 'ControlBar',
  components: { AppIcon, SeekBar, VolumeControl, SettingsMenu },
  props: {
    state: { type: Object, required: true },
    settings: { type: Object, required: true },
    fullscreen: { type: Boolean, default: false }
  },
  emits: [
    'toggle-play', 'skip', 'step', 'seek', 'scrubbing', 'volume',
    'toggle-mute', 'toggle-fullscreen', 'patch', 'stream', 'menu-open'
  ],
  computed: {
    skipSeconds () { return this.settings.skipSeconds },
    skipLabel () {
      const s = this.settings.skipSeconds
      return s >= 100 ? '99+' : String(s)
    },
    useClock () {
      return this.settings.timeDisplay === 'clock' && this.state.startUtc > 0
    },
    primaryTime () {
      if (this.useClock && this.state.currentUtc) return formatUtc(this.state.currentUtc)
      return formatTime(this.state.currentTime)
    },
    totalTime () {
      if (this.useClock && this.state.startUtc) {
        return formatUtc(this.state.startUtc + this.state.duration, false)
      }
      return formatTime(this.state.duration)
    },
    showStreamChip () {
      return this.state.hasMainStream && this.state.hasSubStream
    },
    shortStream () {
      if (this.state.streamMode === 'sub') return `sub ${this.state.width}x${this.state.height}`
      if (this.state.streamMode === 'main') return `main ${this.state.width}x${this.state.height}`
      return `auto ${this.state.width}x${this.state.height}`
    }
  }
}
</script>

<style scoped>
.controls {
  padding: 0 14px 10px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.88) 0%, rgba(0, 0, 0, 0.62) 55%, rgba(0, 0, 0, 0) 100%);
  padding-top: 44px;
}

.controls__row {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 4px;
}

.controls__spacer {
  flex: 1 1 auto;
  min-width: 8px;
}

.ctl-btn--skip {
  position: relative;
}

.ctl-btn__num {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -38%);
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.2px;
  pointer-events: none;
}

.readout {
  display: flex;
  align-items: baseline;
  gap: 5px;
  margin-left: 8px;
  font: 500 13px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.readout__sep,
.readout__total {
  color: var(--text-dim);
}

.readout__frame {
  margin-left: 10px;
  font-size: 11px;
  color: var(--text-dim);
}

.chip {
  padding: 3px 8px;
  margin-right: 4px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
}

.chip--busy {
  border-color: rgba(88, 166, 255, 0.5);
  color: var(--accent);
}

@media (max-width: 860px) {
  .readout__frame { display: none; }
}

@media (max-width: 620px) {
  .controls { padding: 36px 8px 8px; }
  .chip { display: none; }
  .readout { margin-left: 4px; font-size: 12px; }
}
</style>
