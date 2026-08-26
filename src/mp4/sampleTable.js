import { walk, find, findAll, descend, fullBoxHeader, typeAt } from './boxes.js'

/**
 * Turns a track's `stbl` -- or a run of movie fragments -- into one flat sample
 * table.
 *
 * The flat form is the whole point of this module. An MP4 stores sample timing,
 * sizes and file positions in five separate run-length-coded tables that have to
 * be walked together, and every consumer in this app wants the same thing the
 * BVR indexer already produces: one entry per frame, giving where it is, how big
 * it is, when it decodes and when it is shown. Expanding once on open costs a
 * few megabytes on an hour-long recording and makes every seek afterwards a
 * subscript rather than a search.
 */

/** An empty table, sized for `count` samples. */
function emptyTable (count) {
  return {
    count,
    // Float64 because a sample may sit past 4 GB in a long recording, and
    // because the BVR index uses the same type for the same reason.
    offset: new Float64Array(count),
    size: new Uint32Array(count),
    dts: new Float64Array(count),
    cts: new Float64Array(count),
    duration: new Uint32Array(count),
    sync: new Uint8Array(count)
  }
}

/** Sample sizes from `stsz` (fixed or per-sample) or `stz2` (packed). */
function readSizes (bytes, view, stbl) {
  const stsz = find(bytes, stbl.body, stbl.end, 'stsz')
  if (stsz) {
    const uniform = view.getUint32(stsz.body + 4)
    const count = view.getUint32(stsz.body + 8)
    const out = new Uint32Array(count)
    if (uniform) {
      out.fill(uniform)
    } else {
      let at = stsz.body + 12
      for (let i = 0; i < count && at + 4 <= stsz.end; i++, at += 4) out[i] = view.getUint32(at)
    }
    return out
  }

  const stz2 = find(bytes, stbl.body, stbl.end, 'stz2')
  if (!stz2) return null
  const fieldSize = view.getUint8(stz2.body + 7)
  const count = view.getUint32(stz2.body + 8)
  const out = new Uint32Array(count)
  let at = stz2.body + 12

  if (fieldSize === 4) {
    // Two samples to a byte, the earlier one in the high nibble.
    for (let i = 0; i < count; i += 2, at++) {
      const b = view.getUint8(at)
      out[i] = b >> 4
      if (i + 1 < count) out[i + 1] = b & 0x0f
    }
    return out
  }
  const step = fieldSize === 16 ? 2 : 1
  for (let i = 0; i < count && at + step <= stz2.end; i++, at += step) {
    out[i] = fieldSize === 16 ? view.getUint16(at) : view.getUint8(at)
  }
  return out
}

/** Chunk file offsets from `stco` (32-bit) or `co64` (64-bit). */
function readChunkOffsets (bytes, view, stbl) {
  const stco = find(bytes, stbl.body, stbl.end, 'stco')
  if (stco) {
    const count = view.getUint32(stco.body + 4)
    const out = new Float64Array(count)
    let at = stco.body + 8
    for (let i = 0; i < count && at + 4 <= stco.end; i++, at += 4) out[i] = view.getUint32(at)
    return out
  }
  const co64 = find(bytes, stbl.body, stbl.end, 'co64')
  if (!co64) return null
  const count = view.getUint32(co64.body + 4)
  const out = new Float64Array(count)
  let at = co64.body + 8
  for (let i = 0; i < count && at + 8 <= co64.end; i++, at += 8) {
    out[i] = view.getUint32(at) * 4294967296 + view.getUint32(at + 4)
  }
  return out
}

/**
 * Sample file positions, from the sample-to-chunk map.
 *
 * `stsc` describes chunk *layout* in runs -- "chunks 1..4 hold 30 samples each,
 * chunks 5.. hold 12" -- so a sample's position is its chunk's offset plus the
 * sizes of the samples ahead of it inside that chunk. This is the one place the
 * five tables genuinely have to be walked together.
 */
function placeSamples (bytes, view, stbl, sizes, table) {
  const stsc = find(bytes, stbl.body, stbl.end, 'stsc')
  const chunks = readChunkOffsets(bytes, view, stbl)
  if (!stsc || !chunks || !sizes) return false

  const runs = view.getUint32(stsc.body + 4)
  const total = table.count
  let si = 0
  let at = stsc.body + 8

  for (let r = 0; r < runs && si < total; r++) {
    const first = view.getUint32(at)
    const perChunk = view.getUint32(at + 4)
    at += 12
    // A run ends where the next one begins, or at the last chunk.
    const nextFirst = r + 1 < runs ? view.getUint32(at) : chunks.length + 1
    if (perChunk === 0) continue

    for (let c = first; c < nextFirst && si < total; c++) {
      const ci = c - 1
      if (ci < 0 || ci >= chunks.length) { si = total; break }
      let pos = chunks[ci]
      for (let k = 0; k < perChunk && si < total; k++, si++) {
        table.offset[si] = pos
        table.size[si] = sizes[si]
        pos += sizes[si]
      }
    }
  }
  return si === total
}

/** Decode timestamps, expanded from the run-length `stts`. */
function readDecodeTimes (bytes, view, stbl, table) {
  const stts = find(bytes, stbl.body, stbl.end, 'stts')
  if (!stts) return false
  const runs = view.getUint32(stts.body + 4)
  let at = stts.body + 8
  let si = 0
  let t = 0
  for (let r = 0; r < runs && si < table.count; r++, at += 8) {
    const n = view.getUint32(at)
    const delta = view.getUint32(at + 4)
    for (let k = 0; k < n && si < table.count; k++, si++) {
      table.dts[si] = t
      table.duration[si] = delta
      t += delta
    }
  }
  // A short `stts` leaves the tail unstamped; carry the last delta forward
  // rather than stacking every remaining sample on one timestamp.
  const last = si > 0 ? table.duration[si - 1] : 0
  for (; si < table.count; si++) {
    table.dts[si] = t
    table.duration[si] = last
    t += last
  }
  return true
}

/**
 * Composition offsets from `ctts`, which is what a stream with B-frames uses to
 * say that its samples are not shown in the order they decode.
 *
 * Version 1 made the offsets signed, which is how a file avoids the whole
 * stream being shifted by the reorder depth. Version 0 offsets are formally
 * unsigned, but files written by encoders that meant them to be signed are out
 * there in quantity, so a version-0 offset large enough to be an obvious
 * wrap-around is read as negative.
 */
function readCompositionOffsets (bytes, view, stbl, table) {
  const ctts = find(bytes, stbl.body, stbl.end, 'ctts')
  if (!ctts) {
    table.cts.set(table.dts)
    return false
  }
  const { version } = fullBoxHeader(view, ctts.body)
  const runs = view.getUint32(ctts.body + 4)
  let at = ctts.body + 8
  let si = 0
  let reordered = false

  for (let r = 0; r < runs && si < table.count; r++, at += 8) {
    const n = view.getUint32(at)
    let off = version === 1 ? view.getInt32(at + 4) : view.getUint32(at + 4)
    if (version === 0 && off > 0x7fffffff) off -= 4294967296
    if (off !== 0) reordered = true
    for (let k = 0; k < n && si < table.count; k++, si++) table.cts[si] = table.dts[si] + off
  }
  for (; si < table.count; si++) table.cts[si] = table.dts[si]
  return reordered
}

/** Sync samples from `stss`; its absence means every sample is a sync sample. */
function readSyncSamples (bytes, view, stbl, table) {
  const stss = find(bytes, stbl.body, stbl.end, 'stss')
  if (!stss) {
    table.sync.fill(1)
    return
  }
  const count = view.getUint32(stss.body + 4)
  let at = stss.body + 8
  for (let i = 0; i < count && at + 4 <= stss.end; i++, at += 4) {
    const si = view.getUint32(at) - 1
    if (si >= 0 && si < table.count) table.sync[si] = 1
  }
}

/**
 * Open-GOP recovery points from `sdtp`.
 *
 * A stream whose `stss` is empty or missing entries -- some recorders write
 * `stss` with a single entry and rely on `sdtp` for the rest -- would otherwise
 * be seekable only from sample zero. A sample marked "does not depend on
 * others" is an I frame whether or not `stss` listed it.
 */
function applySampleDependency (bytes, view, stbl, table) {
  const sdtp = find(bytes, stbl.body, stbl.end, 'sdtp')
  if (!sdtp) return
  const n = Math.min(table.count, sdtp.end - sdtp.body - 4)
  for (let i = 0; i < n; i++) {
    const b = view.getUint8(sdtp.body + 4 + i)
    // sample_depends_on == 2 -> this sample depends on nothing.
    if (((b >> 4) & 3) === 2) table.sync[i] = 1
  }
}

/** The edit list, reduced to the one thing playback cares about: a time shift. */
function readEditList (bytes, view, trak, movieTimescale, mediaTimescale) {
  const elst = descend(bytes, trak.body, trak.end, ['edts', 'elst'])
  if (!elst) return { shiftMs: 0, startMediaTime: 0, entries: 0 }
  const { version } = fullBoxHeader(view, elst.body)
  const count = view.getUint32(elst.body + 4)
  let at = elst.body + 8
  let emptyMs = 0
  let startMediaTime = 0
  let seenReal = false

  for (let i = 0; i < count; i++) {
    let segDuration
    let mediaTime
    if (version === 1) {
      segDuration = view.getUint32(at) * 4294967296 + view.getUint32(at + 4)
      mediaTime = view.getInt32(at + 8) * 4294967296 + view.getUint32(at + 12)
      at += 20
    } else {
      segDuration = view.getUint32(at)
      mediaTime = view.getInt32(at + 4)
      at += 12
    }
    if (mediaTime < 0) {
      // An empty edit is a deliberate gap at the front: the track starts late.
      if (movieTimescale > 0) emptyMs += (segDuration / movieTimescale) * 1000
    } else if (!seenReal) {
      seenReal = true
      startMediaTime = mediaTime
    }
  }
  const trimMs = mediaTimescale > 0 ? (startMediaTime / mediaTimescale) * 1000 : 0
  return { shiftMs: emptyMs - trimMs, startMediaTime, entries: count }
}

/** The rotation and mirroring a `tkhd` transformation matrix expresses. */
export function orientationFromMatrix (a, b, c, d) {
  // The matrix is 16.16 fixed point; only the four in-plane terms matter, and
  // camera and phone recorders only ever write the eight rigid transforms.
  const r = (v) => Math.round(v / 65536)
  const A = r(a); const B = r(b); const C = r(c); const D = r(d)
  if (A === 1 && B === 0 && C === 0 && D === 1) return { rotation: 0, flipH: false }
  if (A === 0 && B === 1 && C === -1 && D === 0) return { rotation: 90, flipH: false }
  if (A === -1 && B === 0 && C === 0 && D === -1) return { rotation: 180, flipH: false }
  if (A === 0 && B === -1 && C === 1 && D === 0) return { rotation: 270, flipH: false }
  if (A === -1 && B === 0 && C === 0 && D === 1) return { rotation: 0, flipH: true }
  if (A === 1 && B === 0 && C === 0 && D === -1) return { rotation: 180, flipH: true }
  if (A === 0 && B === 1 && C === 1 && D === 0) return { rotation: 90, flipH: true }
  if (A === 0 && B === -1 && C === -1 && D === 0) return { rotation: 270, flipH: true }
  return { rotation: 0, flipH: false }
}

/** The `hdlr` type, which is what says whether a track is video or audio. */
function handlerOf (bytes, trak) {
  const hdlr = descend(bytes, trak.body, trak.end, ['mdia', 'hdlr'])
  if (!hdlr) return ''
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return typeAt(view, hdlr.body + 8)
}

/**
 * Parses one `trak` into a track description with a flat sample table.
 *
 * `movieTimescale` is only needed to read an edit list, whose durations are in
 * movie units while everything else in the track is in media units.
 */
export function parseTrack (bytes, trak, movieTimescale) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const tkhd = find(bytes, trak.body, trak.end, 'tkhd')
  if (!tkhd) return null
  const { version: tkhdVersion } = fullBoxHeader(view, tkhd.body)
  const idAt = tkhd.body + (tkhdVersion === 1 ? 4 + 8 + 8 : 4 + 4 + 4)
  const id = view.getUint32(idAt)
  // creation, modification, id, reserved, duration, 2x reserved, layer,
  // alternate_group, volume, reserved -> then the 9-element matrix.
  const matrixAt = idAt + 4 + 4 + (tkhdVersion === 1 ? 8 : 4) + 8 + 2 + 2 + 2 + 2
  const orientation = orientationFromMatrix(
    view.getInt32(matrixAt), view.getInt32(matrixAt + 4),
    view.getInt32(matrixAt + 12), view.getInt32(matrixAt + 16)
  )
  // Track width/height are 16.16 fixed point and are the *presentation* size,
  // which is not always the coded size -- the difference is the same
  // anamorphic-pixel story the BVR header tells with its declared resolution.
  const trackWidth = view.getUint32(matrixAt + 36) / 65536
  const trackHeight = view.getUint32(matrixAt + 40) / 65536

  const mdhd = descend(bytes, trak.body, trak.end, ['mdia', 'mdhd'])
  if (!mdhd) return null
  const { version: mdhdVersion } = fullBoxHeader(view, mdhd.body)
  const tsAt = mdhd.body + (mdhdVersion === 1 ? 4 + 8 + 8 : 4 + 4 + 4)
  const timescale = view.getUint32(tsAt)
  const mediaDuration = mdhdVersion === 1
    ? view.getUint32(tsAt + 4) * 4294967296 + view.getUint32(tsAt + 8)
    : view.getUint32(tsAt + 4)

  const handler = handlerOf(bytes, trak)
  const stbl = descend(bytes, trak.body, trak.end, ['mdia', 'minf', 'stbl'])
  if (!stbl) return null

  const stsd = find(bytes, stbl.body, stbl.end, 'stsd')
  const entries = []
  if (stsd) {
    // stsd is a FullBox with an entry count, then the sample entries themselves.
    walk(bytes, stsd.body + 8, stsd.end, (box) => { entries.push(box) })
  }

  const sizes = readSizes(bytes, view, stbl)
  const count = sizes ? sizes.length : 0
  const table = emptyTable(count)
  let placed = true
  if (count > 0) {
    readDecodeTimes(bytes, view, stbl, table)
    placed = placeSamples(bytes, view, stbl, sizes, table)
    readSyncSamples(bytes, view, stbl, table)
    applySampleDependency(bytes, view, stbl, table)
  }
  const reordered = count > 0 ? readCompositionOffsets(bytes, view, stbl, table) : false

  return {
    id,
    handler,
    kind: handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other',
    timescale: timescale || 1000,
    mediaDuration,
    trackWidth,
    trackHeight,
    rotation: orientation.rotation,
    flipH: orientation.flipH,
    entries,
    edit: readEditList(bytes, view, trak, movieTimescale, timescale || 1000),
    table,
    reordered,
    // A table that could not be placed is one whose `stsc`/`stco` disagreed with
    // its `stsz`; the caller reports it rather than playing nonsense.
    complete: placed,
    // Filled in by the fragment pass when there is one.
    fragmented: false
  }
}

/** Default sample properties a `trex` sets for every fragment of one track. */
function readTrex (bytes, view, mvex) {
  const defaults = new Map()
  for (const trex of findAll(bytes, mvex.body, mvex.end, 'trex')) {
    defaults.set(view.getUint32(trex.body + 4), {
      descriptionIndex: view.getUint32(trex.body + 8),
      duration: view.getUint32(trex.body + 12),
      size: view.getUint32(trex.body + 16),
      flags: view.getUint32(trex.body + 20)
    })
  }
  return defaults
}

/** Whether a `trun` sample-flags word describes a sync sample. */
function isSyncFlags (flags) {
  // sample_is_non_sync_sample is bit 16; sample_depends_on == 2 also means "no
  // dependencies", which some packagers write instead.
  const nonSync = (flags >> 16) & 1
  const dependsOn = (flags >> 24) & 3
  return dependsOn === 2 || !nonSync
}

/**
 * Reads the sample runs of one `traf` into an accumulator.
 *
 * The awkward part of a fragmented file is that a sample's file position is
 * relative to something that moves: `base_data_offset` if the `tfhd` gives one,
 * the start of the enclosing `moof` otherwise, and then each `trun` may carry
 * its own offset from there. Getting this wrong reads the right number of bytes
 * from the wrong place, which decodes as garbage rather than failing.
 */
function readTraf (bytes, view, traf, moofStart, defaults, acc) {
  const tfhd = find(bytes, traf.body, traf.end, 'tfhd')
  if (!tfhd) return
  const { flags: tfhdFlags } = fullBoxHeader(view, tfhd.body)
  const trackId = view.getUint32(tfhd.body + 4)
  let at = tfhd.body + 8

  let baseOffset = moofStart
  let baseIsMoof = true
  if (tfhdFlags & 0x000001) {
    baseOffset = view.getUint32(at) * 4294967296 + view.getUint32(at + 4)
    baseIsMoof = false
    at += 8
  }
  if (tfhdFlags & 0x000002) at += 4 // sample_description_index
  const def = defaults.get(trackId) || { duration: 0, size: 0, flags: 0 }
  let defaultDuration = def.duration
  let defaultSize = def.size
  let defaultFlags = def.flags
  if (tfhdFlags & 0x000008) { defaultDuration = view.getUint32(at); at += 4 }
  if (tfhdFlags & 0x000010) { defaultSize = view.getUint32(at); at += 4 }
  if (tfhdFlags & 0x000020) { defaultFlags = view.getUint32(at); at += 4 }
  // "default-base-is-moof" -- the CMAF-friendly form, and the default anyway
  // when no explicit base offset was given.
  if (tfhdFlags & 0x020000) { baseOffset = moofStart; baseIsMoof = true }

  const target = acc.get(trackId)
  if (!target) return

  const tfdt = find(bytes, traf.body, traf.end, 'tfdt')
  if (tfdt) {
    const { version } = fullBoxHeader(view, tfdt.body)
    target.dts = version === 1
      ? view.getUint32(tfdt.body + 4) * 4294967296 + view.getUint32(tfdt.body + 8)
      : view.getUint32(tfdt.body + 4)
  }

  let runOffsetBase = baseOffset
  let first = true
  for (const trun of findAll(bytes, traf.body, traf.end, 'trun')) {
    const { version: trunVersion, flags: trunFlags } = fullBoxHeader(view, trun.body)
    const sampleCount = view.getUint32(trun.body + 4)
    let p = trun.body + 8
    let dataOffset = runOffsetBase
    if (trunFlags & 0x000001) {
      dataOffset = baseOffset + view.getInt32(p)
      p += 4
    } else if (!first && !baseIsMoof) {
      // Runs without their own offset continue where the last one ended.
      dataOffset = runOffsetBase
    }
    let firstSampleFlags = defaultFlags
    if (trunFlags & 0x000004) { firstSampleFlags = view.getUint32(p); p += 4 }

    let pos = dataOffset
    for (let i = 0; i < sampleCount; i++) {
      let duration = defaultDuration
      let size = defaultSize
      let sampleFlags = i === 0 ? firstSampleFlags : defaultFlags
      let ctsOffset = 0
      if (trunFlags & 0x000100) { duration = view.getUint32(p); p += 4 }
      if (trunFlags & 0x000200) { size = view.getUint32(p); p += 4 }
      if (trunFlags & 0x000400) { sampleFlags = view.getUint32(p); p += 4 }
      if (trunFlags & 0x000800) {
        // Version 1 makes this signed; version 0 files that meant it that way
        // are read the same forgiving way as `ctts`.
        ctsOffset = trunVersion === 1 ? view.getInt32(p) : view.getUint32(p)
        if (trunVersion === 0 && ctsOffset > 0x7fffffff) ctsOffset -= 4294967296
        p += 4
      }
      target.offset.push(pos)
      target.size.push(size)
      target.dtsList.push(target.dts)
      target.ctsList.push(target.dts + ctsOffset)
      target.duration.push(duration)
      target.sync.push(isSyncFlags(sampleFlags) ? 1 : 0)
      if (ctsOffset !== 0) target.reordered = true
      pos += size
      target.dts += duration
    }
    runOffsetBase = pos
    first = false
  }
}

/**
 * Collects the samples of every movie fragment into per-track tables.
 *
 * Fragmented files are what any recorder that has to survive being killed
 * mid-write produces -- the index is rebuilt from the fragments themselves
 * rather than from a trailer that was never written -- so this is not an exotic
 * case to skip.
 */
export function collectFragments (moofBoxes, tracks, moovBytes, mvex) {
  const acc = new Map()
  for (const t of tracks) {
    acc.set(t.id, {
      offset: [], size: [], dtsList: [], ctsList: [], duration: [], sync: [],
      dts: 0, reordered: false
    })
  }

  let defaults = new Map()
  if (mvex) {
    const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength)
    defaults = readTrex(moovBytes, view, mvex)
  }

  for (const { bytes, start } of moofBoxes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    // `bytes` holds the moof box itself, so its children start after the header.
    const headerSize = view.getUint32(0) === 1 ? 16 : 8
    walk(bytes, headerSize, bytes.length, (box) => {
      if (box.type === 'traf') readTraf(bytes, view, box, start, defaults, acc)
    })
  }

  for (const t of tracks) {
    const a = acc.get(t.id)
    if (!a || a.offset.length === 0) continue
    const count = a.offset.length
    const table = emptyTable(count)
    for (let i = 0; i < count; i++) {
      table.offset[i] = a.offset[i]
      table.size[i] = a.size[i]
      table.dts[i] = a.dtsList[i]
      table.cts[i] = a.ctsList[i]
      table.duration[i] = a.duration[i]
      table.sync[i] = a.sync[i]
    }
    t.table = table
    t.reordered = a.reordered
    t.complete = true
    t.fragmented = true
    if (!t.mediaDuration) {
      t.mediaDuration = count ? table.dts[count - 1] + table.duration[count - 1] : 0
    }
  }
  return tracks
}
