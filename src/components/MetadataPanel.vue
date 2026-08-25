<template>
  <div class="metapanel">
    <nav class="metapanel__tabs">
      <button
        v-for="t in tabs"
        :key="t.value"
        type="button"
        class="metapanel__tab"
        :class="{ 'metapanel__tab--on': tab === t.value }"
        @click="tab = t.value"
      >{{ t.label }}</button>
    </nav>

    <div class="metapanel__content">
      <!-- ------------------------------------------------------------ file -->
      <section v-if="tab === 'file'" class="metasec">
        <h3 class="metasec__h">Recording</h3>
        <dl class="kv">
          <div><dt>File</dt><dd>{{ state.fileName }}</dd></div>
          <div><dt>Size</dt><dd>{{ formatBytes(state.fileSize) }}</dd></div>
          <div v-if="state.startUtc"><dt>Starts</dt><dd>{{ formatUtc(state.startUtc) }}</dd></div>
          <div v-if="endUtc"><dt>Ends</dt><dd>{{ formatUtc(endUtc) }}</dd></div>
          <div><dt>Duration</dt><dd>{{ formatTime(state.duration, false) }}</dd></div>
          <div v-if="orientation"><dt>Orientation</dt><dd>{{ orientation }}</dd></div>
          <div v-if="state.truncated"><dt>Tail</dt><dd class="kv--warn">truncated</dd></div>
          <div v-if="state.resyncs"><dt>Resynchronised</dt><dd class="kv--warn">{{ state.resyncs }}x</dd></div>
        </dl>

        <h3 class="metasec__h">Now playing</h3>
        <dl class="kv">
          <div><dt>Video</dt><dd>{{ state.videoLabel || '--' }}</dd></div>
          <div><dt>Resolution</dt><dd>{{ state.width }} &times; {{ state.height }}</dd></div>
          <div v-if="shownAs">
            <dt>Shown as</dt>
            <dd>{{ shownAs }}</dd>
          </div>
          <div><dt>Nominal rate</dt><dd>{{ state.fps ? state.fps.toFixed(2) + ' fps' : '--' }}</dd></div>
          <div><dt>Frames</dt><dd>{{ state.frameCount.toLocaleString() }}</dd></div>
          <div><dt>Source</dt><dd>{{ state.streamLabel }}</dd></div>
        </dl>

        <h3 class="metasec__h">Streams</h3>
        <dl class="kv">
          <div v-if="state.hasMainStream">
            <dt>Main</dt>
            <dd>{{ state.mainWidth }}&times;{{ state.mainHeight }} &middot; {{ state.mainCodecLabel }}</dd>
          </div>
          <div v-if="state.hasSubStream">
            <dt>Sub</dt>
            <dd>{{ state.subWidth }}&times;{{ state.subHeight }} &middot; {{ state.subCodecLabel }}</dd>
          </div>
          <div v-if="state.switchingMode"><dt>Mode</dt><dd>switching (main when triggered)</dd></div>
          <div><dt>Audio</dt><dd>{{ state.hasAudio ? state.audioLabel : 'none' }}</dd></div>
        </dl>

        <template v-if="aoi.length">
          <h3 class="metasec__h">Area of interest</h3>
          <dl class="kv">
            <div v-for="a in aoi" :key="a.name">
              <dt>{{ a.name }}</dt>
              <dd>{{ a.text }}</dd>
            </div>
          </dl>
        </template>

        <template v-if="mask">
          <h3 class="metasec__h">Motion mask</h3>
          <dl class="kv">
            <div><dt>Grid</dt><dd>{{ mask.width }}&times;{{ mask.height }} cells</dd></div>
            <div><dt>Masked</dt><dd>{{ maskedCells }} of {{ mask.width * mask.height }}</dd></div>
            <div><dt>Show motion</dt><dd>{{ maskFlagText }}</dd></div>
          </dl>
          <canvas ref="maskCanvas" class="metapanel__mask" :title="maskTitle"></canvas>
          <p class="metasec__note">{{ maskNote }}</p>
        </template>
      </section>

      <!-- ----------------------------------------------------------- frame -->
      <section v-else-if="tab === 'frame'" class="metasec">
        <h3 class="metasec__h">Frame {{ (state.frameIndex + 1).toLocaleString() }}</h3>
        <dl class="kv">
          <div><dt>Media time</dt><dd>{{ formatTime(frame.ts) }}</dd></div>
          <div><dt>UTC</dt><dd>{{ frame.utc ? formatUtc(frame.utc) : 'absent' }}</dd></div>
          <div><dt>Payload</dt><dd>{{ formatBytes(frame.size) }} at {{ frame.offset.toLocaleString() }}</dd></div>
          <div><dt>Stream</dt><dd>{{ frame.stream }}</dd></div>
          <div><dt>Flags</dt><dd>{{ frame.flagText }}</dd></div>
          <div><dt>Camera state</dt><dd>{{ frame.stateText }}</dd></div>
          <div><dt>DIO inputs</dt><dd>{{ frame.dioText }}</dd></div>
        </dl>

        <h3 class="metasec__h">
          Overlay at this frame
          <span v-if="!state.hasMetadata" class="metasec__badge">no records</span>
        </h3>
        <p v-if="!state.hasMetadata" class="metasec__note">
          This recording carries no overlay metadata frames.
        </p>
        <template v-else>
          <p v-if="!record" class="metasec__note">No overlay record applies at this position yet.</p>
          <template v-else>
            <p class="metasec__note">
              Record {{ record.recordIndex + 1 }} of {{ recordCount }}, written at {{ formatTime(record.ts, false) }}.
            </p>
            <div v-for="obj in objects" :key="obj.index" class="metaobj">
              <div class="metaobj__head">
                <AppIcon :name="obj.icon" :size="15" />
                <span class="metaobj__name">Object {{ obj.index }} &middot; {{ obj.typeName }}</span>
                <span v-if="!obj.drawn" class="metaobj__off" :title="obj.whyHidden">hidden</span>
              </div>
              <p v-if="obj.text" class="metaobj__text">{{ obj.text }}</p>
              <ul v-if="obj.shapes.length" class="metaobj__shapes">
                <li v-for="(s, i) in obj.shapes" :key="i" :class="{ 'metaobj__shape--on': s.triggering }">
                  <span class="metaobj__swatch" :style="{ background: s.color }"></span>
                  <span>{{ s.label || 'box' }}</span>
                  <span class="metaobj__rect">{{ s.rect }}</span>
                </li>
              </ul>
              <p v-if="obj.imageBytes" class="metaobj__note">image, {{ formatBytes(obj.imageBytes) }}</p>
              <p v-if="obj.raw" class="metaobj__note">{{ obj.raw }} bytes this build does not interpret</p>
              <p v-if="obj.empty" class="metaobj__note">empty</p>
            </div>
            <div v-if="gps" class="metaobj">
              <div class="metaobj__head">
                <AppIcon name="mapPin" :size="15" />
                <span class="metaobj__name">GPS</span>
              </div>
              <p class="metaobj__text">
                {{ gps.latitude.toFixed(6) }}, {{ gps.longitude.toFixed(6) }} &middot; {{ gps.altitude.toFixed(1) }} m
              </p>
            </div>
          </template>
        </template>
      </section>

      <!-- -------------------------------------------------------- timeline -->
      <section v-else class="metasec">
        <h3 class="metasec__h">Marks <span class="metasec__badge">{{ state.marks.length }}</span></h3>
        <p v-if="!state.marks.length" class="metasec__note">No marks in this recording.</p>
        <ul v-else class="metalist">
          <li v-for="(m, i) in shownMarks" :key="'m' + i">
            <button type="button" class="metalist__item" @click="$emit('seek', m.ts)">
              <AppIcon name="bookmark" :size="14" />
              <span class="metalist__time">{{ formatTime(m.ts, false) }}</span>
              <span class="metalist__sub">{{ m.utc ? formatUtc(m.utc, false) : 'frame ' + (m.index + 1) }}</span>
            </button>
          </li>
        </ul>
        <p v-if="state.marks.length > shownMarks.length" class="metasec__note">
          Showing the first {{ shownMarks.length }} of {{ state.marks.length }}.
        </p>

        <h3 class="metasec__h">Segment starts <span class="metasec__badge">{{ state.segments.length }}</span></h3>
        <p v-if="!state.segments.length" class="metasec__note">
          One continuous segment &mdash; no discontinuities after the first frame.
        </p>
        <ul v-else class="metalist">
          <li v-for="(s, i) in shownSegments" :key="'s' + i">
            <button type="button" class="metalist__item" @click="$emit('seek', s.ts)">
              <AppIcon name="cut" :size="14" />
              <span class="metalist__time">{{ formatTime(s.ts, false) }}</span>
              <span class="metalist__sub">{{ s.utc ? formatUtc(s.utc, false) : 'frame ' + (s.index + 1) }}</span>
            </button>
          </li>
        </ul>
        <p v-if="state.segments.length > shownSegments.length" class="metasec__note">
          Showing the first {{ shownSegments.length }} of {{ state.segments.length }}.
        </p>
      </section>
    </div>

    <div v-if="state.hasMetadata" class="metapanel__foot">
      <label class="metapanel__toggle">
        <input type="checkbox" :checked="state.overlayEnabled" @change="$emit('overlay', { enabled: $event.target.checked })" />
        <AppIcon name="eye" :size="16" />
        <span>Draw overlays on the video</span>
      </label>
      <div v-if="state.overlayEnabled" class="metapanel__subtoggles">
        <label><input type="checkbox" :checked="show.shapes" @change="$emit('overlay', { shapes: $event.target.checked })" /> boxes</label>
        <label><input type="checkbox" :checked="show.text" @change="$emit('overlay', { text: $event.target.checked })" /> text</label>
        <label><input type="checkbox" :checked="show.graphics" @change="$emit('overlay', { graphics: $event.target.checked })" /> images</label>
      </div>
    </div>
  </div>
</template>

<script>
import AppIcon from './AppIcon.vue'
import { formatBytes, formatTime, formatUtc } from '../util/format.js'
import {
  FLAG_ISKEY, FLAG_ISDISCONTINUITY, FLAG_MARK, FLAG_MAINAVAILABLE, FLAG_SUBSTREAM,
  MASK_FLAG_NAMES, STATE_BIT_NAMES
} from '../bvr/constants.js'
import { colorRefToCss, OBJ_GRAPHIC, OBJ_SHAPES, OBJ_TEXT } from '../bvr/metadata.js'

const LIST_LIMIT = 120

const ICONS = { [OBJ_TEXT]: 'text', [OBJ_GRAPHIC]: 'image', [OBJ_SHAPES]: 'box' }

function bitsText (value, names) {
  if (!value) return 'none'
  const on = names.filter(([bit]) => value & bit).map(([, name]) => name)
  const hex = `0x${value.toString(16)}`
  return on.length ? `${on.join(', ')} (${hex})` : hex
}

export default {
  name: 'MetadataPanel',
  components: { AppIcon },
  props: {
    state: { type: Object, required: true },
    context: { type: Object, default: null },
    show: { type: Object, required: true },
    metadataAt: { type: Function, default: null }
  },
  emits: ['seek', 'overlay'],
  data () {
    return {
      tab: 'frame',
      tabs: [
        { value: 'file', label: 'File' },
        { value: 'frame', label: 'Frame' },
        { value: 'timeline', label: 'Timeline' }
      ],
      record: null
    }
  },
  computed: {
    header () { return this.context ? this.context.header : null },
    pstream () { return this.context ? this.context.pstream : null },
    recordCount () {
      return this.context && this.context.index
        ? this.context.index.metadata.filter((m) => m.subtype === 2).length
        : 0
    },
    endUtc () {
      return this.context && this.context.index ? this.context.index.endUtc : 0
    },
    /**
     * The size the picture is stretched to when the streams disagree in shape,
     * or '' when this stream is already the reference shape. Mirrors the rule in
     * Renderer._effective -- the short axis grows, so nothing is cropped.
     */
    shownAs () {
      const ar = this.state.displayAspect
      const w = this.state.width
      const h = this.state.height
      if (!ar || !w || !h) return ''
      const native = w / h
      if (Math.abs(native - ar) <= ar * 0.01) return ''
      const out = native < ar
        ? { w: Math.round(h * ar), h }
        : { w, h: Math.round(w / ar) }
      return `${out.w} × ${out.h}, rescaled to match`
    },
    orientation () {
      if (!this.header) return ''
      const parts = []
      if (this.header.rotation) parts.push(`rotated ${this.header.rotation}°`)
      if (this.header.flipH) parts.push('mirrored')
      return parts.join(', ')
    },
    aoi () {
      if (!this.header) return []
      const names = ['Main', 'Sub']
      const out = []
      this.header.aoi.forEach((r, i) => {
        if (!r) return
        const empty = r.right <= r.left || r.bottom <= r.top
        out.push({
          name: names[i],
          text: empty ? 'whole frame' : `${r.left}, ${r.top} to ${r.right}, ${r.bottom}`
        })
      })
      return out
    },
    mask () { return this.header ? this.header.mask : null },
    maskedCells () {
      const m = this.mask
      if (!m) return 0
      let n = 0
      for (let i = 0; i < m.bits.length; i++) {
        let b = m.bits[i]
        while (b) { n += b & 1; b >>= 1 }
      }
      return Math.min(n, m.width * m.height)
    },
    maskFlagText () {
      return this.mask ? bitsText(this.mask.showMotionFlags, MASK_FLAG_NAMES) : ''
    },
    maskTitle () {
      return this.mask ? `Motion mask, ${this.mask.width} by ${this.mask.height} cells` : ''
    },
    maskNote () {
      const f = this.mask ? this.mask.showMotionFlags : 0
      // Spec 4.4: blackout and obscure were applied before encoding, so the
      // video already shows them; the rest only described the live view.
      if (f & 0x14) return 'Masked cells were blacked out or blurred before encoding, so the video already reflects them.'
      return 'Recorded for reference; these settings affected the live view, not the stored video.'
    },
    frame () {
      const s = this.pstream
      const i = this.state.frameIndex
      if (!s || i >= s.count) {
        return { ts: 0, utc: 0, size: 0, offset: 0, stream: '', flagText: '', stateText: '', dioText: '' }
      }
      const flags = s.flags[i]
      const names = []
      if (flags & FLAG_ISKEY) names.push('key')
      if (flags & FLAG_ISDISCONTINUITY) names.push('segment start')
      if (flags & FLAG_MARK) names.push('mark')
      if (flags & FLAG_MAINAVAILABLE) names.push('main available')
      return {
        ts: s.ts[i],
        utc: s.utc[i],
        size: s.size[i],
        offset: s.offset[i],
        stream: (flags & FLAG_SUBSTREAM) ? 'sub' : 'main',
        flagText: names.length ? `${names.join(', ')} (0x${flags.toString(16)})` : `0x${flags.toString(16)}`,
        stateText: bitsText(s.state[i], STATE_BIT_NAMES),
        dioText: s.dio[i] ? `0x${s.dio[i].toString(16)}` : 'none'
      }
    },
    /**
     * The overlay objects as they stand at the playhead, with the reason any of
     * them is not being drawn.
     */
    objects () {
      const s = this.pstream
      const i = this.state.frameIndex
      const stateBits = s && i < s.count ? s.state[i] : 0
      const dio = s && i < s.count ? s.dio[i] : 0
      return this.state.overlayList.map((obj) => {
        let whyHidden = ''
        if (obj.stateflags && (stateBits & obj.stateflags) !== obj.stateflags) {
          whyHidden = `requires ${bitsText(obj.stateflags, STATE_BIT_NAMES)}`
        } else if (obj.dio && !(dio & obj.dio)) {
          whyHidden = `requires DIO 0x${obj.dio.toString(16)}`
        }
        return {
          index: obj.index,
          typeName: obj.typeName,
          icon: ICONS[obj.type] || 'layers',
          drawn: !whyHidden,
          whyHidden,
          text: obj.text,
          shapes: obj.shapes.map((sh) => ({
            triggering: sh.triggering,
            label: sh.label,
            // Blue Iris usually leaves box colour at black; fall back to the
            // colours the painter actually uses so the two agree.
            color: colorRefToCss(sh.color || (sh.triggering ? 0x66d1ff : 0xff6658)),
            rect: `${sh.left}, ${sh.top} to ${sh.right}, ${sh.bottom}`
          })),
          imageBytes: obj.imageBytes,
          raw: obj.rawBytes,
          empty: !obj.text && !obj.shapes.length && !obj.imageBytes && !obj.rawBytes
        }
      })
    },
    gps () { return this.state.gps },
    shownMarks () { return this.state.marks.slice(0, LIST_LIMIT) },
    shownSegments () { return this.state.segments.slice(0, LIST_LIMIT) }
  },
  watch: {
    // The record only changes when the playhead crosses one, so this is a read
    // per crossing rather than per frame.
    'state.currentTime' () { this.refreshRecord() },
    'state.hasMetadata' () { this.refreshRecord() },
    tab (value) {
      if (value === 'file') this.$nextTick(() => this.drawMask())
      if (value === 'frame') this.refreshRecord()
    }
  },
  mounted () {
    this.refreshRecord()
    this.$nextTick(() => this.drawMask())
  },
  methods: {
    formatBytes,
    formatTime,
    formatUtc,
    async refreshRecord () {
      if (this.tab !== 'frame' || !this.metadataAt || !this.state.hasMetadata) return
      const at = this.state.currentTime
      const record = await this.metadataAt(at)
      // A newer position may have been asked for while this read was in flight.
      if (Math.abs(this.state.currentTime - at) > 250) return
      this.record = record
    },
    /**
     * Paints the motion-detection grid.
     *
     * Bits are one per cell, row major (spec 4.4). The order within a byte is
     * not stated; most-significant-first is the convention the rest of the
     * format follows, and a wrong guess here only mirrors each group of eight
     * cells rather than misreporting anything.
     */
    drawMask () {
      const canvas = this.$refs.maskCanvas
      const m = this.mask
      if (!canvas || !m || !m.width || !m.height) return
      const cell = Math.max(2, Math.floor(240 / m.width))
      canvas.width = m.width * cell
      canvas.height = m.height * cell
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#11151c'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = 'rgba(88, 166, 255, 0.75)'
      for (let y = 0; y < m.height; y++) {
        for (let x = 0; x < m.width; x++) {
          const bit = y * m.width + x
          const byte = m.bits[bit >> 3]
          if (byte === undefined) continue
          if (byte & (0x80 >> (bit & 7))) ctx.fillRect(x * cell, y * cell, cell, cell)
        }
      }
    }
  }
}
</script>

<style scoped>
.metapanel {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

/* The tab strip stays put while the section under it scrolls; the panel frame
   owns the scroll box, so this is sticky rather than a second scroll area. */
.metapanel__tabs {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  gap: 2px;
  padding: 6px 10px 0;
  background: rgba(18, 22, 29, 0.97);
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.metapanel__tab {
  flex: 1 1 0;
  padding: 6px 4px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.metapanel__tab--on {
  color: var(--text);
  border-bottom-color: var(--accent);
}

.metapanel__content {
  flex: 1 1 auto;
  padding: 12px 13px 16px;
}

.metasec__h {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 14px 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-dim);
}

.metasec__h:first-child {
  margin-top: 0;
}

.metasec__badge {
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.09);
  font-size: 10px;
  letter-spacing: 0;
  text-transform: none;
}

.metasec__note {
  margin: 4px 0 0;
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.5;
}

.kv {
  margin: 0;
  font-size: 12px;
}

.kv > div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 3px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.kv dt {
  flex: 0 0 auto;
  color: var(--text-dim);
}

.kv dd {
  margin: 0;
  text-align: right;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}

.kv--warn {
  color: var(--warn);
}

.metapanel__mask {
  display: block;
  width: 100%;
  max-width: 240px;
  margin: 8px 0 0;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  image-rendering: pixelated;
}

.metaobj {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
}

.metaobj__head {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.metaobj__name {
  flex: 1 1 auto;
}

.metaobj__off {
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  font-size: 10px;
}

.metaobj__text {
  margin: 6px 0 0;
  font: 500 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.metaobj__note {
  margin: 5px 0 0;
  color: var(--text-dim);
  font-size: 11px;
}

.metaobj__shapes {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  font-size: 11.5px;
}

.metaobj__shapes li {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 2px 0;
  color: var(--text-dim);
}

.metaobj__shape--on {
  color: var(--warn);
}

.metaobj__swatch {
  width: 9px;
  height: 9px;
  flex: none;
  border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
}

.metaobj__rect {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  white-space: nowrap;
}

.metalist {
  margin: 0;
  padding: 0;
  list-style: none;
}

.metalist__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 7px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.metalist__item:hover {
  background: rgba(255, 255, 255, 0.09);
}

.metalist__time {
  font-variant-numeric: tabular-nums;
}

.metalist__sub {
  margin-left: auto;
  color: var(--text-dim);
  font-size: 11px;
}

.metapanel__foot {
  flex: none;
  padding: 10px 13px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.09);
}

.metapanel__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  cursor: pointer;
}

.metapanel__toggle input,
.metapanel__subtoggles input {
  accent-color: var(--accent);
}

.metapanel__subtoggles {
  display: flex;
  gap: 12px;
  margin: 7px 0 0 24px;
  color: var(--text-dim);
  font-size: 11.5px;
}

.metapanel__subtoggles label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
</style>
