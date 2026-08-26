/**
 * The contract between a container reader and the rest of the player.
 *
 * Nothing here runs during playback. This module exists because the interface it
 * describes used to be implicit -- a BVR file header that half a dozen modules
 * reached into, field by field, on the understanding that a BVR file was the
 * only thing there would ever be. Adding a second container made that
 * understanding load-bearing, so it is written down.
 *
 * ## `header`
 *
 * Shared by every container. A field a container has no equivalent for is
 * present and empty rather than missing, so consumers never test the container.
 *
 *   container        'bvr' | 'mp4'
 *   bmih[]           per stream, the picture the file *declares*: width, height,
 *                    and a four-character codec tag. BVR fills this from its
 *                    BITMAPINFOHEADER (spec 4.3); MP4 from the track header and
 *                    `pasp`, with the sample entry type as the tag. Index 0 is
 *                    the main stream, 1 the sub stream or null.
 *   frameInterval    nominal microseconds between frames.
 *   fps              nominal frames per second, derived from the above.
 *   startUtc         unix ms of the first frame, or 0 when unknown.
 *   rotation, flipH  how the picture should be oriented before it is shown.
 *   hasSubHeader     whether a second video stream is described.
 *   switchingMode    whether the two streams are recorded alternately rather
 *                    than in parallel. Only Blue Iris does this; MP4 is always
 *                    false, which collapses the merged-playback machinery to the
 *                    single-stream case on its own.
 *   hasAudio         whether there is audio worth trying to play.
 *   wfx              audio format, in WAVEFORMATEX terms.
 *   audioExtradata   codec setup bytes, BVR only.
 *   audioConfig      what the audio pipeline should actually do, when the
 *                    container knows outright -- see below. Null on BVR, where
 *                    it is derived from `wfx` and `audioExtradata` instead.
 *   aoi, mask        Blue Iris motion-detection geometry. `[null, null]` and
 *                    null respectively on MP4.
 *   firstFrameOffset where frame data begins. Meaningless for MP4 (0).
 *   mp4              container detail for the inspector. Absent on BVR.
 *
 * `audioConfig`, when present, is `{ kind, label, config, wfx }`:
 *   kind 'codec' -> hand `config` to a WebCodecs `AudioDecoder`
 *   kind 'raw'   -> expand the packets with the player's own decoder, per `wfx`
 *
 * ## `index`
 *
 * `streams[0]` and `streams[1]` are frame tables of parallel typed arrays, one
 * entry per frame, in *presentation* order:
 *
 *   count            frames in the table
 *   offset[], size[] where the frame's bytes are in the file
 *   ts[]             milliseconds from the start of the recording, ascending
 *   utc[]            unix ms, or 0
 *   flags[]          BVR frame flags; MP4 sets only FLAG_ISKEY
 *   dio[], state[]   Blue Iris per-frame camera state; zero on MP4
 *   keyIdx[]         the frame to restart decoding from to reach this one
 *   keys[]           indices of the key frames
 *
 * plus, only where a container stores frames out of presentation order:
 *
 *   feedOrder[]      decode step -> frame index
 *   feedPos[]        frame index -> decode step
 *   feedHigh[]       frame index -> highest decode step among frames 0..i
 *   reordered        true when the three above are present
 *
 * `audio` is `{ count, offset[], size[], ts[] }`, plus `starts[]` where the
 * container states exact packet start times rather than leaving them to be
 * reconstructed.
 *
 * The rest -- `marks`, `metadata`, `baseTs`, `durationMs`, `startUtc`, `endUtc`,
 * `truncated`, `resyncs`, `switchingMode` -- carries the same meaning for both,
 * with MP4 leaving the Blue Iris-specific ones empty.
 *
 * ## `probe`
 *
 * As `summarizeProbe` produces it, whichever container asked the question.
 */

/** A human name for a container, for the inspector and error messages. */
export function containerLabel (header) {
  if (!header) return ''
  if (header.container === 'mp4') {
    const brand = header.mp4 && header.mp4.brands ? header.mp4.brands.major : ''
    if (brand === 'qt  ') return 'QuickTime'
    if (header.mp4 && header.mp4.fragmented) return 'Fragmented MP4'
    return 'MP4'
  }
  return 'Blue Iris BVR'
}

/** Whether a container carries Blue Iris's overlay metadata and camera state. */
export function hasBlueIrisExtras (header) {
  return !!header && header.container !== 'mp4'
}

/**
 * What a container calls its video streams.
 *
 * "Main" and "Sub" are Blue Iris's words for the two streams a camera records in
 * parallel, and they carry a meaning -- one is the full-quality picture, the
 * other the small continuous one -- that simply does not apply to an MP4, whose
 * video tracks are just tracks in the order they appear. The player maps the
 * larger onto its own "main" slot internally because that is how its stream
 * selection works, but saying so in the interface would be describing this app
 * rather than the file in front of the viewer.
 *
 * `both` is whether the file actually has two: a lone track is "Video", not
 * "Video 1" of nothing.
 */
export function streamNames (header, both = true) {
  if (hasBlueIrisExtras(header)) return ['Main', 'Sub']
  return both ? ['Video 1', 'Video 2'] : ['Video', 'Video 2']
}

/** The same names as the player publishes them, e.g. for the "Source" row. */
export function streamLabelFor (container, si, both) {
  if (container === 'mp4') return both ? `Video ${si + 1}` : 'Video'
  return si === 1 ? 'Sub stream' : 'Main stream'
}
