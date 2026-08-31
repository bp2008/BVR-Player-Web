<template>
  <div class="spanel">
    <h3 class="spanel__h">Playback</h3>

    <label class="spanel__row spanel__row--toggle">
      <span class="spanel__label">
        Play on open
        <em class="spanel__sub">Start as soon as a recording is ready</em>
      </span>
      <input
        type="checkbox"
        class="spanel__check"
        :checked="settings.autoplay"
        @change="emitPatch({ autoplay: $event.target.checked })"
        @keydown.stop
        @dblclick.stop
      />
    </label>

    <label class="spanel__row spanel__row--toggle">
      <span class="spanel__label">Loop playback</span>
      <input
        type="checkbox"
        class="spanel__check"
        :checked="settings.loop"
        @change="emitPatch({ loop: $event.target.checked })"
        @keydown.stop
        @dblclick.stop
      />
    </label>

    <label class="spanel__row">
      <span class="spanel__label">Playback speed</span>
      <select
        class="settings__select"
        :value="state.rate"
        @change="$emit('rate', Number($event.target.value))"
        @keydown.stop
        @dblclick.stop
      >
        <option v-for="r in rates" :key="r" :value="r">{{ r }}x{{ r === 1 ? '' : ' (muted)' }}</option>
      </select>
    </label>

    <label class="spanel__row">
      <span class="spanel__label">Skip interval</span>
      <span class="spanel__control">
        <input
          class="settings__number"
          type="number"
          inputmode="numeric"
          min="1"
          max="600"
          step="1"
          :value="settings.skipSeconds"
          @input="onSkipInput"
          @change="onSkipCommit"
          @keydown.stop
          @dblclick.stop
        />
        <span class="spanel__unit">sec</span>
      </span>
    </label>

    <h3 class="spanel__h">Controls</h3>

    <label class="spanel__row spanel__row--toggle">
      <span class="spanel__label">
        Always show the controls
        <em class="spanel__sub">{{ chromeSummary }}</em>
      </span>
      <input
        type="checkbox"
        class="spanel__check"
        :checked="settings.alwaysShowControls"
        @change="emitPatch({ alwaysShowControls: $event.target.checked })"
        @keydown.stop
        @dblclick.stop
      />
    </label>

    <label class="spanel__row spanel__row--toggle">
      <span class="spanel__label">
        Main-stream jump buttons
        <em class="spanel__sub">{{ mainJumpSummary }}</em>
      </span>
      <input
        type="checkbox"
        class="spanel__check"
        :checked="settings.mainStreamJumps"
        @change="emitPatch({ mainStreamJumps: $event.target.checked })"
        @keydown.stop
        @dblclick.stop
      />
    </label>

    <h3 class="spanel__h">Seeking</h3>

    <label class="spanel__row spanel__row--toggle">
      <span class="spanel__label">
        Exact frame while scrubbing
        <em class="spanel__sub">{{ scrubExactSummary }}</em>
      </span>
      <input
        type="checkbox"
        class="spanel__check"
        :checked="settings.scrubExact"
        @change="emitPatch({ scrubExact: $event.target.checked })"
        @keydown.stop
        @dblclick.stop
      />
    </label>

    <label class="spanel__row spanel__row--toggle">
      <span class="spanel__label">
        Pause while seeking
        <em class="spanel__sub">Silences the blips of audio between seek steps</em>
      </span>
      <input
        type="checkbox"
        class="spanel__check"
        :checked="settings.pauseWhileSeeking"
        @change="emitPatch({ pauseWhileSeeking: $event.target.checked })"
        @keydown.stop
        @dblclick.stop
      />
    </label>

    <h3 class="spanel__h">Picture</h3>

    <label v-if="showStreamPicker" class="spanel__row">
      <span class="spanel__label">Video stream</span>
      <select
        class="settings__select"
        :value="state.streamMode"
        @change="$emit('stream', $event.target.value)"
        @keydown.stop
        @dblclick.stop
      >
        <option
          v-for="opt in streamOptions"
          :key="opt.value"
          :value="opt.value"
          :disabled="opt.disabled"
        >{{ opt.label }}</option>
      </select>
    </label>

    <label class="spanel__row spanel__row--toggle">
      <span class="spanel__label">
        Match declared shape
        <em class="spanel__sub">{{ aspectSummary }}</em>
      </span>
      <input
        type="checkbox"
        class="spanel__check"
        :checked="settings.matchAspect"
        @change="emitPatch({ matchAspect: $event.target.checked })"
        @keydown.stop
        @dblclick.stop
      />
    </label>

    <label class="spanel__row">
      <span class="spanel__label">Time display</span>
      <select
        class="settings__select"
        :value="settings.timeDisplay"
        @change="emitPatch({ timeDisplay: $event.target.value })"
        @keydown.stop
        @dblclick.stop
      >
        <option value="elapsed">Elapsed</option>
        <option value="clock">Wall clock</option>
      </select>
    </label>

    <h3 class="spanel__h">Snapshots</h3>

    <label class="spanel__row">
      <span class="spanel__label">
        Image format
        <em class="spanel__sub">{{ formatSummary }}</em>
      </span>
      <select
        class="settings__select"
        :value="settings.snapshotFormat"
        @change="emitPatch({ snapshotFormat: $event.target.value })"
        @keydown.stop
        @dblclick.stop
      >
        <option
          v-for="f in formats"
          :key="f.value"
          :value="f.value"
          :disabled="f.disabled"
        >{{ f.label }}</option>
      </select>
    </label>

    <label class="spanel__row">
      <span class="spanel__label">Quality</span>
      <span class="spanel__control">
        <input
          class="settings__number"
          type="number"
          inputmode="numeric"
          min="1"
          max="100"
          step="1"
          :value="settings.snapshotQuality"
          @input="onQualityInput"
          @change="onQualityCommit"
          @keydown.stop
          @dblclick.stop
        />
        <span class="spanel__unit">%</span>
      </span>
    </label>

    <label class="spanel__row spanel__row--toggle" :class="{ 'spanel__row--off': !canSaveToFolder }">
      <span class="spanel__label">
        Save into the open folder
        <em class="spanel__sub">{{ folderSummary }}</em>
      </span>
      <input
        type="checkbox"
        class="spanel__check"
        :checked="settings.snapshotToFolder && canSaveToFolder"
        :disabled="!canSaveToFolder"
        @change="emitPatch({ snapshotToFolder: $event.target.checked })"
        @keydown.stop
        @dblclick.stop
      />
    </label>

    <template v-if="state.hasMetadata">
      <h3 class="spanel__h">Overlays</h3>
      <label class="spanel__row spanel__row--toggle">
        <span class="spanel__label">
          Draw overlays
          <em class="spanel__sub">{{ overlaySummary }}</em>
        </span>
        <input
          type="checkbox"
          class="spanel__check"
          :checked="state.overlayEnabled"
          @change="$emit('overlay', { enabled: $event.target.checked })"
          @keydown.stop
          @dblclick.stop
        />
      </label>
      <div v-if="state.overlayEnabled" class="spanel__subtoggles">
        <label>
          <input type="checkbox" :checked="settings.overlayShapes" @change="$emit('overlay', { shapes: $event.target.checked })" />
          boxes
        </label>
        <label>
          <input type="checkbox" :checked="settings.overlayText" @change="$emit('overlay', { text: $event.target.checked })" />
          text
        </label>
        <label>
          <input type="checkbox" :checked="settings.overlayGraphics" @change="$emit('overlay', { graphics: $event.target.checked })" />
          images
        </label>
      </div>
    </template>

    <h3 class="spanel__h">Storage</h3>

    <p class="spanel__note">
      Thumbnails, folder listings and these settings are kept in this browser&rsquo;s own
      storage. Nothing is ever sent anywhere.
    </p>

    <div class="spanel__row spanel__row--stack">
      <span class="spanel__label">
        {{ storageSummary }}
        <em class="spanel__sub">{{ storageDetail }}</em>
      </span>
    </div>

    <div class="spanel__storage">
      <template v-if="confirming === 'thumbs'">
        <span class="spanel__warn">Delete {{ thumbCountLabel }}?</span>
        <button type="button" class="btn btn--tiny btn--danger" @click="deleteThumbs" @keydown.stop>Delete</button>
        <button type="button" class="btn btn--tiny" @click="confirming = ''" @keydown.stop>Keep</button>
      </template>
      <template v-else>
        <button type="button" class="btn btn--tiny" :disabled="busy" @click="confirming = 'thumbs'" @keydown.stop>
          Delete thumbnails
        </button>
        <span class="spanel__sub">Made again as folders are browsed</span>
      </template>
    </div>

    <div class="spanel__storage">
      <template v-if="confirming === 'all'">
        <span class="spanel__warn">Erase everything and close this page?</span>
        <button type="button" class="btn btn--tiny btn--danger" @click="clearEverything" @keydown.stop>Erase</button>
        <button type="button" class="btn btn--tiny" @click="confirming = ''" @keydown.stop>Cancel</button>
      </template>
      <template v-else>
        <button type="button" class="btn btn--tiny" :disabled="busy" @click="confirming = 'all'" @keydown.stop>
          Clear all site data and close
        </button>
        <span class="spanel__sub">Settings, listings, thumbnails and folder permissions</span>
      </template>
    </div>

    <p v-if="storageNote" class="spanel__note spanel__note--warn">{{ storageNote }}</p>

    <h3 class="spanel__h">Keyboard</h3>
    <div class="spanel__keys">
      <span><kbd>Space</kbd> play/pause</span>
      <span><kbd>&larr;</kbd><kbd>&rarr;</kbd> skip</span>
      <span><kbd>,</kbd><kbd>.</kbd> frame step</span>
      <span><kbd>[</kbd><kbd>]</kbd> speed</span>
      <span><kbd>M</kbd> mute</span>
      <span><kbd>F</kbd> fullscreen</span>
      <span><kbd>Z</kbd> reset zoom</span>
      <span><kbd>I</kbd> metadata</span>
      <span><kbd>E</kbd> export</span>
      <span><kbd>S</kbd> snapshot</span>
      <span><kbd>O</kbd> open file</span>
      <span><kbd>L</kbd> browse folder</span>
    </div>
  </div>
</template>

<script>
import { streamOptions } from '../util/streams.js'
import { PLAYBACK_RATES } from '../player/BvrPlayer.js'
import { mainStartPoints } from '../player/coverage.js'
import { SNAPSHOT_FORMATS, canEncodeWebp } from '../player/snapshot.js'
import { canPickDirectory } from '../library/directory.js'
import { clearThumbs, countThumbs } from '../library/thumbCache.js'
import { clearSiteData, closePage, storageUsage } from '../util/storage.js'
import { formatBytes } from '../util/format.js'

/**
 * The settings panel.
 *
 * It was a popup over the control bar until the dock existed; as a panel it has
 * room to group its rows and to grow, and the recording's own facts -- codec,
 * resolution, frame count -- moved to the metadata panel, where a description
 * of the file belongs.
 */
export default {
  name: 'SettingsPanel',
  props: {
    settings: { type: Object, required: true },
    state: { type: Object, required: true },
    /** The folder the browser has open, and what to call it. */
    hasSnapshotFolder: { type: Boolean, default: false },
    snapshotFolder: { type: String, default: '' }
  },
  emits: ['patch', 'stream', 'overlay', 'rate'],
  data () {
    return {
      rates: PLAYBACK_RATES,
      // Both destructive buttons ask first, and ask in place: this is a panel
      // rather than a dialog because the app does not put things over the
      // video, and a confirmation is no reason to start.
      confirming: '',
      busy: false,
      storageNote: '',
      storage: null,
      thumbCount: 0
    }
  },
  mounted () {
    this.readStorage()
  },
  computed: {
    /** Says which way round the chrome behaves, so the toggle needs no label. */
    chromeSummary () {
      return this.settings.alwaysShowControls
        ? 'The top bar and control bar stay on screen, over the picture'
        : 'They fade out while the pointer sits still, and come back when it moves'
    },
    /**
     * Says whether the buttons would have anywhere to go in the file that is
     * open. Worth the specificity: the recordings they suit are a minority, and
     * a viewer who turns them on and finds them dead has no other way to learn
     * that this recording is not one of them.
     */
    mainJumpSummary () {
      if (!this.settings.mainStreamJumps) {
        return 'Skip to where the main stream starts up, for a recording that only holds it in places'
      }
      if (this.state.status !== 'ready') return 'Skip to where the main stream starts up'
      const n = mainStartPoints(this.state.coverage).length
      if (!n) return 'On, but this recording has no main-stream starts to jump between'
      return `On; this recording starts the main stream ${n} time${n === 1 ? '' : 's'}`
    },
    /** Says what the setting costs, in the terms that decide it. */
    scrubExactSummary () {
      return this.settings.scrubExact
        ? 'Decodes every frame up to the pointer; slower the further apart key frames are'
        : 'Shows the nearest key frame while dragging, which is quicker'
    },
    overlaySummary () {
      const n = this.state.overlayObjects
      const boxes = this.state.overlayShapes
      if (!n) return 'no objects at this position'
      return boxes ? `${n} object(s), ${boxes} box(es) here` : `${n} object(s)`
    },
    showStreamPicker () {
      return this.state.hasMainStream && this.state.hasSubStream
    },
    streamOptions () {
      return streamOptions(this.state)
    },
    /**
     * Says what the setting is actually doing to the file that is open, in the
     * file's own numbers.
     *
     * Worth the specificity: the correction exists because a header's declared
     * resolution and an encoder's real one disagree, and the only way to judge
     * whether the guess is the right one here is to see both.
     */
    aspectSummary () {
      const s = this.state
      if (s.status !== 'ready') return 'Show every stream in the shape the recording declares'
      if (!this.settings.matchAspect) return 'Each stream shown exactly as encoded'
      if (!s.displayAspect) return 'This recording declares no usable shape'
      const target = `${s.displayAspect.toFixed(3)}:1`
      if (!s.displayWidth || (s.displayWidth === s.width && s.displayHeight === s.height)) {
        return `${s.width}×${s.height} is already ${target}${this.otherStreamNote}`
      }
      return `${s.width}×${s.height} shown as ${s.displayWidth}×${s.displayHeight} (${target})`
    },
    /** Whether the stream that is *not* on screen needs the correction. */
    otherStreamNote () {
      const s = this.state
      if (!s.hasMainStream || !s.hasSubStream || !s.displayAspect) return ''
      const other = s.streamMode === 'sub'
        ? { w: s.mainWidth, h: s.mainHeight, name: 'main' }
        : { w: s.subWidth, h: s.subHeight, name: 'sub' }
      if (!(other.w > 0) || !(other.h > 0)) return ''
      const native = other.w / other.h
      if (Math.abs(native - s.displayAspect) <= s.displayAspect * 0.01) return ''
      return `; the ${other.name} stream's ${other.w}×${other.h} is corrected`
    },

    // -------------------------------------------------------------- snapshots
    formats () {
      const webp = canEncodeWebp()
      return SNAPSHOT_FORMATS.map((f) => ({
        value: f.value,
        label: f.value === 'webp' && !webp ? 'WebP (not available here)' : f.label,
        disabled: f.value === 'webp' && !webp
      }))
    },
    formatSummary () {
      const q = this.settings.snapshotQuality
      return this.settings.snapshotFormat === 'webp'
        ? `WebP at ${q}% — smaller files, fewer programs read them`
        : `JPEG at ${q}% — opens anywhere`
    },
    /** Writing into a folder needs the directory API and a folder to write to. */
    canSaveToFolder () {
      return canPickDirectory() && this.hasSnapshotFolder
    },
    folderSummary () {
      if (!canPickDirectory()) return 'This browser cannot write to a folder'
      if (!this.hasSnapshotFolder) return 'Browse a folder first, then this can be turned on'
      if (!this.settings.snapshotToFolder) return 'Otherwise stills download as files'
      return `Writing into ${this.snapshotFolder}`
    },

    // ---------------------------------------------------------------- storage
    storageSummary () {
      if (!this.storage) return 'Reading storage\u2026'
      if (!this.storage.supported) return 'This browser will not say how much it is using'
      return `Using about ${formatBytes(this.storage.usage)}`
    },
    /**
     * The figure a browser reports is padded and rounded on purpose -- an exact
     * one would say more about the browser than about this page -- so it is
     * offered as an approximation rather than dressed up as a measurement.
     */
    storageDetail () {
      const bits = [`${this.thumbCountLabel} cached`]
      if (!this.storage || !this.storage.supported) return bits.join(' \u00b7 ')
      if (this.storage.quota) bits.push(`${formatBytes(this.storage.quota)} available`)
      bits.push('browsers round this figure')
      return bits.join(' \u00b7 ')
    },
    thumbCountLabel () {
      const n = this.thumbCount
      return `${n.toLocaleString()} thumbnail${n === 1 ? '' : 's'}`
    }
  },
  methods: {
    clampQuality (raw) {
      const n = Math.round(Number(raw))
      if (!Number.isFinite(n)) return this.settings.snapshotQuality
      return Math.min(100, Math.max(1, n))
    },
    /** Same live-but-only-when-valid rule as the skip interval below. */
    onQualityInput (event) {
      const raw = event.target.value
      if (raw === '') return
      const n = Number(raw)
      if (!Number.isFinite(n)) return
      const clamped = this.clampQuality(n)
      if (clamped === n) this.emitPatch({ snapshotQuality: clamped })
    },
    onQualityCommit (event) {
      const clamped = this.clampQuality(event.target.value)
      event.target.value = String(clamped)
      this.emitPatch({ snapshotQuality: clamped })
    },
    clampSkip (raw) {
      const n = Math.round(Number(raw))
      if (!Number.isFinite(n)) return this.settings.skipSeconds
      return Math.min(600, Math.max(1, n))
    },
    /**
     * Live updates while typing or clicking the spinner, but only for values
     * that are already in range - clamping mid-keystroke would fight the user
     * (and an emptied field must be allowed to stay empty until it is committed).
     */
    onSkipInput (event) {
      const raw = event.target.value
      if (raw === '') return
      const n = Number(raw)
      if (!Number.isFinite(n)) return
      const clamped = this.clampSkip(n)
      if (clamped === n) this.emitPatch({ skipSeconds: clamped })
    },
    /**
     * Commit (blur / Enter). Writing the clamped value straight back to the DOM
     * matters: if the clamp lands on the value the prop already holds, Vue has
     * no patch to apply and the field would keep showing the rejected text.
     */
    onSkipCommit (event) {
      const clamped = this.clampSkip(event.target.value)
      event.target.value = String(clamped)
      this.emitPatch({ skipSeconds: clamped })
    },
    emitPatch (patch) {
      this.$emit('patch', patch)
    },

    // ---------------------------------------------------------------- storage
    async readStorage () {
      const [storage, thumbCount] = await Promise.all([storageUsage(), countThumbs()])
      this.storage = storage
      this.thumbCount = thumbCount
    },
    async deleteThumbs () {
      this.confirming = ''
      this.busy = true
      this.storageNote = ''
      try {
        await clearThumbs()
        await this.readStorage()
      } finally {
        this.busy = false
      }
    },
    /**
     * Everything gone, and then the page.
     *
     * Closing is not decoration: what is left on screen otherwise is an app
     * whose settings, cached listings and folder permissions have all been
     * erased underneath it, and which writes a fresh set the moment anything is
     * touched. An ordinary tab is not allowed to close itself, so where that is
     * refused the page says what is left to do rather than pretending.
     */
    async clearEverything () {
      this.confirming = ''
      this.busy = true
      this.storageNote = ''
      try {
        await clearSiteData()
        await this.readStorage()
        const closed = await closePage()
        if (!closed) {
          this.storageNote = 'Site data cleared. This browser will not let a page close itself, so close the tab.'
        }
      } finally {
        this.busy = false
      }
    }
  }
}
</script>

<style scoped>
.spanel {
  padding: 4px 12px 14px;
}

.spanel__h {
  margin: 12px 0 2px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-dim);
}

.spanel__h:first-child {
  margin-top: 8px;
}

.spanel__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  font-size: 13px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.spanel__row--toggle {
  cursor: pointer;
}

/* A row whose control cannot do anything yet still explains itself, so it is
   dimmed rather than hidden. */
.spanel__row--off {
  cursor: default;
  opacity: 0.55;
}

.spanel__label {
  display: flex;
  flex-direction: column;
  min-width: 0;
  color: var(--text-dim);
}

.spanel__sub {
  font-size: 10.5px;
  font-style: normal;
  opacity: 0.75;
  overflow-wrap: anywhere;
}

.spanel__control {
  display: flex;
  align-items: center;
  gap: 5px;
}

.spanel__unit {
  color: var(--text-dim);
  font-size: 12px;
}

.spanel__check {
  flex: none;
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}

.spanel__subtoggles {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  padding: 8px 0 2px;
  color: var(--text-dim);
  font-size: 11.5px;
}

.spanel__subtoggles label {
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}

.spanel__subtoggles input {
  accent-color: var(--accent);
}

.spanel__row--stack {
  border-bottom: none;
  padding-bottom: 2px;
}

.spanel__note {
  margin: 4px 0 0;
  color: var(--text-dim);
  font-size: 10.5px;
  opacity: 0.75;
}

.spanel__note--warn {
  opacity: 1;
  color: #f0b429;
}

.spanel__storage {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  padding: 4px 0 7px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.spanel__storage .spanel__sub {
  color: var(--text-dim);
}

.spanel__warn {
  font-size: 12px;
  font-weight: 600;
}

.spanel__storage .btn--danger {
  border-color: rgba(255, 120, 110, 0.55);
  background: rgba(255, 80, 70, 0.18);
}

.spanel__storage .btn--danger:hover {
  background: rgba(255, 80, 70, 0.32);
}

.spanel__keys {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 12px;
  padding-top: 6px;
  font-size: 11px;
  color: var(--text-dim);
}

kbd {
  display: inline-block;
  min-width: 15px;
  padding: 1px 4px;
  margin-right: 2px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.07);
  font: inherit;
  font-size: 10px;
  text-align: center;
}
</style>
