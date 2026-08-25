<template>
  <div class="controls">
    <SeekBar
      :current-time="state.currentTime"
      :duration="state.duration"
      :marks="state.marks"
      :segments="state.segments"
      :trim="trim"
      @seek="(ms, preview) => $emit('seek', ms, preview)"
      @scrubbing="(on) => $emit('scrubbing', on)"
      @trim="(range) => $emit('trim', range)"
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
        :enabled="state.hasAudio && state.rate === 1"
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

      <button
        v-if="state.zoomed"
        type="button"
        class="chip chip--button chip--zoom"
        title="Reset zoom (double-click the video, or Z)"
        @click="$emit('reset-zoom')"
      >
        <AppIcon name="zoomIn" :size="13" />
        <span class="chip__text">{{ state.zoom.toFixed(1) }}&times;</span>
      </button>

      <PopMenu
        class="ratemenu"
        label="Playback speed"
        :chip="rateLabel"
        :active="state.rate !== 1"
        :options="rateOptions"
        :value="state.rate"
        @choose="(v) => $emit('rate', v)"
        @open-change="(o) => setMenuOpen('rate', o)"
      />

      <PopMenu
        v-if="showStreamChip"
        class="streammenu"
        label="Video stream"
        :chip="streamChip"
        :title="`Video stream: ${currentStreamName}. Click to choose.`"
        :options="streamOptions"
        :value="state.streamMode"
        @choose="(m) => $emit('stream', m)"
        @open-change="(o) => setMenuOpen('stream', o)"
      />

      <button
        v-if="state.hasMetadata"
        type="button"
        class="ctl-btn"
        :class="{ 'ctl-btn--active': metadataOpen }"
        title="Metadata (I)"
        aria-label="Metadata"
        :aria-pressed="metadataOpen ? 'true' : 'false'"
        @click="$emit('toggle-metadata')"
      >
        <AppIcon name="layers" :size="20" />
      </button>

      <button
        type="button"
        class="ctl-btn"
        title="Export to MP4 (E)"
        aria-label="Export to MP4"
        @click="$emit('export')"
      >
        <AppIcon name="download" :size="20" />
      </button>

      <SettingsMenu
        :settings="settings"
        :state="state"
        @patch="(p) => $emit('patch', p)"
        @stream="(m) => $emit('stream', m)"
        @overlay="(p) => $emit('overlay', p)"
        @rate="(v) => $emit('rate', v)"
        @open-change="(o) => setMenuOpen('settings', o)"
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
import PopMenu from './PopMenu.vue'
import { formatTime, formatUtc } from '../util/format.js'
import { streamChipLabel, streamOptions } from '../util/streams.js'
import { PLAYBACK_RATES } from '../player/BvrPlayer.js'

export default {
  name: 'ControlBar',
  components: { AppIcon, SeekBar, VolumeControl, SettingsMenu, PopMenu },
  props: {
    state: { type: Object, required: true },
    settings: { type: Object, required: true },
    fullscreen: { type: Boolean, default: false },
    metadataOpen: { type: Boolean, default: false },
    trim: { type: Object, default: null }
  },
  emits: [
    'toggle-play', 'skip', 'step', 'seek', 'scrubbing', 'volume', 'toggle-mute',
    'toggle-fullscreen', 'patch', 'stream', 'menu-open', 'rate', 'reset-zoom',
    'toggle-metadata', 'export', 'overlay', 'trim'
  ],
  data () {
    return { openMenus: { settings: false, stream: false, rate: false } }
  },
  computed: {
    skipSeconds () { return this.settings.skipSeconds },
    skipLabel () {
      const s = this.settings.skipSeconds
      return s >= 100 ? '99+' : String(s)
    },
    rateOptions () {
      return PLAYBACK_RATES.map((r) => ({
        value: r,
        name: `${r}×`,
        detail: r === 1 ? 'normal' : r < 1 ? 'slow' : 'fast, muted'
      }))
    },
    rateLabel () { return `${this.state.rate}×` },
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
    streamOptions () { return streamOptions(this.state) },
    streamChip () { return streamChipLabel(this.state) },
    currentStreamName () {
      const cur = this.streamOptions.find((o) => o.value === this.state.streamMode)
      return cur ? cur.label : this.state.streamMode
    }
  },
  methods: {
    /** The chrome must stay up while *any* of the popups is open. */
    setMenuOpen (which, open) {
      this.openMenus[which] = open
      this.$emit('menu-open', Object.values(this.openMenus).some(Boolean))
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

.chip--busy {
  border-color: rgba(88, 166, 255, 0.5);
  color: var(--accent);
}

.chip--zoom {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border-color: rgba(88, 166, 255, 0.5);
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
}

.chip--zoom:hover {
  background: rgba(88, 166, 255, 0.18);
}

@media (max-width: 980px) {
  .readout__frame { display: none; }
}

@media (max-width: 860px) {
  .ratemenu { display: none; }
}

/* No room for the stream chip on a phone, and dropping it here would push the
   settings and fullscreen buttons off the edge. The same picker lives in the
   settings panel, which stays reachable. */
@media (max-width: 620px) {
  .streammenu { display: none; }
}

@media (max-width: 620px) {
  .controls { padding: 36px 8px 8px; }
  .readout { margin-left: 4px; font-size: 12px; }
}
</style>
