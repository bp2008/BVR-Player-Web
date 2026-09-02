<template>
  <div class="controls">
    <SeekBar
      :current-time="state.currentTime"
      :duration="state.duration"
      :marks="state.marks"
      :segments="state.segments"
      :coverage="state.coverage"
      :trim="trim"
      @seek="(ms, preview) => $emit('seek', ms, preview)"
      @scrubbing="(on) => $emit('scrubbing', on)"
      @trim="(range) => $emit('trim', range)"
    />

    <div ref="row" class="controls__row">
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
        class="ctl-btn ctl-btn--skip"
        :title="`Forward ${skipSeconds} seconds (Right arrow)`"
        :aria-label="`Skip forward ${skipSeconds} seconds`"
        @click="$emit('skip', skipSeconds)"
      >
        <AppIcon name="forward" />
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
        v-if="settings.mainStreamJumps"
        type="button"
        class="ctl-btn"
        :title="jumpTitle(-1)"
        :aria-label="jumpTitle(-1)"
        :disabled="prevMainStart === null"
        @click="$emit('seek', prevMainStart, false)"
      >
        <AppIcon name="mainPrev" />
      </button>

      <button
        v-if="settings.mainStreamJumps"
        type="button"
        class="ctl-btn"
        :title="jumpTitle(1)"
        :aria-label="jumpTitle(1)"
        :disabled="nextMainStart === null"
        @click="$emit('seek', nextMainStart, false)"
      >
        <AppIcon name="mainNext" />
      </button>

      <VolumeControl
        ref="volume"
        :volume="state.volume"
        :muted="state.muted"
        :enabled="state.hasAudio && state.rate === 1"
        :inline="volumeInline"
        @update:volume="(v) => $emit('volume', v)"
        @toggle-mute="$emit('toggle-mute')"
        @open-change="(o) => setMenuOpen('volume', o)"
      />

      <div class="readout">
        <span class="readout__time">{{ primaryTime }}</span>
        <span class="readout__sep">/</span>
        <span class="readout__total">{{ totalTime }}</span>
        <span class="readout__frame">frame {{ (state.frameIndex + 1).toLocaleString() }} of {{ state.frameCount.toLocaleString() }}</span>
      </div>

      <!-- Everything that belongs at the far end, kept together so that when the
           row runs out of width it wraps as a block and stays right-aligned on
           the line below rather than scattering. -->
      <div class="controls__right">
        <span v-if="state.buffering" class="chip chip--busy">buffering</span>

        <button
          v-if="state.zoomed"
          type="button"
          class="ctl-hit"
          title="Reset zoom (Z)"
          aria-label="Reset zoom"
          @click="$emit('reset-zoom')"
        >
          <span class="chip chip--zoom">
            <AppIcon name="zoomIn" :size="13" />
            <span class="chip__text">{{ state.zoom.toFixed(1) }}&times;</span>
          </span>
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
          type="button"
          class="ctl-btn"
          title="Save this frame as an image (S)"
          aria-label="Save this frame as an image"
          @click="$emit('snapshot')"
        >
          <AppIcon name="photoCamera" :size="20" />
        </button>

        <button
          v-for="b in panelButtons"
          :key="b.id"
          type="button"
          class="ctl-btn"
          :class="{ 'ctl-btn--active': panelOpen[b.id] }"
          :title="b.title"
          :aria-label="b.label"
          :aria-pressed="panelOpen[b.id] ? 'true' : 'false'"
          @click="$emit('toggle-panel', b.id)"
        >
          <AppIcon :name="b.icon" :size="20" />
        </button>

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
  </div>
</template>

<script>
import AppIcon from './AppIcon.vue'
import SeekBar from './SeekBar.vue'
import VolumeControl from './VolumeControl.vue'
import PopMenu from './PopMenu.vue'
import { formatTime, formatUtc } from '../util/format.js'
import { streamChipLabel, streamOptions } from '../util/streams.js'
import { PLAYBACK_RATES } from '../player/BvrPlayer.js'
import { adjacentMainStart, mainStartPoints } from '../player/coverage.js'
import { PANELS } from '../panels/panels.js'

const PANEL_KEYS = { metadata: 'I', export: 'E', settings: '' }

export default {
  name: 'ControlBar',
  components: { AppIcon, SeekBar, VolumeControl, PopMenu },
  props: {
    state: { type: Object, required: true },
    settings: { type: Object, required: true },
    fullscreen: { type: Boolean, default: false },
    panelOpen: { type: Object, required: true },
    trim: { type: Object, default: null }
  },
  emits: [
    'toggle-play', 'skip', 'step', 'seek', 'scrubbing', 'volume', 'toggle-mute',
    'toggle-fullscreen', 'stream', 'menu-open', 'rate', 'reset-zoom',
    'toggle-panel', 'trim', 'snapshot'
  ],
  data () {
    return {
      openMenus: { stream: false, rate: false, volume: false },
      // Whether the wide volume slider is laid out in the row; measured, never
      // guessed at from a breakpoint. See measureVolumeFit.
      volumeInline: false
    }
  },
  computed: {
    /**
     * One toggle per panel, in the order the dock knows them.
     *
     * Metadata used to be dropped for a recording that carried none, on the
     * grounds that there was nothing to show. That stopped being true: the panel
     * describes the file, the stream shapes and the frame under the playhead
     * whether or not any overlay object was ever defined, and it is where a
     * recording is exported as a report. An MP4, which never has overlay
     * metadata, would otherwise have no way to reach any of that.
     */
    panelButtons () {
      return PANELS
        .map((p) => {
          const key = PANEL_KEYS[p.id]
          return {
            id: p.id,
            icon: p.icon,
            label: p.title,
            title: key ? `${p.title} (${key})` : p.title
          }
        })
    },
    /** Where the main stream starts up; see coverage.js. */
    mainStarts () { return mainStartPoints(this.state.coverage) },
    prevMainStart () { return adjacentMainStart(this.mainStarts, this.state.currentTime, -1) },
    nextMainStart () { return adjacentMainStart(this.mainStarts, this.state.currentTime, 1) },
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
    },
    /**
     * Everything that changes how much width the row needs, as one string to
     * watch. The alternative -- re-measuring on every render -- would run three
     * forced layouts per frame of playback for a row that has not changed.
     * A resize observer catches the rest.
     */
    rowContents () {
      const s = this.state
      return [
        s.status, s.buffering, s.zoomed, this.rateLabel, this.showStreamChip,
        this.streamChip, this.panelButtons.length, this.settings.mainStreamJumps,
        this.skipLabel, this.primaryTime.length, this.totalTime.length, s.frameCount
      ].join('|')
    }
  },
  watch: {
    /**
     * Anything that changes what the row has to hold changes whether it fits.
     * After the render that the change causes, not before it, and in the same
     * microtask checkpoint so the answer is still in front of the paint.
     */
    rowContents () { this.$nextTick(this.measureVolumeFit) }
  },
  mounted () {
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this.measureVolumeFit())
      this._ro.observe(this.$refs.row)
    }
    this.measureVolumeFit()
  },
  beforeUnmount () {
    if (this._ro) this._ro.disconnect()
  },
  methods: {
    /**
     * Whether the wide volume slider costs the row a line.
     *
     * Both arrangements are laid out and measured here, within one task and
     * before anything is painted, so what the viewer sees is only ever the
     * answer. `<=` rather than `===` is deliberate: the slider is shown whenever
     * it is free, including on a row that has already wrapped for other reasons
     * and has slack on one of its lines.
     *
     * Called straight from the resize observer rather than out of a frame
     * callback, and that is the whole of it: an observer runs inside the frame
     * that resized, after its layout and before its paint, so the class this
     * settles on is the one that frame is drawn with. Handing the work to the
     * *next* frame instead -- which is what this used to do, to keep the
     * re-entrant pass out of the observer's callback -- paints one frame of the
     * old arrangement at the new width every time the row crosses the point
     * where the slider stops fitting, which reads as the bar flicking an extra
     * line deep as you drag the window edge past it.
     *
     * The re-entrant pass it was avoiding is harmless: flipping the class
     * resizes the row, so the observer fires once more in the same frame, and
     * that pass measures both arrangements exactly as this one did, agrees with
     * it, and changes nothing. The loop is two deep and terminates because the
     * answer does not depend on the state it is asked from.
     */
    measureVolumeFit () {
      const row = this.$refs.row
      const vol = this.$refs.volume && this.$refs.volume.$el
      // Mid-transition -- a fullscreen change, a panel opening -- there is
      // nothing meaningful to measure and the next resize will ask again.
      if (!row || !vol || !row.offsetWidth) return

      const CLASS = 'volume--inline'
      const had = vol.classList.contains(CLASS)
      vol.classList.add(CLASS)
      const withSlider = row.offsetHeight
      vol.classList.remove(CLASS)
      const without = row.offsetHeight
      vol.classList.toggle(CLASS, had)

      const fits = withSlider <= without
      if (fits !== this.volumeInline) this.volumeInline = fits
    },
    /**
     * A disabled button that says nothing reads as a broken one, and the two
     * reasons this one goes dead are worth telling apart: a recording with no
     * main-stream transitions at all, and simply having run out of them in that
     * direction.
     */
    jumpTitle (dir) {
      const where = dir < 0 ? 'back' : 'forward'
      const key = dir < 0 ? 'Ctrl+,' : 'Ctrl+.'
      if (!this.mainStarts.length) {
        return `Jump ${where} to where the main stream starts — this recording has none to jump to`
      }
      const target = dir < 0 ? this.prevMainStart : this.nextMainStart
      if (target === null) return `No main-stream start further ${where}`
      return `Jump ${where} to where the main stream starts, ${formatTime(target, false)} (${key})`
    },
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

/*
 * Wrapping rather than hiding.
 *
 * There is never enough width for a transport, a readout, two pickers and half
 * a dozen toggles on a phone, and the answer used to be a stack of media queries
 * that dropped whichever control was least missed at each breakpoint. A viewer
 * on a narrow window then had no speed control at all. So the row wraps instead:
 * everything stays reachable, and the bar grows a line when it has to.
 *
 * `align-items: stretch` is the other half. Each item is left at its natural
 * height by way of `min-height`, which lets the tallest on a line -- the play
 * button, at 44px -- set that line's height, and every other item then fills it.
 * They stay centred because each one is a flex container in its own right, so
 * the extra height goes above and below the icon rather than into it: the
 * clickable area of everything on a line is as tall as the line.
 */
.controls__row {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 4px 2px;
  margin-top: 4px;
}

.controls__right {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  justify-content: flex-end;
  gap: 4px 2px;
  /* Right-aligned on the first line if it fits there, and on its own line if it
     does not. */
  margin-left: auto;
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
  align-self: center;
  align-items: baseline;
  margin-left: 8px;
  font: 500 13px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  line-height: 1.25em;
  word-break: break-word;
}

	.readout > * {
		white-space: nowrap;
        margin-left: 5px;
	}

	.readout > *:first-child {
		margin-left: 0px;
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
  font-size: 11px;
}

.ctl-hit:hover .chip--zoom {
  background: rgba(88, 166, 255, 0.18);
}

@media (max-width: 620px) {
  .controls { padding: 36px 8px 8px; }
  .readout { margin-left: 4px; font-size: 12px; }
}
</style>
