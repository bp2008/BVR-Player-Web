<template>
  <div class="export">
    <div v-if="!plan" class="export__body">
      <p class="export__note">Nothing is loaded.</p>
    </div>

    <div v-else-if="result" class="export__body">
      <p class="export__done">
        <AppIcon name="check" :size="18" />
        <span>Wrote {{ result.frames.toLocaleString() }} frames &mdash; {{ formatBytes(result.size) }}.</span>
      </p>
      <p v-if="!streaming" class="export__note">The file has been handed to your browser's downloads.</p>
      <ul v-if="result.warnings.length" class="export__warnings">
        <li v-for="(w, i) in result.warnings" :key="i">{{ w }}</li>
      </ul>
      <div class="export__actions">
        <button type="button" class="btn" @click="result = null">Export another</button>
        <button type="button" class="btn btn--accent" @click="$emit('close')">Done</button>
      </div>
    </div>

    <div v-else-if="running" class="export__body">
      <p class="export__stage">{{ stageLabel }}</p>
      <div class="progress"><div class="progress__bar" :style="{ width: (progress * 100).toFixed(1) + '%' }"></div></div>
      <p class="export__note">{{ (progress * 100).toFixed(0) }}% &middot; {{ formatBytes(estimated) }} estimated</p>
      <div class="export__actions">
        <button type="button" class="btn" @click="cancel">Cancel</button>
      </div>
    </div>

    <div v-else class="export__body">
      <div class="export__field">
        <span class="export__label">Range</span>
        <div class="export__times">
          <input
            v-for="end in ENDS"
            :key="end"
            class="export__time"
            type="text"
            spellcheck="false"
            autocomplete="off"
            :aria-label="end === 'start' ? 'Range start' : 'Range end'"
            :value="edit[end]"
            @focus="editing = end"
            @input="onTimeInput(end, $event)"
            @change="onTimeCommit(end, $event)"
            @blur="onTimeBlur"
            @keydown.stop
          />
          <em class="export__len">{{ formatTime(Math.max(0, trim.end - trim.start), false) }}</em>
        </div>
        <div class="export__range">
          <button type="button" class="btn btn--tiny" @click="setStart">Start here</button>
          <button type="button" class="btn btn--tiny" @click="setEnd">End here</button>
          <button type="button" class="btn btn--tiny" @click="resetRange">Whole clip</button>
        </div>
        <p class="export__hint">
          Type a time above, or drag the handles on the scrub bar. Either way the
          playhead moves there, so you can see the frame you are cutting on.
        </p>
      </div>

      <div v-if="sourceOptions.length > 1" class="export__field">
        <span class="export__label">Video source</span>
        <select class="settings__select export__source" :value="options.source" @change="patch({ source: $event.target.value })" @keydown.stop>
          <option v-for="o in sourceOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <p v-if="sourceHint" class="export__hint">{{ sourceHint }}</p>
      </div>

      <div class="export__field">
        <span class="export__label">Method</span>
        <label class="export__radio">
          <input type="radio" value="remux" :checked="options.mode === 'remux'" :disabled="!plan.copyable" @change="patch({ mode: 'remux' })" />
          <span>
            Copy frames
            <em>{{ plan.copyable ? 'Fast, no quality loss' : plan.copyBlocker }}</em>
          </span>
        </label>
        <label class="export__radio">
          <input type="radio" value="transcode" :checked="options.mode === 'transcode'" :disabled="noEncoder" @change="patch({ mode: 'transcode' })" />
          <span>
            Re-encode
            <em>{{ noEncoder ? 'No VideoEncoder in this browser' : 'Exact trim, rescale, change codec' }}</em>
          </span>
        </label>
      </div>

      <template v-if="plan.mode === 'transcode'">
        <label class="export__field export__field--row">
          <span class="export__label">Codec</span>
          <select class="settings__select" :value="options.videoCodec" @change="patch({ videoCodec: $event.target.value })" @keydown.stop>
            <option v-for="c in codecs" :key="c.value" :value="c.value">{{ c.label }}</option>
          </select>
        </label>

        <label class="export__field export__field--row">
          <span class="export__label">Bitrate</span>
          <span class="export__control">
            <input
              class="settings__number"
              type="number"
              min="200"
              max="80000"
              step="100"
              :value="Math.round(options.videoBitrate / 1000)"
              @change="patch({ videoBitrate: clampNum($event.target.value, 200, 80000) * 1000 })"
              @keydown.stop
            />
            <span class="settings__unit">kbps</span>
          </span>
        </label>

        <label class="export__field export__field--row">
          <span class="export__label">Resolution</span>
          <select class="settings__select" :value="options.maxHeight" @change="patch({ maxHeight: Number($event.target.value) })" @keydown.stop>
            <option :value="0">Source ({{ plan.displayWidth }}&times;{{ plan.displayHeight }})</option>
            <option v-for="h in heights" :key="h" :value="h">{{ h }}p</option>
          </select>
        </label>

        <label class="export__field export__field--row">
          <span class="export__label">Frame rate</span>
          <select class="settings__select" :value="options.fps" @change="patch({ fps: Number($event.target.value) })" @keydown.stop>
            <option :value="0">Source timing</option>
            <option v-for="f in [30, 25, 15, 10, 5, 1]" :key="f" :value="f">{{ f }} fps max</option>
          </select>
        </label>
      </template>

      <label class="export__field export__field--row">
        <span class="export__label">Audio</span>
        <select
          class="settings__select"
          :value="options.audio"
          :disabled="!hasAudio"
          @change="patch({ audio: $event.target.value })"
          @keydown.stop
        >
          <option value="aac">Re-encode to AAC</option>
          <option value="none">No audio</option>
        </select>
      </label>

      <dl class="export__summary">
        <div>
          <dt>Output</dt>
          <dd>
            {{ plan.outWidth }}&times;{{ plan.outHeight }} {{ methodLabel }}
            <em v-if="aspectNote" class="export__aside">{{ aspectNote }}</em>
          </dd>
        </div>
        <div><dt>Frames</dt><dd>{{ plan.frames.toLocaleString() }}</dd></div>
        <div><dt>Estimated size</dt><dd>{{ formatBytes(plan.estimatedBytes) }}</dd></div>
        <div><dt>File name</dt><dd class="export__filename">{{ plan.fileName }}</dd></div>
      </dl>

      <div v-if="encoderCheck.blocked" class="export__warnings export__warnings--error">
        <p class="export__blocked">
          This device cannot encode {{ codecLabel }} at {{ plan.outWidth }}&times;{{ plan.outHeight }}.
        </p>
        <p v-if="encoderCheck.alt" class="export__blocked">
          <button type="button" class="btn btn--tiny" @click="patch({ maxHeight: encoderCheck.alt })">
            Use {{ encoderCheck.alt }}p instead
          </button>
        </p>
        <p v-else class="export__blocked">No smaller preset is accepted either; try the other codec.</p>
      </div>

      <ul v-if="plan.warnings.length" class="export__warnings">
        <li v-for="(w, i) in plan.warnings" :key="i">{{ w }}</li>
      </ul>
      <ul v-if="plan.errors.length" class="export__warnings export__warnings--error">
        <li v-for="(e, i) in plan.errors" :key="i">{{ e }}</li>
      </ul>
      <p v-if="!streaming && plan.estimatedBytes > 1.5e9" class="export__warnings export__warnings--error">
        An export this large has to be assembled in memory here. Serve the app over http(s) to write it straight to disk instead.
      </p>

      <div class="export__actions">
        <button type="button" class="btn btn--accent btn--wide" :disabled="!plan.ok || encoderCheck.blocked" @click="start">
          <AppIcon name="download" :size="17" />
          <span>Export</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import AppIcon from './AppIcon.vue'
import { formatBytes, formatTime, parseTime } from '../util/format.js'
import {
  planExport, chooseEncoderConfig, outputSize,
  DEFAULT_OPTIONS, TRANSCODE_CODECS, SOURCE_MAIN, SOURCE_SUB, SOURCE_BOTH
} from '../export/exportPlan.js'
import { ExportJob, ExportCancelled } from '../export/exportJob.js'
import { canStreamToDisk, deliver, openOutput } from '../export/sink.js'
import { buildPlaybackStream } from '../player/playbackStream.js'
import { STREAM_MAIN, STREAM_SUB } from '../bvr/constants.js'

// The two ends of the range, in the order they are shown.
const ENDS = ['start', 'end']

// The shortest range the two ends may be pushed to. Long enough to hold a frame
// at any sane rate, short enough that it never gets in the way of a real trim.
const MIN_RANGE_MS = 100

/**
 * Export to MP4, as a docked panel.
 *
 * It was a modal dialog first, which meant the video it was trimming was behind
 * it and the playhead could not be moved while it was up. Docked, the "start
 * here" buttons and the scrub bar's trim handles are usable together, which is
 * how choosing a range actually works.
 */
export default {
  name: 'ExportPanel',
  components: { AppIcon },
  props: {
    context: { type: Object, default: null },
    trim: { type: Object, required: true },
    currentTime: { type: Number, default: 0 },
    duration: { type: Number, default: 0 }
  },
  emits: ['close', 'trim', 'seek', 'notice'],
  data () {
    return {
      ENDS,
      // What the two range fields currently show. Held apart from `trim` so that
      // a half-typed time is not rewritten under the cursor on every keystroke;
      // see syncEdits.
      edit: { start: '', end: '' },
      editing: '',
      options: { ...DEFAULT_OPTIONS },
      running: false,
      progress: 0,
      stage: '',
      result: null,
      job: null,
      codecs: TRANSCODE_CODECS,
      heights: [1440, 1080, 720, 480, 360],
      streaming: canStreamToDisk(),
      // Whether this device will encode what is currently configured. Asked
      // asynchronously and cached against the settings it was asked about, so
      // that typing in the range fields does not re-probe the encoder.
      encoderCheck: { key: '', blocked: false, alt: 0 },
      // Set when the method was moved off "copy" because the chosen source
      // could not be copied, so that picking a source that can be restores it.
      forcedTranscode: false
    }
  },
  computed: {
    noEncoder () { return typeof VideoEncoder === 'undefined' },
    hasAudio () { return !!(this.context && this.context.header && this.context.header.hasAudio) },

    /**
     * The video sources this recording can offer, and what each one is.
     *
     * A file with one video stream offers one, and the picker hides itself. The
     * sizes are in the labels because choosing between two streams is mostly
     * choosing between two resolutions, and the resolution list below is about
     * the *output* rather than the source.
     */
    sourceOptions () {
      const info = this.context && this.context.streamInfo
      if (!info) return []
      const out = []
      const shape = (s) => (s.width && s.height ? ` (${s.width}×${s.height})` : '')
      if (info[STREAM_MAIN]) out.push({ value: SOURCE_MAIN, label: info[STREAM_MAIN].label + shape(info[STREAM_MAIN]) })
      if (info[STREAM_SUB]) out.push({ value: SOURCE_SUB, label: info[STREAM_SUB].label + shape(info[STREAM_SUB]) })
      if (info[STREAM_MAIN] && info[STREAM_SUB]) out.push({ value: SOURCE_BOTH, label: 'Both (main preferred)' })
      return out
    },
    sourceHint () {
      if (this.options.source !== SOURCE_BOTH) return ''
      return 'One video track that plays the main stream wherever it reaches and ' +
        'scales the sub stream up to cover the rest — the same sequence Auto plays.'
    },

    /**
     * The frame sequence the export will read, built here rather than taken
     * from the player.
     *
     * Recomputed only when the file or the chosen source changes: it allocates
     * a table the length of the recording, and `plan` below re-runs on every
     * keystroke in the range fields.
     *
     * 'main' and 'sub' are built as if both were decodable, because a stream
     * copy never decodes anything and a source the user explicitly asked for
     * should not silently turn into the other one. 'both' gets the real verdict,
     * since deciding what it can draw on is the whole of what it does.
     */
    pstream () {
      const c = this.context
      if (!c || !c.index || !c.header) return null
      const source = this.options.source
      const mode = source === SOURCE_BOTH ? 'auto' : source
      const playable = source === SOURCE_BOTH ? c.playable : [true, true]
      try {
        return buildPlaybackStream(c.index, c.header, mode, playable, c.probedSizes)
      } catch (e) {
        return null
      }
    },

    /** Decoder configuration per source stream, for whichever streams this sequence uses. */
    decoderConfigs () {
      const info = this.context && this.context.streamInfo
      const s = this.pstream
      if (!info || !s) return null
      const out = []
      for (const si of (s.sources || [s.codecSource])) out[si] = (info[si] && info[si].config) || null
      return out
    },

    /** Streams the sequence needs to decode but this device cannot. */
    undecodable () {
      const info = this.context && this.context.streamInfo
      const s = this.pstream
      if (!info || !s) return []
      return (s.sources || [s.codecSource])
        .filter((si) => info[si] && !info[si].supported)
        .map((si) => info[si])
    },

    codecLabel () {
      const c = TRANSCODE_CODECS.find((x) => x.value === this.options.videoCodec)
      return c ? c.label : ''
    },

    plan () {
      if (!this.context || !this.pstream || !this.pstream.count) return null
      try {
        const plan = planExport({
          header: this.context.header,
          index: this.context.index,
          pstream: this.pstream,
          audioStarts: this.context.audioStarts,
          fileName: this.context.fileName,
          reference: this.context.reference,
          options: { ...this.options, startMs: this.trim.start, endMs: this.trim.end }
        })
        // A copy moves bytes and never decodes, so an undecodable stream is only
        // an obstacle to re-encoding it.
        if (plan.mode === 'transcode' && this.undecodable.length) {
          plan.errors.push(
            `This device cannot decode the ${this.undecodable.map((s) => s.label.toLowerCase()).join(' or ')}` +
            `${plan.copyable ? ', so it cannot be re-encoded here. Copy frames instead.' : '.'}`)
          plan.ok = false
        }
        return plan
      } catch (e) {
        return null
      }
    },
    /**
     * How the file will carry the shape correction, when there is one.
     *
     * Worth spelling out: the two modes reach the same picture by opposite
     * routes, and which one is in force decides whether the output is a
     * square-pixel file or one that leans on the container.
     */
    aspectNote () {
      const p = this.plan
      if (!p || !p.corrected) return ''
      if (p.mode === 'remux' && p.pasp) {
        return `shown as ${p.displayWidth}×${p.displayHeight} via a ${p.pasp.hSpacing}:${p.pasp.vSpacing} pixel aspect ratio`
      }
      if (p.mode === 'remux') return ''
      return `rescaled from ${p.width}×${p.height} to square pixels`
    },
    methodLabel () {
      if (!this.plan) return ''
      if (this.plan.mode === 'remux') return `${this.plan.fourcc} copied`
      const c = TRANSCODE_CODECS.find((x) => x.value === this.options.videoCodec)
      return `re-encoded to ${c ? c.label : ''}`
    },
    estimated () { return this.plan ? this.plan.estimatedBytes : 0 },
    stageLabel () {
      return this.stage === 'audio' ? 'Encoding audio…' : 'Writing video…'
    }
  },
  watch: {
    // A different recording invalidates a finished report as much as it does a
    // half-configured job.
    context: { handler: 'adoptContext', immediate: true },
    // A copy is the better outcome wherever it is available, so the method
    // follows what the chosen source can do -- and goes back to a copy when a
    // source that can be copied is picked again. Only where the fallback was
    // ours: a method the user chose is left alone.
    'plan.copyable': {
      handler (can) {
        if (can == null) return
        if (!can && this.options.mode === 'remux') {
          this.forcedTranscode = true
          this.patch({ mode: 'transcode' })
        } else if (can && this.forcedTranscode) {
          this.forcedTranscode = false
          this.patch({ mode: 'remux' })
        }
      },
      immediate: true
    },
    plan: { handler: 'checkEncoder', immediate: true },
    trim: { handler () { this.syncEdits() }, immediate: true }
  },
  beforeUnmount () {
    if (this.job) this.job.cancel()
  },
  methods: {
    formatBytes,
    formatTime,
    clampNum (raw, lo, hi) {
      const n = Math.round(Number(raw))
      if (!Number.isFinite(n)) return lo
      return Math.min(hi, Math.max(lo, n))
    },
    patch (p) { this.options = { ...this.options, ...p } },

    /**
     * Points the panel at a newly opened recording.
     *
     * The source starts as whatever the player is showing, so opening the panel
     * describes what is on screen. It is only a starting point: changing it here
     * changes the export and nothing else, which is the whole reason the export
     * builds its own sequence rather than borrowing the player's.
     */
    adoptContext () {
      this.result = null
      this.forcedTranscode = false
      this.encoderCheck = { key: '', blocked: false, alt: 0 }
      if (!this.context) return
      const want = this.context.streamMode === 'sub' ? SOURCE_SUB
        : this.context.streamMode === 'auto' ? SOURCE_BOTH
          : SOURCE_MAIN
      const offered = this.sourceOptions.map((o) => o.value)
      this.patch({ source: offered.includes(want) ? want : (offered[0] || SOURCE_MAIN) })
    },

    /**
     * Asks the encoder whether it will take the configured output, ahead of time.
     *
     * The alternative is finding out from a failed export, which is how this
     * started: the message arrives after the file has been named, and it names a
     * resolution rather than the thing that can be changed about it. Asking here
     * turns it into a sentence beside a button that fixes it.
     *
     * Keyed on the settings it asked about so that typing in the range fields --
     * which rebuilds the plan on every keystroke -- does not re-probe anything.
     */
    async checkEncoder () {
      const plan = this.plan
      if (!plan || plan.mode !== 'transcode' || this.noEncoder) {
        if (this.encoderCheck.key) this.encoderCheck = { key: '', blocked: false, alt: 0 }
        return
      }
      const key = [plan.options.videoCodec, plan.outWidth, plan.outHeight,
        Math.round(plan.outFps * 100), plan.options.videoBitrate].join('/')
      if (key === this.encoderCheck.key) return
      // Optimistic while the answer is pending. "Yes" is the overwhelmingly
      // common case, and an Export button that greys itself out for a moment on
      // every change is worse than one that turns off a beat late.
      this.encoderCheck = { key, blocked: false, alt: 0 }

      const ask = (width, height) => chooseEncoderConfig({
        codec: plan.options.videoCodec,
        width,
        height,
        fps: plan.outFps,
        bitrate: plan.options.videoBitrate
      })
      const stale = () => this.encoderCheck.key !== key

      const chosen = await ask(plan.outWidth, plan.outHeight)
      if (stale() || (chosen && chosen.config)) return

      // The largest preset it will take, which is what the offer to downscale
      // has to name.
      let alt = 0
      for (const h of this.heights) {
        if (h >= plan.outHeight) continue
        const size = outputSize(plan.displayWidth, plan.displayHeight, h)
        const r = await ask(size.width, size.height)
        if (stale()) return
        if (r && r.config) { alt = h; break }
      }
      this.encoderCheck = { key, blocked: true, alt }
    },

    // ------------------------------------------------------------------ range

    /** Re-writes the range fields from the trim, leaving the one being typed in. */
    syncEdits () {
      for (const end of ENDS) {
        if (this.editing !== end) this.edit[end] = formatTime(this.trim[end])
      }
    },
    /**
     * Live as the time is typed, but only once it reads as one.
     *
     * The scrub bar is a few hundred pixels wide however long the recording is,
     * so on anything lengthy it cannot resolve a particular second, let alone a
     * particular frame. Typing the time is the way out of that -- and it is only
     * useful if the picture follows along as it is typed, which is what the seek
     * is for.
     */
    onTimeInput (which, event) {
      this.edit[which] = event.target.value
      const ms = parseTime(event.target.value)
      if (ms !== null) this.applyTime(which, ms)
    },
    /** Enter, or leaving the field: whatever it holds now is the answer. */
    onTimeCommit (which, event) {
      const ms = parseTime(event.target.value)
      if (ms === null) {
        // Unreadable: put back the time that is actually in force.
        this.edit[which] = formatTime(this.trim[which])
        event.target.value = this.edit[which]
        return
      }
      this.applyTime(which, ms)
    },
    onTimeBlur () {
      this.editing = ''
      this.syncEdits()
    },
    /** Moves one end of the range, and takes the playhead with it. */
    applyTime (which, ms) {
      const at = Math.min(Math.max(0, ms), this.duration)
      const next = which === 'start'
        ? { start: Math.min(at, this.trim.end - MIN_RANGE_MS), end: this.trim.end }
        : { start: this.trim.start, end: Math.max(at, this.trim.start + MIN_RANGE_MS) }
      next.start = Math.max(0, next.start)
      next.end = Math.min(this.duration, next.end)
      this.$emit('trim', next)
      this.$emit('seek', next[which])
    },
    setStart () {
      this.$emit('trim', { start: Math.min(this.currentTime, this.trim.end - MIN_RANGE_MS), end: this.trim.end })
    },
    setEnd () {
      this.$emit('trim', { start: this.trim.start, end: Math.max(this.currentTime, this.trim.start + MIN_RANGE_MS) })
    },
    resetRange () { this.$emit('trim', { start: 0, end: this.duration }) },
    cancel () {
      if (this.job) this.job.cancel()
    },
    async start () {
      const plan = this.plan
      if (!plan || !plan.ok || this.running || this.encoderCheck.blocked) return
      // The file picker needs the activation from this very click, so it is
      // opened before anything is awaited.
      let sink
      try {
        sink = await openOutput(plan.fileName)
      } catch (e) {
        this.$emit('notice', `Could not open an output file: ${e.message}`)
        return
      }
      if (!sink) return

      this.running = true
      this.progress = 0
      this.stage = plan.audio.include ? 'audio' : 'video'
      const job = new ExportJob({
        blob: this.context.blob,
        header: this.context.header,
        index: this.context.index,
        pstream: this.pstream,
        plan: { ...plan, decoderConfigs: this.decoderConfigs },
        sink,
        onProgress: (p) => { this.progress = p.progress; this.stage = p.stage }
      })
      this.job = job
      try {
        const result = await job.run()
        deliver(sink)
        this.result = result
      } catch (e) {
        await sink.abort()
        if (!(e instanceof ExportCancelled)) {
          this.$emit('notice', `Export failed: ${e && e.message ? e.message : e}`)
        }
      } finally {
        this.running = false
        this.job = null
      }
    }
  }
}
</script>

<style scoped>
.export__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  font-size: 13px;
}

/* One column: a dock is narrow by definition, and a label beside its control
   would leave neither enough room. */
.export__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.export__field--row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.export__label {
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
}

.export__field--row .export__label {
  text-transform: none;
  letter-spacing: 0;
  font-size: 13px;
  font-weight: 400;
}

/* The two range fields plus the length they add up to, on one line. They share
   the global field look but not its width: a timestamp with milliseconds is
   wider than a number of seconds, and it is what has to fit. */
.export__times {
  display: flex;
  align-items: center;
  gap: 6px;
}

.export__time {
  flex: 1 1 0;
  min-width: 0;
  background: var(--field);
  border: 1px solid var(--field-border);
  border-radius: 7px;
  color: var(--text);
  padding: 4px 7px;
  font: 500 13px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  text-align: center;
  color-scheme: dark;
}

.export__time:hover {
  border-color: rgba(255, 255, 255, 0.28);
}

.export__time:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.export__len {
  flex: none;
  color: var(--text-dim);
  font-style: normal;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}

.export__hint {
  margin: 0;
  color: var(--text-dim);
  font-size: 11px;
}

.export__range {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.export__control {
  display: flex;
  align-items: center;
  gap: 5px;
}

.export__radio {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
}

.export__radio input {
  margin-top: 2px;
  accent-color: var(--accent);
}

.export__radio span {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

.export__radio em {
  color: var(--text-dim);
  font-size: 11.5px;
  font-style: normal;
}

.export__radio input:disabled + span {
  opacity: 0.5;
}

.export__summary {
  margin: 0;
  padding: 9px 11px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.05);
  font-size: 12px;
}

.export__summary > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 0;
}

.export__summary dt {
  flex: none;
  color: var(--text-dim);
}

.export__summary dd {
  margin: 0;
  text-align: right;
  min-width: 0;
}

.export__filename {
  overflow-wrap: anywhere;
}

/* The shared select is sized for the label-beside-control rows. This one sits
   in a column under its label, where a stream name and its resolution need the
   full width. */
.export__source {
  max-width: none;
  width: 100%;
}

/* The encoder-refusal notice is prose plus a button rather than a bullet list,
   so it opts out of the list padding its container carries for warnings. */
.export__blocked {
  margin: 0;
  padding: 0;
}

.export__blocked + .export__blocked {
  margin-top: 7px;
}

/* A quieter second line under a summary value -- how the shape correction is
   being carried, which only some files have anything to say about. */
.export__aside {
  display: block;
  color: var(--text-dim);
  font-size: 11px;
  font-style: normal;
  overflow-wrap: anywhere;
}

.export__warnings {
  margin: 0;
  padding: 9px 12px 9px 26px;
  border-radius: 9px;
  border: 1px solid rgba(210, 153, 34, 0.42);
  background: rgba(210, 153, 34, 0.12);
  color: var(--warn);
  font-size: 12px;
  line-height: 1.5;
}

.export__warnings--error {
  border-color: rgba(255, 123, 114, 0.42);
  background: rgba(255, 123, 114, 0.12);
  color: var(--danger);
  list-style: none;
  padding-left: 12px;
}

.export__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.export__note {
  margin: 0;
  color: var(--text-dim);
  font-size: 12.5px;
}

.export__stage {
  margin: 0;
  font-weight: 600;
}

.export__done {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  color: var(--accent);
  font-weight: 600;
}
</style>
