import { scanTopLevel, readBox, walk, find, findAll, fullBoxHeader, typeAt, looksLikeIso } from './boxes.js'
import { parseTrack, collectFragments } from './sampleTable.js'

export class Mp4FormatError extends Error {}

/**
 * Reads an MP4's structure and every track's sample table.
 *
 * The contrast with the BVR indexer is the point: BVR has no index, so opening
 * one means reading every byte of the file to find out where its frames are.
 * An MP4 wrote that table down, so opening one means reading `moov` and nothing
 * else -- a few megabytes at the front or back of the file however long the
 * recording is. A two-hour clip opens in the time it takes to fetch that.
 *
 * The exception is a fragmented file, where the table was never written as a
 * whole and has to be gathered from every `moof` in turn. That costs one short
 * read per fragment, which is still thousands of times less than a full scan.
 */

/** Top-level box types worth remembering for the inspector. */
const NOTABLE = new Set(['ftyp', 'moov', 'moof', 'mdat', 'mfra', 'free', 'skip', 'sidx', 'styp'])

function readMvhd (bytes, view, moov) {
  const mvhd = find(bytes, moov.body, moov.end, 'mvhd')
  if (!mvhd) return { timescale: 1000, duration: 0 }
  const { version } = fullBoxHeader(view, mvhd.body)
  const at = mvhd.body + (version === 1 ? 4 + 8 + 8 : 4 + 4 + 4)
  const timescale = view.getUint32(at)
  const duration = version === 1
    ? view.getUint32(at + 4) * 4294967296 + view.getUint32(at + 8)
    : view.getUint32(at + 4)
  return { timescale: timescale || 1000, duration }
}

/** The `ftyp` brands, which is the closest an MP4 comes to saying what it is. */
function readBrands (bytes, view, ftyp) {
  if (!ftyp) return { major: '', minor: 0, compatible: [] }
  const major = typeAt(view, ftyp.body)
  const minor = view.getUint32(ftyp.body + 4)
  const compatible = []
  for (let at = ftyp.body + 8; at + 4 <= ftyp.end; at += 4) compatible.push(typeAt(view, at))
  return { major, minor, compatible }
}

/**
 * The creation time in the movie header, as unix milliseconds.
 *
 * MP4 counts from 1904, which is the one piece of QuickTime archaeology that
 * still earns its keep here: it is the only wall-clock stamp a plain MP4
 * carries, and the folder browser wants a start time for every clip.
 */
const MP4_EPOCH_OFFSET = 2082844800

function readCreationTime (bytes, view, moov) {
  const mvhd = find(bytes, moov.body, moov.end, 'mvhd')
  if (!mvhd) return 0
  const { version } = fullBoxHeader(view, mvhd.body)
  const seconds = version === 1
    ? view.getUint32(mvhd.body + 4) * 4294967296 + view.getUint32(mvhd.body + 8)
    : view.getUint32(mvhd.body + 4)
  if (!seconds) return 0
  const unix = seconds - MP4_EPOCH_OFFSET
  // Files written with a zeroed or nonsense clock are common; a stamp before
  // 1990 or far in the future is worse than admitting there isn't one.
  if (unix < 631152000 || unix > 4102444800) return 0
  return unix * 1000
}

/**
 * Pulls the creation date out of the Apple/QuickTime metadata atoms.
 *
 * Better than `mvhd` where it exists, because it carries a real timezone offset
 * rather than a bare second count, and because some recorders leave `mvhd` at
 * zero while filling this in.
 */
function readMetaCreationDate (bytes, moov) {
  const meta = find(bytes, moov.body, moov.end, 'meta')
  if (!meta) return 0
  // `meta` is a FullBox in ISO files and a plain box in some QuickTime ones;
  // probing both starts costs nothing and saves guessing.
  for (const from of [meta.body + 4, meta.body]) {
    const ilst = find(bytes, from, meta.end, 'ilst')
    if (!ilst) continue
    let found = 0
    walk(bytes, ilst.body, ilst.end, (item) => {
      if (item.type !== '©day') return
      const data = find(bytes, item.body, item.end, 'data')
      if (!data) return
      const text = new TextDecoder().decode(bytes.subarray(data.body + 8, data.end))
      const t = Date.parse(text)
      if (Number.isFinite(t)) { found = t; return false }
    })
    if (found) return found
  }
  return 0
}

/**
 * Parses the container.
 *
 * `onProgress` only ever fires on a fragmented file, where the work is
 * proportional to the number of fragments rather than fixed.
 */
export async function parseMp4 (reader, { onProgress, shouldStop } = {}) {
  if (reader.size < 8) throw new Mp4FormatError('File is too small to be an MP4.')
  const opening = await reader.readCopy(0, Math.min(reader.size, 16))
  if (!looksLikeIso(opening)) {
    throw new Mp4FormatError('Not an MP4: the file does not begin with an ISO base media box.')
  }

  let moovBox = null
  let ftypBox = null
  const moofBoxes = []
  const layout = []
  let truncated = false
  let mdatBytes = 0

  await scanTopLevel(reader, async (box) => {
    if (shouldStop && shouldStop()) return false
    if (NOTABLE.has(box.type)) layout.push({ type: box.type, start: box.start, size: box.size })
    if (box.type === 'ftyp' && !ftypBox) ftypBox = box
    else if (box.type === 'moov' && !moovBox) moovBox = box
    else if (box.type === 'moof') moofBoxes.push(box)
    else if (box.type === 'mdat') mdatBytes += box.end - box.body
    if (box.start + box.size > reader.size) truncated = true
  })

  if (!moovBox) {
    throw new Mp4FormatError(
      'This MP4 has no "moov" index. It is most likely a recording that was ' +
      'never finalised; nothing in it says where its frames are.'
    )
  }

  const moovBytes = await readBox(reader, moovBox)
  const moovView = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength)
  // `moovBytes` holds the box itself, so its children begin past the header.
  const moovHeader = moovView.getUint32(0) === 1 ? 16 : 8
  const moovLocal = { body: moovHeader, end: moovBytes.length }

  const movie = readMvhd(moovBytes, moovView, moovLocal)
  let brands = { major: '', minor: 0, compatible: [] }
  if (ftypBox) {
    const ftypBytes = await readBox(reader, ftypBox)
    const ftypView = new DataView(ftypBytes.buffer, ftypBytes.byteOffset, ftypBytes.byteLength)
    brands = readBrands(ftypBytes, ftypView, { body: 8, end: ftypBytes.length })
  }

  const tracks = []
  for (const trak of findAll(moovBytes, moovLocal.body, moovLocal.end, 'trak')) {
    const t = parseTrack(moovBytes, trak, movie.timescale)
    if (t) tracks.push(t)
  }
  if (!tracks.length) throw new Mp4FormatError('This MP4 contains no tracks.')

  const mvex = find(moovBytes, moovLocal.body, moovLocal.end, 'mvex')
  const isFragmented = !!mvex || moofBoxes.length > 0
  if (isFragmented && moofBoxes.length) {
    const loaded = []
    for (let i = 0; i < moofBoxes.length; i++) {
      if (shouldStop && shouldStop()) break
      const box = moofBoxes[i]
      loaded.push({ bytes: await readBox(reader, box), start: box.start })
      if (onProgress && (i & 15) === 0) onProgress(i / moofBoxes.length)
    }
    collectFragments(loaded, tracks, moovBytes, mvex)
  }
  if (onProgress) onProgress(1)

  const created = readMetaCreationDate(moovBytes, moovLocal) || readCreationTime(moovBytes, moovView, moovLocal)

  return {
    brands,
    movieTimescale: movie.timescale,
    movieDurationMs: movie.timescale > 0 ? (movie.duration / movie.timescale) * 1000 : 0,
    tracks,
    fragmented: isFragmented,
    fragments: moofBoxes.length,
    truncated,
    mdatBytes,
    moovBytes: moovBytes.length,
    moovAt: moovBox.start,
    layout,
    created,
    // Kept so the codec layer can re-read a sample entry's child boxes without
    // the whole file being read a second time.
    moovBuffer: moovBytes,
    moovRange: moovLocal
  }
}
