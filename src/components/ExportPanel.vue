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
        <span class="export__value">
          {{ formatTime(trim.start, false) }} &ndash; {{ formatTime(trim.end, false) }}
          <em>({{ formatTime(Math.max(0, trim.end - trim.start), false) }})</em>
        </span>
        <div class="export__range">
          <button type="button" class="btn btn--tiny" @click="setStart">Start here</button>
          <button type="button" class="btn btn--tiny" @click="setEnd">End here</button>
          <button type="button" class="btn btn--tiny" @click="resetRange">Whole clip</button>
        </div>
        <p class="export__hint">Or drag the handles on the scrub bar.</p>
      </div>

      <div class="export__field">
        <span class="export__label">Method</span>
        <label class="export__radio">
          <input type="radio" value="remux" :checked="options.mode === 'remux'" :disabled="!plan.copyable" @change="patch({ mode: 'remux' })" />
          <span>
            Copy frames
            <em>{{ plan.copyable ? 'Fast, no quality loss' : 'Not possible for this stream' }}</em>
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
            <option :value="0">Source ({{ plan.width }}&times;{{ plan.height }})</option>
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
        <div><dt>Output</dt><dd>{{ plan.outWidth }}&times;{{ plan.outHeight }} {{ methodLabel }}</dd></div>
        <div><dt>Frames</dt><dd>{{ plan.frames.toLocaleString() }}</dd></div>
        <div><dt>Estimated size</dt><dd>{{ formatBytes(plan.estimatedBytes) }}</dd></div>
        <div><dt>File name</dt><dd class="export__filename">{{ plan.fileName }}</dd></div>
      </dl>

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
        <button type="button" class="btn btn--accent btn--wide" :disabled="!plan.ok" @click="start">
          <AppIcon name="download" :size="17" />
          <span>Export</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import AppIcon from './AppIcon.vue'
import { formatBytes, formatTime } from '../util/format.js'
import { planExport, DEFAULT_OPTIONS, TRANSCODE_CODECS } from '../export/exportPlan.js'
import { ExportJob, ExportCancelled } from '../export/exportJob.js'
import { canStreamToDisk, deliver, openOutput } from '../export/sink.js'

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
  emits: ['close', 'trim', 'notice'],
  data () {
    return {
      options: { ...DEFAULT_OPTIONS },
      running: false,
      progress: 0,
      stage: '',
      result: null,
      job: null,
      codecs: TRANSCODE_CODECS,
      heights: [1440, 1080, 720, 480, 360],
      streaming: canStreamToDisk()
    }
  },
  computed: {
    noEncoder () { return typeof VideoEncoder === 'undefined' },
    hasAudio () { return !!(this.context && this.context.header && this.context.header.hasAudio) },
    plan () {
      if (!this.context) return null
      try {
        return planExport({
          header: this.context.header,
          index: this.context.index,
          pstream: this.context.pstream,
          audioStarts: this.context.audioStarts,
          fileName: this.context.fileName,
          options: { ...this.options, startMs: this.trim.start, endMs: this.trim.end }
        })
      } catch (e) {
        return null
      }
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
    context () {
      this.result = null
      if (this.plan && !this.plan.copyable) this.options = { ...this.options, mode: 'transcode' }
    }
  },
  mounted () {
    // A stream copy is the right default whenever it is possible; the plan
    // silently falls back for the streams where it is not.
    if (this.plan && !this.plan.copyable) this.options.mode = 'transcode'
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
    setStart () {
      this.$emit('trim', { start: Math.min(this.currentTime, this.trim.end - 100), end: this.trim.end })
    },
    setEnd () {
      this.$emit('trim', { start: this.trim.start, end: Math.max(this.currentTime, this.trim.start + 100) })
    },
    resetRange () { this.$emit('trim', { start: 0, end: this.duration }) },
    cancel () {
      if (this.job) this.job.cancel()
    },
    async start () {
      const plan = this.plan
      if (!plan || !plan.ok || this.running) return
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
        pstream: this.context.pstream,
        plan: { ...plan, decoderConfig: this.context.decoderConfig },
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

.export__value {
  font-variant-numeric: tabular-nums;
}

.export__value em {
  color: var(--text-dim);
  font-style: normal;
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
