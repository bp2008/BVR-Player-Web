import { parseMp4, Mp4FormatError } from './parseMp4.js'
import { describeVideoEntry, describeAudioEntry } from './codecConfig.js'
import { summarizeProbe, checkCodecSupport } from '../bvr/probe.js'
import { FLAG_ISKEY, WAVE_FORMAT_PCM } from '../bvr/constants.js'

/**
 * Presents an MP4 as the three objects the player already knows how to consume:
 * a `header`, an `index`, and a `probe`.
 *
 * This is the entire adapter, and its shape is the argument for why MP4 support
 * did not require rewriting the player. Everything above `BvrPlayer.open` --
 * the decode pipelines, the frame window, the renderer, the scrub bar, zoom,
 * snapshots, export -- speaks only in terms of a frame table of parallel arrays
 * and a handful of header fields. An MP4 sample table *is* that frame table; it
 * simply arrives already built instead of having to be scanned for.
 *
 * The one place the two containers genuinely differ is frame ordering. BVR
 * guarantees decode order is presentation order (spec 5.4) and the pipeline was
 * written to that. MP4 does not, so where a file has B-frames this module also
 * builds the permutation that lets the pipeline feed in decode order while
 * everything else keeps counting in presentation order. See `orderFrames`.
 */

export { Mp4FormatError }

/** Media-timescale ticks to milliseconds. */
const toMs = (ticks, timescale) => (ticks / timescale) * 1000

/**
 * Builds the decode-order/presentation-order mapping for one track.
 *
 * Without B-frames -- which is every BVR recording and most surveillance MP4s --
 * composition offsets are all zero, the two orders are identical, and this
 * returns nothing at all so the pipeline stays on its original path.
 *
 * With them, the sample table is re-expressed in *presentation* order, because
 * that is the order the player counts frames in: the scrub bar, the frame
 * counter, single-frame stepping and the time binary-search all require `ts` to
 * ascend. Decode order is then preserved separately as a permutation:
 *
 *   `feedOrder[step]` -- the frame to feed at decode step `step`
 *   `feedPos[i]`      -- the decode step at which frame `i` is fed
 *   `feedHigh[i]`     -- the highest decode step among frames 0..i
 *
 * `feedHigh` is what bounds the pipeline's look-ahead safely. Feeding every step
 * up to `feedHigh[i]` guarantees every frame up to `i` has been handed to the
 * decoder -- which a bound expressed in presentation order cannot promise, and
 * getting that wrong deadlocks: the decoder sits waiting for input that the
 * feed has decided is too far ahead to send.
 */
function orderFrames (table) {
  const count = table.count
  let reordered = false
  for (let i = 0; i < count; i++) {
    if (table.cts[i] !== table.dts[i]) { reordered = true; break }
  }
  if (!reordered) return null

  // Decode indices sorted by composition time. A stable sort keeps samples that
  // share a composition stamp -- which happens on malformed files -- in decode
  // order, so the sequence never doubles back on itself.
  const pres = new Int32Array(count)
  for (let i = 0; i < count; i++) pres[i] = i
  const order = Array.from(pres)
  order.sort((a, b) => (table.cts[a] - table.cts[b]) || (a - b))
  for (let p = 0; p < count; p++) pres[p] = order[p]

  const feedOrder = new Int32Array(count) // decode step -> presentation index
  const feedPos = new Int32Array(count)   // presentation index -> decode step
  for (let p = 0; p < count; p++) {
    feedOrder[pres[p]] = p
    feedPos[p] = pres[p]
  }
  const feedHigh = new Int32Array(count)
  let high = -1
  for (let p = 0; p < count; p++) {
    if (feedPos[p] > high) high = feedPos[p]
    feedHigh[p] = high
  }
  return { pres, feedOrder, feedPos, feedHigh }
}

/**
 * Converts one video track's sample table into a stream table of the shape the
 * BVR indexer produces.
 *
 * `baseMs` shifts every stream in the file onto a shared origin, exactly as the
 * BVR indexer rebases both of its streams onto the first frame's timestamp.
 */
function videoStream (track, baseMs, startUtc) {
  const t = table(track)
  const count = t.count
  const ordering = orderFrames(t)
  const at = ordering ? (p) => ordering.pres[p] : (p) => p
  const shift = track.edit.shiftMs || 0

  const s = {
    count,
    offset: new Float64Array(count),
    size: new Uint32Array(count),
    ts: new Float64Array(count),
    utc: new Float64Array(count),
    flags: new Uint16Array(count),
    dio: new Uint32Array(count),
    state: new Uint32Array(count),
    keyIdx: new Int32Array(count),
    keys: null,
    // When the frame decodes, as opposed to when it is shown. Playback has no
    // use for it -- the pipeline works in decode *steps*, not decode times --
    // but an export that copies frames into another MP4 has to write the
    // composition offsets back out, and those are the difference between these
    // two. Null where the orders coincide and the difference is always zero.
    dts: ordering ? new Float64Array(count) : null,
    // Null on a stream whose frames decode in the order they are shown, which
    // is what the pipeline treats as "no permutation, walk straight through".
    feedOrder: ordering ? ordering.feedOrder : null,
    feedPos: ordering ? ordering.feedPos : null,
    feedHigh: ordering ? ordering.feedHigh : null,
    reordered: !!ordering
  }

  for (let p = 0; p < count; p++) {
    const d = at(p)
    s.offset[p] = t.offset[d]
    s.size[p] = t.size[d]
    s.ts[p] = toMs(t.cts[d], track.timescale) + shift - baseMs
    if (s.dts) s.dts[p] = toMs(t.dts[d], track.timescale) + shift - baseMs
    s.utc[p] = startUtc ? startUtc + s.ts[p] : 0
    s.flags[p] = t.sync[d] ? FLAG_ISKEY : 0
  }

  // Key-frame back-references, computed in *decode* order and then mapped back.
  // A restart has to begin at a sync sample the decoder will actually reach by
  // feeding forward, and "the nearest key frame before this one on screen" is
  // not that sample when frames are reordered.
  const keys = []
  if (ordering) {
    const keyForStep = new Int32Array(count)
    let lastKeyStep = -1
    for (let step = 0; step < count; step++) {
      const p = ordering.feedOrder[step]
      if (s.flags[p] & FLAG_ISKEY) lastKeyStep = step
      keyForStep[step] = lastKeyStep
    }
    for (let p = 0; p < count; p++) {
      const step = ordering.feedPos[p]
      const k = keyForStep[step]
      s.keyIdx[p] = k >= 0 ? ordering.feedOrder[k] : -1
    }
    for (let p = 0; p < count; p++) if (s.flags[p] & FLAG_ISKEY) keys.push(p)
  } else {
    let last = -1
    for (let p = 0; p < count; p++) {
      if (s.flags[p] & FLAG_ISKEY) { last = p; keys.push(p) }
      s.keyIdx[p] = last
    }
  }
  s.keys = Int32Array.from(keys)
  return s
}

/** An empty stream table, for the second slot when the file has one video track. */
function emptyStream () {
  return {
    count: 0,
    offset: new Float64Array(0),
    size: new Uint32Array(0),
    ts: new Float64Array(0),
    utc: new Float64Array(0),
    flags: new Uint16Array(0),
    dio: new Uint32Array(0),
    state: new Uint32Array(0),
    keyIdx: new Int32Array(0),
    keys: new Int32Array(0),
    dts: null,
    feedOrder: null,
    feedPos: null,
    feedHigh: null,
    reordered: false
  }
}

const table = (track) => track.table

/** The nominal frame interval in microseconds, from the median sample duration. */
function frameIntervalUs (track) {
  const t = table(track)
  if (t.count < 2) return 0
  const samples = []
  const step = Math.max(1, Math.floor(t.count / 400))
  for (let i = step; i < t.count; i += step) {
    const d = t.dts[i] - t.dts[i - step]
    if (d > 0) samples.push(d / step)
  }
  if (!samples.length) return 0
  samples.sort((a, b) => a - b)
  const ticks = samples[samples.length >> 1]
  return Math.round(toMs(ticks, track.timescale) * 1000)
}

/** A `BITMAPINFOHEADER`-shaped record, so the aspect machinery reads it as usual. */
function bmihFor (described) {
  if (!described) return null
  return {
    biSize: 40,
    biWidth: described.declaredWidth,
    biHeight: described.declaredHeight,
    biCompression: 0,
    // The MP4 sample entry type stands in for the BVR FourCC. It is what the
    // export path keys its "can this be copied rather than re-encoded" decision
    // on, and it is what the inspector shows.
    fourcc: described.entryType,
    width: described.declaredWidth,
    height: described.declaredHeight
  }
}

/** A silent `WAVEFORMATEX`, for a file with no audio track. */
function silentWfx () {
  return {
    wFormatTag: WAVE_FORMAT_PCM,
    nChannels: 0,
    nSamplesPerSec: 0,
    nAvgBytesPerSec: 0,
    nBlockAlign: 0,
    wBitsPerSample: 0,
    cbSize: 0
  }
}

/** Picks the video tracks to play, largest picture first. */
function rankVideoTracks (tracks, described) {
  return tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.kind === 'video' && t.table.count > 0)
    .sort((a, b) => {
      const A = described.get(a.t) || {}
      const B = described.get(b.t) || {}
      return (B.width || 0) * (B.height || 0) - (A.width || 0) * (A.height || 0)
    })
    .map(({ t }) => t)
}

/**
 * Opens an MP4 and produces the player's three objects.
 *
 * A file with two video tracks is mapped onto the main/sub pair the player
 * already has -- the larger picture becomes "main" -- so the stream menu, the
 * coverage banding and the export's stream selection all work without knowing
 * that "main" and "sub" are Blue Iris's words rather than MP4's.
 */
export async function openMp4 (reader, { onProgress, shouldStop } = {}) {
  const movie = await parseMp4(reader, { onProgress, shouldStop })

  const described = new Map()
  for (const track of movie.tracks) {
    const entry = track.entries[0]
    if (!entry) continue
    described.set(track, track.kind === 'audio'
      ? describeAudioEntry(movie.moovBuffer, entry)
      : describeVideoEntry(movie.moovBuffer, entry, track))
  }

  const videoTracks = rankVideoTracks(movie.tracks, described)
  if (!videoTracks.length) throw new Mp4FormatError('This MP4 has no video track.')
  const audioTrack = movie.tracks.find((t) => t.kind === 'audio' && t.table.count > 0) || null

  const incomplete = videoTracks.filter((t) => !t.complete)
  if (incomplete.length === videoTracks.length) {
    throw new Mp4FormatError('This MP4\'s sample table is inconsistent; its frames cannot be located.')
  }

  // Everything is rebased onto the earliest presentation time in the file, which
  // is what makes an MP4's timeline and a BVR's interchangeable downstream.
  let baseMs = Infinity
  for (const track of [...videoTracks, ...(audioTrack ? [audioTrack] : [])]) {
    const t = table(track)
    if (!t.count) continue
    const shift = track.edit.shiftMs || 0
    let earliest = Infinity
    // The first sample in decode order is not always the first on screen.
    for (let i = 0; i < Math.min(t.count, 64); i++) earliest = Math.min(earliest, t.cts[i])
    baseMs = Math.min(baseMs, toMs(earliest, track.timescale) + shift)
  }
  if (!Number.isFinite(baseMs)) baseMs = 0

  const startUtc = movie.created || 0
  const primary = videoTracks[0]
  const secondary = videoTracks[1] || null

  const streams = [
    videoStream(primary, baseMs, startUtc),
    secondary ? videoStream(secondary, baseMs, startUtc) : emptyStream()
  ]

  // Audio, in the same shape the BVR indexer produces -- plus the exact packet
  // start times, which BVR has to reconstruct from sample counts because its
  // per-packet stamps are unreliable (spec 6) and MP4 simply states.
  const audio = { count: 0, offset: new Float64Array(0), size: new Uint32Array(0), ts: new Float64Array(0), starts: null }
  if (audioTrack) {
    const t = table(audioTrack)
    const shift = audioTrack.edit.shiftMs || 0
    audio.count = t.count
    audio.offset = new Float64Array(t.count)
    audio.size = new Uint32Array(t.count)
    audio.ts = new Float64Array(t.count)
    audio.starts = new Float64Array(t.count)
    for (let i = 0; i < t.count; i++) {
      audio.offset[i] = t.offset[i]
      audio.size[i] = t.size[i]
      const ms = toMs(t.dts[i], audioTrack.timescale) + shift - baseMs
      audio.ts[i] = ms
      audio.starts[i] = ms
    }
  }

  const audioInfo = audioTrack ? described.get(audioTrack) : null
  const hasAudio = !!(audioTrack && audioInfo && audioInfo.kind !== 'unsupported')

  // The movie header's duration is measured from time zero; everything else
  // here has been rebased onto the first picture, so it has to be too.
  let durationMs = Math.max(0, movie.movieDurationMs - baseMs)
  for (const s of streams) {
    if (s.count) durationMs = Math.max(durationMs, s.ts[s.count - 1])
  }
  if (audio.count) durationMs = Math.max(durationMs, audio.ts[audio.count - 1])

  const primaryInfo = described.get(primary)
  const secondaryInfo = secondary ? described.get(secondary) : null

  const header = {
    container: 'mp4',
    frameInterval: frameIntervalUs(primary),
    fps: 0,
    startUtc,
    flags: 0,
    rotation: primary.rotation,
    flipH: primary.flipH,
    hasSubHeader: !!secondary,
    // MP4 has no equivalent of Blue Iris's "record both streams and switch
    // between them"; two video tracks in an MP4 both run the whole file.
    switchingMode: false,
    wfx: (audioInfo && audioInfo.wfx) || silentWfx(),
    audioExtradata: null,
    // What the BVR path derives from `wfx` and `audioExtradata`, stated outright
    // because the container knows it. See AudioPipeline.
    audioConfig: hasAudio
      ? { kind: audioInfo.kind, label: audioInfo.label, config: audioInfo.config || null, wfx: audioInfo.wfx || null }
      : null,
    hasAudio,
    bmih: [bmihFor(primaryInfo), bmihFor(secondaryInfo)],
    // BVR-only header content. Present and empty so the panels that read them
    // need no container test of their own.
    aoi: [null, null],
    mask: null,
    firstFrameOffset: 0,
    // Everything the inspector shows about the container itself.
    mp4: {
      brands: movie.brands,
      movieTimescale: movie.movieTimescale,
      fragmented: movie.fragmented,
      fragments: movie.fragments,
      moovBytes: movie.moovBytes,
      moovAt: movie.moovAt,
      mdatBytes: movie.mdatBytes,
      layout: movie.layout,
      tracks: movie.tracks.map((t) => ({
        id: t.id,
        kind: t.kind,
        handler: t.handler,
        timescale: t.timescale,
        samples: t.table.count,
        durationMs: toMs(t.mediaDuration, t.timescale),
        reordered: t.reordered,
        fragmented: t.fragmented,
        rotation: t.rotation,
        flipH: t.flipH,
        editEntries: t.edit.entries,
        entry: (described.get(t) || {}).entryType || '',
        label: (described.get(t) || {}).label || '',
        width: (described.get(t) || {}).width || 0,
        height: (described.get(t) || {}).height || 0,
        pasp: (described.get(t) || {}).pasp || null
      }))
    }
  }
  header.fps = header.frameInterval > 0 ? 1e6 / header.frameInterval : 0

  const index = {
    container: 'mp4',
    totalFrames: streams[0].count + streams[1].count + audio.count,
    streams,
    audio,
    metadata: [],
    marks: [],
    baseTs: baseMs,
    durationMs,
    startUtc,
    endUtc: startUtc ? startUtc + durationMs : 0,
    truncated: movie.truncated,
    resyncs: 0,
    switchingMode: false
  }

  const probe = await probeTracks([primaryInfo, secondaryInfo])
  return { header, index, probe, movie }
}

/** The probe verdict, in the shape `summarizeProbe` produces for a BVR file. */
async function probeTracks (infos) {
  const names = ['main', 'sub']
  const out = [null, null]
  for (let i = 0; i < 2; i++) {
    const info = infos[i]
    if (!info) continue
    const { supported, reason } = await checkCodecSupport(info)
    out[i] = {
      name: names[i],
      present: true,
      // An MP4 states its codec rather than being sampled for it, so the verdict
      // is firm without a key frame having been read.
      hasKeyFrame: true,
      fourcc: info.entryType,
      width: info.width,
      height: info.height,
      declaredWidth: info.declaredWidth,
      declaredHeight: info.declaredHeight,
      codec: info,
      supported,
      reason
    }
  }
  return summarizeProbe(out)
}
