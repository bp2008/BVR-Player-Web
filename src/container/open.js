import { parseFileHeader } from '../bvr/parseFileHeader.js'
import { buildIndex } from '../bvr/indexer.js'
import { probeVideoStreams, probeIndexedStream, summarizeProbe } from '../bvr/probe.js'
import { looksLikeIso } from '../mp4/boxes.js'
import { openMp4 } from '../mp4/openMp4.js'
import { SIGNATURE } from '../bvr/constants.js'

/**
 * The one place in the app that knows what a container is.
 *
 * Everything downstream -- the decode pipelines, the frame window, the renderer,
 * the scrub bar, the export -- works from three objects, and this module's whole
 * job is to produce them from whichever kind of file was opened:
 *
 *   `header`  what the recording says it is: picture sizes, orientation, frame
 *             interval, audio format, and whether there is a second stream.
 *   `index`   the frame table: for each stream, one entry per frame giving where
 *             it is in the file, how big it is, when it is shown, and what the
 *             recorder had to say about that moment.
 *   `probe`   whether this device can actually decode any of it.
 *
 * The fields each container fills are documented in `mediaInfo.js`. What matters
 * here is that nothing above this layer branches on the container again.
 */

// Every extension the app will attempt to open. A name is only ever used to
// decide whether a directory entry is worth listing; what a file actually *is*
// comes from its opening bytes -- see `sniffContainer`.
const EXT_RE = /\.(bvr|mp4|m4v|mov)$/i

export function isPlayableName (name) {
  return EXT_RE.test(String(name || ''))
}

export class UnknownContainerError extends Error {}

/**
 * Decides what a file is from its opening bytes rather than its name.
 *
 * A recording downloaded through a browser, renamed, or handed over by a share
 * sheet routinely arrives with the wrong extension or none at all, and both
 * formats identify themselves unambiguously in their first eight bytes.
 */
export async function sniffContainer (reader) {
  const head = await reader.readCopy(0, Math.min(reader.size, 16))
  if (head.length >= 4) {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
    if (view.getUint32(0, true) === SIGNATURE) return 'bvr'
  }
  if (looksLikeIso(head)) return 'mp4'
  return ''
}

/**
 * Opens a recording.
 *
 * `onProbe` is called as soon as the codec verdict is known and before the
 * expensive part of opening begins. That ordering is the whole reason this is a
 * callback rather than another return value: a BVR file has no index, so
 * building one means reading every byte, and a machine with no HEVC decoder
 * should be told so in the first moment rather than after a gigabyte has gone
 * past. An MP4 reaches the same point almost immediately, but reports through
 * the same channel so the player has one path.
 */
export async function openContainer (reader, { onProbe, onProgress, shouldStop } = {}) {
  const kind = await sniffContainer(reader)
  if (kind === 'mp4') return openMp4Container(reader, { onProbe, onProgress, shouldStop })
  if (kind === 'bvr') return openBvrContainer(reader, { onProbe, onProgress, shouldStop })
  throw new UnknownContainerError(
    'This is not a file the player recognises. It reads Blue Iris .bvr recordings ' +
    'and MP4 video (.mp4, .m4v, .mov).'
  )
}

async function openMp4Container (reader, { onProbe, onProgress, shouldStop }) {
  const { header, index, probe, movie } = await openMp4(reader, { onProgress, shouldStop })
  if (onProbe) onProbe(probe, header)
  return { container: 'mp4', header, index, probe, movie }
}

async function openBvrContainer (reader, { onProbe, onProgress, shouldStop }) {
  const header = await parseFileHeader(reader)
  header.container = 'bvr'
  // BVR carries no audio configuration beyond its WAVEFORMATEX, so the field the
  // MP4 path fills in is left null and the audio pipeline derives it as before.
  header.audioConfig = null

  let probe = await probeVideoStreams(reader, header)
  if (onProbe) onProbe(probe, header)
  if (shouldStop && shouldStop()) return { container: 'bvr', header, index: null, probe }
  if (probe.decided && !probe.anySupported) throw new Error(probe.summary)

  const index = await buildIndex(reader, header, { onProgress, shouldStop })
  index.container = 'bvr'
  if (shouldStop && shouldStop()) return { container: 'bvr', header, index, probe }

  // A stream whose frames start only later in the file was invisible to the
  // opening probe; the finished index points straight at its first key frame.
  probe = await probeMissedStreams(reader, header, index, probe)
  if (onProbe) onProbe(probe, header)

  return { container: 'bvr', header, index, probe }
}

/**
 * Re-runs the probe for any stream the opening scan could not settle.
 *
 * Two cases, and both are ordinary. A stream whose frames begin well into the
 * file was never seen at all; a stream whose opening frames were corrupt was
 * seen but produced no key frame to judge. The finished index points straight at
 * the first key frame either way, so this costs one short read per stream.
 */
async function probeMissedStreams (reader, header, index, probe) {
  const streams = probe.streams.slice()
  let changed = false
  for (let si = 0; si < 2; si++) {
    if (index.streams[si].count === 0) continue
    if (streams[si] && streams[si].hasKeyFrame) continue
    const described = await probeIndexedStream(reader, header, index, si)
    if (described) { streams[si] = described; changed = true }
  }
  return changed ? summarizeProbe(streams) : probe
}
