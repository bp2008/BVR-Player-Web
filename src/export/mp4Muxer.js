import { concat } from './bitstream.js'

/**
 * A single-pass ISO base media file writer, sized to what a BVR export needs.
 *
 * The job is narrow in exactly the ways that make an MP4 writer small: at most
 * two tracks, no B-frames (spec 5.4 -- decode order is presentation order), so
 * no composition offsets and no edit lists, and a complete sample table that the
 * caller already holds before a byte is written.
 *
 * Layout is `ftyp`, then `mdat`, then `moov`. Putting the index last is what
 * keeps this to one pass: sample sizes are only known once each sample has been
 * converted or encoded, and reading the source twice to learn them in advance
 * would double the I/O on a file that may be gigabytes. The `mdat` length is
 * back-patched at the end, which every sink here supports. The trade is that the
 * result is not "faststart" -- irrelevant for a file being written to disk for
 * local use, and the one thing that would fix it is the second pass just ruled
 * out.
 */

const MOVIE_TIMESCALE = 1000

// Seconds between 1904-01-01 (the MP4 epoch) and 1970-01-01.
const MP4_EPOCH_OFFSET = 2082844800

const UNITY_MATRIX = [
  0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000
]

const enc = new TextEncoder()

function fourcc (s) { return enc.encode(s) }

/** An ISO box: 4-byte size, 4-byte type, payload. */
function box (type, ...payload) {
  const body = concat(payload.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p))))
  const out = new Uint8Array(8 + body.length)
  new DataView(out.buffer).setUint32(0, out.length)
  out.set(fourcc(type), 4)
  out.set(body, 8)
  return out
}

/** A FullBox: version byte plus 24 bits of flags ahead of the payload. */
function fullBox (type, version, flags, ...payload) {
  return box(type, Uint8Array.from([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...payload)
}

function u8 (...v) { return Uint8Array.from(v) }

function u16 (v) {
  const out = new Uint8Array(2)
  new DataView(out.buffer).setUint16(0, v)
  return out
}

function u32 (v) {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, v >>> 0)
  return out
}

function u64 (v) {
  const out = new Uint8Array(8)
  const view = new DataView(out.buffer)
  view.setUint32(0, Math.floor(v / 4294967296))
  view.setUint32(4, v >>> 0)
  return out
}

function s16 (v) {
  const out = new Uint8Array(2)
  new DataView(out.buffer).setInt16(0, v)
  return out
}

function u32Array (values) {
  const out = new Uint8Array(values.length * 4)
  const view = new DataView(out.buffer)
  for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i] >>> 0)
  return out
}

/** Fixed-length, space-padded, null-terminated string (mp4a/avc1 compressorname). */
function pascal32 (s) {
  const out = new Uint8Array(32)
  const bytes = enc.encode(s).subarray(0, 31)
  out[0] = bytes.length
  out.set(bytes, 1)
  return out
}

class Track {
  constructor (id, kind, timescale) {
    this.id = id
    this.kind = kind
    this.timescale = timescale
    this.sizes = []
    this.durations = []
    // Presentation times, kept only when a caller supplies them. BVR itself has
    // no B-frames, but a re-encode goes through whatever the platform's encoder
    // does, and some will reorder.
    this.pts = []
    this.syncSamples = []
    this.chunkOffsets = []
    this.chunkCounts = []
    this.duration = 0
    this.sampleCount = 0
    this._openChunk = false
  }

  get allSync () { return this.syncSamples.length === this.sampleCount }
}

export class Mp4Muxer {
  constructor ({ sink }) {
    this.sink = sink
    this.tracks = []
    this.position = 0
    this.mdatStart = 0
    this.mdatBodyStart = 0
    this._started = false
  }

  addVideoTrack ({ entry, width, height, config, timescale, name = 'BVR video' }) {
    const t = new Track(this.tracks.length + 1, 'video', timescale)
    t.entry = entry
    t.width = width
    t.height = height
    t.config = config
    t.name = name
    this.tracks.push(t)
    return t
  }

  addAudioTrack ({ entry = 'mp4a', sampleRate, channels, config, objectType = 0x40, name = 'BVR audio' }) {
    const t = new Track(this.tracks.length + 1, 'audio', sampleRate)
    t.entry = entry
    t.sampleRate = sampleRate
    t.channels = channels
    t.config = config
    t.objectType = objectType
    t.name = name
    this.tracks.push(t)
    return t
  }

  async _emit (bytes) {
    await this.sink.write(bytes)
    this.position += bytes.length
  }

  /** Writes the file type box and opens `mdat` with a patchable 64-bit length. */
  async start () {
    if (this._started) return
    this._started = true
    // isom + the brands for whichever codecs are actually present, so a strict
    // player can tell at a glance that it can handle the file.
    const brands = ['isom', 'iso2', 'mp41']
    for (const t of this.tracks) {
      if (t.entry === 'avc1' && !brands.includes('avc1')) brands.push('avc1')
      if (t.entry === 'hvc1' && !brands.includes('hvc1')) brands.push('hvc1')
    }
    await this._emit(box('ftyp', fourcc(brands[0]), u32(0x200), ...brands.map(fourcc)))

    this.mdatStart = this.position
    // The "1" size marks a 64-bit largesize, which follows the type. Committing
    // to it up front means a two-hour export cannot outgrow its own header.
    await this._emit(concat([u32(1), fourcc('mdat'), u64(0)]))
    this.mdatBodyStart = this.position
  }

  /** Starts a new run of samples for one track at the current file position. */
  beginChunk (track) {
    track.chunkOffsets.push(this.position)
    track.chunkCounts.push(0)
    track._openChunk = true
  }

  async writeSample (track, bytes, { duration, isKey = true, pts = null }) {
    if (!track._openChunk) this.beginChunk(track)
    await this._emit(bytes)
    track.sizes.push(bytes.length)
    if (pts !== null) track.pts.push(pts)
    // Zero-length samples are legal but confuse players; BVR timestamps may
    // repeat (spec 5), so a floor of one tick keeps every sample addressable.
    const ticks = Math.max(1, Math.round(duration))
    track.durations.push(ticks)
    track.duration += ticks
    track.sampleCount++
    track.chunkCounts[track.chunkCounts.length - 1]++
    if (isKey) track.syncSamples.push(track.sampleCount)
  }

  endChunk (track) {
    if (!track._openChunk) return
    track._openChunk = false
    // A chunk nothing was written into would leave a stale offset behind.
    if (track.chunkCounts[track.chunkCounts.length - 1] === 0) {
      track.chunkCounts.pop()
      track.chunkOffsets.pop()
    }
  }

  /** Closes `mdat`, writes `moov`, and patches the length left behind at the start. */
  async finalize () {
    for (const t of this.tracks) this.endChunk(t)
    const mdatLength = this.position - this.mdatStart
    await this._emit(this._moov())
    await this.sink.patch(this.mdatStart + 8, u64(mdatLength))
    await this.sink.close()
    return { size: this.position }
  }

  _movieDuration () {
    let longest = 0
    for (const t of this.tracks) {
      longest = Math.max(longest, (t.duration / t.timescale) * MOVIE_TIMESCALE)
    }
    return Math.round(longest)
  }

  _moov () {
    const now = Math.floor(Date.now() / 1000) + MP4_EPOCH_OFFSET
    const parts = [this._mvhd(now)]
    for (const t of this.tracks) parts.push(this._trak(t, now))
    return box('moov', ...parts)
  }

  _mvhd (now) {
    return fullBox('mvhd', 0, 0,
      u32(now), u32(now), u32(MOVIE_TIMESCALE), u32(this._movieDuration()),
      u32(0x00010000),                    // rate 1.0
      u16(0x0100),                        // volume 1.0
      u16(0), u32(0), u32(0),             // reserved
      u32Array(UNITY_MATRIX),
      u32Array([0, 0, 0, 0, 0, 0]),       // pre_defined
      u32(this.tracks.length + 1))        // next_track_ID
  }

  _trak (track, now) {
    const durationInMovie = Math.round((track.duration / track.timescale) * MOVIE_TIMESCALE)
    // Enabled | in movie | in preview.
    const tkhd = fullBox('tkhd', 0, 0x7,
      u32(now), u32(now), u32(track.id), u32(0), u32(durationInMovie),
      u32(0), u32(0),                     // reserved
      s16(0),                             // layer
      s16(0),                             // alternate_group
      u16(track.kind === 'audio' ? 0x0100 : 0),
      u16(0),
      u32Array(UNITY_MATRIX),
      // Display size is 16.16 fixed point; audio tracks have none.
      u32(track.kind === 'video' ? track.width * 65536 : 0),
      u32(track.kind === 'video' ? track.height * 65536 : 0))

    const mdhd = fullBox('mdhd', 0, 0,
      u32(now), u32(now), u32(track.timescale), u32(track.duration),
      // 0x55c4 packs the ISO-639-2/T code "und" as three 5-bit letters.
      u16(0x55c4), u16(0))

    const hdlr = fullBox('hdlr', 0, 0,
      u32(0),
      fourcc(track.kind === 'video' ? 'vide' : 'soun'),
      u32(0), u32(0), u32(0),
      enc.encode(track.kind === 'video' ? 'VideoHandler\0' : 'SoundHandler\0'))

    const media = track.kind === 'video'
      ? fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0))
      : fullBox('smhd', 0, 0, s16(0), u16(0))

    const dinf = box('dinf',
      fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)))

    const minf = box('minf', media, dinf, this._stbl(track))
    return box('trak', tkhd, box('mdia', mdhd, hdlr, minf))
  }

  _stbl (track) {
    const parts = [
      box('stsd', u8(0, 0, 0, 0), u32(1), this._sampleEntry(track)),
      this._stts(track),
      this._stsc(track),
      this._stsz(track),
      this._stco(track)
    ]
    // A sync-sample table is only meaningful when some samples are not sync;
    // omitting it is how MP4 says "every sample is a random access point".
    if (track.kind === 'video' && !track.allSync && track.syncSamples.length) {
      parts.splice(2, 0, fullBox('stss', 0, 0, u32(track.syncSamples.length), u32Array(track.syncSamples)))
    }
    const ctts = this._ctts(track)
    if (ctts) parts.splice(2, 0, ctts)
    return box('stbl', ...parts)
  }

  /**
   * Composition offsets, present only when the samples were written in an order
   * other than the one they are shown in.
   *
   * A stream copy never needs this -- BVR stores frames in presentation order
   * (spec 5.4) -- and a re-encode normally does not either, since the encoder is
   * configured against reordering. It is here so that an encoder which reorders
   * anyway produces a correct file rather than a subtly wrong one.
   */
  _ctts (track) {
    if (track.pts.length !== track.sampleCount || !track.sampleCount) return null
    const offsets = new Array(track.sampleCount)
    let dts = 0
    let any = false
    let negative = false
    for (let i = 0; i < track.sampleCount; i++) {
      const delta = Math.round(track.pts[i] - dts)
      offsets[i] = delta
      if (delta !== 0) any = true
      if (delta < 0) negative = true
      dts += track.durations[i]
    }
    if (!any) return null

    const entries = []
    for (const delta of offsets) {
      const last = entries[entries.length - 1]
      if (last && last[1] === delta) last[0]++
      else entries.push([1, delta])
    }
    const body = new Uint8Array(entries.length * 8)
    const view = new DataView(body.buffer)
    for (let i = 0; i < entries.length; i++) {
      view.setUint32(i * 8, entries[i][0])
      if (negative) view.setInt32(i * 8 + 4, entries[i][1])
      else view.setUint32(i * 8 + 4, entries[i][1])
    }
    return fullBox('ctts', negative ? 1 : 0, 0, u32(entries.length), body)
  }

  _sampleEntry (track) {
    if (track.kind === 'audio') return this._audioEntry(track)
    const configBox = track.entry === 'hvc1'
      ? box('hvcC', track.config)
      : box('avcC', track.config)
    return box(track.entry,
      u8(0, 0, 0, 0, 0, 0),               // reserved
      u16(1),                             // data_reference_index
      u16(0), u16(0), u32(0), u32(0), u32(0),   // pre_defined / reserved
      u16(track.width), u16(track.height),
      u32(0x00480000), u32(0x00480000),   // 72 dpi horizontal / vertical
      u32(0),
      u16(1),                             // frame_count
      pascal32(track.name),
      u16(0x0018),                        // depth: colour, no alpha
      s16(-1),                            // pre_defined
      configBox)
  }

  _audioEntry (track) {
    return box(track.entry,
      u8(0, 0, 0, 0, 0, 0),
      u16(1),                             // data_reference_index
      u32(0), u32(0),                     // reserved
      u16(Math.min(2, track.channels)),
      u16(16),                            // sample size
      u16(0), u16(0),
      // 16.16 fixed point, and the field is only 16 bits wide for the integer
      // part -- rates above 65535 are written as 0, which mdhd already carries.
      u32(track.sampleRate < 65536 ? track.sampleRate * 65536 : 0),
      this._esds(track))
  }

  /**
   * `esds` -- an MPEG-4 elementary stream descriptor wrapping the codec's
   * AudioSpecificConfig. The descriptor lengths are all short enough for the
   * single-byte form of the expandable-size encoding.
   */
  _esds (track) {
    const asc = track.config || new Uint8Array(0)
    const dsi = asc.length ? concat([u8(0x05, asc.length), asc]) : new Uint8Array(0)
    const decoderConfig = concat([
      u8(0x04, 13 + dsi.length),
      u8(track.objectType, 0x15),         // objectTypeIndication, streamType audio
      u8(0, 0, 0),                        // bufferSizeDB
      u32(0), u32(0),                     // max / average bitrate: unspecified
      dsi
    ])
    const slConfig = u8(0x06, 0x01, 0x02)
    const es = concat([
      u8(0x03, 3 + decoderConfig.length + slConfig.length),
      u16(track.id),
      u8(0),                              // no flags: no URL, no OCR, no dependency
      decoderConfig,
      slConfig
    ])
    return fullBox('esds', 0, 0, es)
  }

  /** Run-length compressed sample durations. */
  _stts (track) {
    const entries = []
    for (let i = 0; i < track.durations.length; i++) {
      const d = track.durations[i]
      const last = entries[entries.length - 1]
      if (last && last[1] === d) last[0]++
      else entries.push([1, d])
    }
    const flat = []
    for (const [count, delta] of entries) flat.push(count, delta)
    return fullBox('stts', 0, 0, u32(entries.length), u32Array(flat))
  }

  /** Sample-to-chunk, compressed across chunks that hold the same count. */
  _stsc (track) {
    const entries = []
    for (let i = 0; i < track.chunkCounts.length; i++) {
      const count = track.chunkCounts[i]
      const last = entries[entries.length - 1]
      if (last && last[1] === count) continue
      entries.push([i + 1, count, 1])
    }
    const flat = []
    for (const e of entries) flat.push(e[0], e[1], e[2])
    return fullBox('stsc', 0, 0, u32(entries.length), u32Array(flat))
  }

  _stsz (track) {
    // A constant sample size can be stated once instead of listed; that is never
    // true of compressed video but is common for raw audio.
    const uniform = track.sizes.length > 0 && track.sizes.every((s) => s === track.sizes[0])
    if (uniform) return fullBox('stsz', 0, 0, u32(track.sizes[0]), u32(track.sizes.length))
    return fullBox('stsz', 0, 0, u32(0), u32(track.sizes.length), u32Array(track.sizes))
  }

  _stco (track) {
    const offsets = track.chunkOffsets
    const needs64 = offsets.some((o) => o > 0xffffffff)
    if (!needs64) return fullBox('stco', 0, 0, u32(offsets.length), u32Array(offsets))
    const body = new Uint8Array(offsets.length * 8)
    for (let i = 0; i < offsets.length; i++) body.set(u64(offsets[i]), i * 8)
    return fullBox('co64', 0, 0, u32(offsets.length), body)
  }
}
