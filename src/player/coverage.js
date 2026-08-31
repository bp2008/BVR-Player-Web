/**
 * Which stream actually has pictures, and when.
 *
 * A Blue Iris recording does not have to hold both of its streams for the whole
 * of its length. The common arrangement is continuous sub-stream recording with
 * the main stream written only while something is happening: an hour-long file
 * whose sub stream runs end to end and whose main stream exists in four islands
 * totalling five minutes. Spec 5.3 describes the same idea through the
 * MAINAVAILABLE flag, but the flag is a per-frame answer to a question that is
 * really about stretches of time, and it says nothing at all about a file whose
 * two streams simply start and stop at different moments.
 *
 * So coverage is read from the frames themselves. Everything else here -- which
 * stream `auto` plays at any given moment, where the scrub bar is drawn light
 * and where it is drawn dark, whether a lone stream should skip a gap -- is
 * derived from these intervals, so all of it agrees by construction.
 *
 * Two thresholds do the real work:
 *
 * `gapMs` is how long a stream may go without a frame before that counts as an
 * absence rather than a low frame rate. It has to be relative, because "no
 * frame for two seconds" is a four-second dropout on a 30 fps stream and
 * perfectly ordinary on a half-frame-per-second one. A main stream recorded at
 * 0.5 fps alongside a 30 fps sub stream is the case that makes this matter: a
 * fixed threshold declares a hole between every pair of main frames and the
 * player spends the clip flickering between resolutions twice a second, which
 * is worse than either stream on its own.
 *
 * `minIsland` is how long a stretch must last to be worth switching for at all.
 * Below it the stretch is handed to whichever neighbour is better, and the
 * switch simply does not happen. This is what keeps a two-second flash of main
 * stream, or a sub stream that starts a quarter of a second before the main
 * one, from costing a visible resolution change in each direction.
 */

import { FLAG_ISKEY } from '../bvr/constants.js'

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

// Bounds on `gapMs`. The floor keeps a 30 fps stream from treating a couple of
// dropped frames as an absence; the ceiling keeps a stream that records one
// frame a minute from swallowing a genuine hole.
const GAP_FACTOR = 4
const MIN_GAP_MS = 1000
const MAX_GAP_MS = 30000

// Bounds on `minIsland`, in the same spirit.
const MIN_ISLAND_MS = 2000
const ISLAND_FRAMES = 3

// How far back a switch may reach for the incoming stream's key frame before
// the cost stops being worth a seamless changeover; see `entryPoint`. Blue Iris
// writes a key frame about once a second, so this is comfortably a couple of
// them and still a blink of an hour-long recording.
const MAX_BACKSTEP_MS = 2500

/**
 * A stream's typical frame spacing, sampled rather than measured exhaustively.
 *
 * The median is taken over evenly spaced samples: a stream of a hundred
 * thousand frames does not need every interval read to say what its frame rate
 * is, and the median is robust to the gaps this whole file is about.
 */
export function medianInterval (s, fallbackMs = 40) {
  if (!s || s.count < 2) return fallbackMs
  const samples = []
  const step = Math.max(1, Math.floor(s.count / 512))
  for (let i = step; i < s.count; i += step) {
    const d = (s.ts[i] - s.ts[i - step]) / step
    if (d > 0) samples.push(d)
  }
  if (!samples.length) return fallbackMs
  samples.sort((a, b) => a - b)
  return samples[samples.length >> 1] || fallbackMs
}

/** How long a hole must be before this stream is considered absent across it. */
export function gapThreshold (s, fallbackMs) {
  return clamp(medianInterval(s, fallbackMs) * GAP_FACTOR, MIN_GAP_MS, MAX_GAP_MS)
}

/**
 * The stretches of time a stream holds pictures for, as `{ start, end }` in the
 * index's own rebased milliseconds.
 *
 * The last frame of a run is given its own frame interval of width, so an
 * interval ends where the picture stops being on screen rather than where the
 * final frame began.
 */
export function coverageOf (s, fallbackMs) {
  if (!s || !s.count) return []
  const gap = gapThreshold(s, fallbackMs)
  const width = medianInterval(s, fallbackMs)
  const out = []
  let start = s.ts[0]
  let prev = s.ts[0]
  for (let i = 1; i < s.count; i++) {
    const t = s.ts[i]
    if (t - prev > gap) {
      out.push({ start, end: prev + width })
      start = t
    }
    prev = t
  }
  out.push({ start, end: prev + width })
  return out
}

// How far into a recording the main stream may start and still count as simply
// how the recording opens rather than as a transition into it. Comfortably under
// `MIN_GAP_MS`, so it can never swallow a genuine second island.
const LEAD_IN_MS = 1000

/**
 * The moments the main stream starts up, for navigating between them.
 *
 * These are the left edges of the light bands on the scrub bar, which is the
 * whole point: the buttons land exactly where the viewer can already see the
 * better picture begins. A file whose main stream simply runs from the top is
 * not transitioning into anything, so a first island inside `LEAD_IN_MS` of the
 * start is not one of these -- which is also what leaves the buttons dead for
 * the two shapes of recording that have nowhere to jump: one covered end to end
 * by the main stream, and one with no main stream at all.
 */
export function mainStartPoints (coverage) {
  if (!coverage || !coverage.main) return []
  const out = []
  for (const iv of coverage.main) {
    if (iv.start > LEAD_IN_MS) out.push(iv.start)
  }
  return out
}

/**
 * The nearest main-stream start on one side of `t`, or `null` for none.
 *
 * `EDGE_MS` is what makes a run of backward presses walk the list instead of
 * sticking: landing on a start puts the playhead a frame or two past it, and
 * without the margin the same start would answer again for ever.
 */
export function adjacentMainStart (points, t, dir) {
  const EDGE_MS = 250
  if (dir < 0) {
    for (let i = points.length - 1; i >= 0; i--) if (points[i] < t - EDGE_MS) return points[i]
    return null
  }
  for (const p of points) if (p > t + EDGE_MS) return p
  return null
}

/** Whether `t` falls inside any of a coverage list's intervals. */
export function covers (list, t) {
  if (!list) return false
  for (const iv of list) {
    if (t >= iv.start && t < iv.end) return true
    if (iv.start > t) break
  }
  return false
}

/** Total length of a coverage list, in ms. */
function span (list) {
  let total = 0
  for (const iv of list) total += iv.end - iv.start
  return total
}

/**
 * Coverage for both of a file's streams, plus whether the two differ by enough
 * to be worth telling the viewer about.
 *
 * Nearly every recording has the two streams covering exactly the same hour, and
 * banding the scrub bar to say so would be decoration rather than information.
 * `informative` is what the UI hangs the whole display off: it is set only when
 * one stream is missing a stretch the other has, and that stretch is long enough
 * to be a visible band on a scrub bar a few hundred pixels wide.
 */
export function fileCoverage (index, fallbackMs) {
  const lists = [coverageOf(index.streams[0], fallbackMs), coverageOf(index.streams[1], fallbackMs)]
  const duration = Math.max(1, index.durationMs)
  let differing = 0
  for (const [a, b] of [[0, 1], [1, 0]]) {
    for (const iv of lists[a]) differing += iv.end - iv.start - overlap(lists[b], iv)
  }
  return {
    main: lists[0],
    sub: lists[1],
    // Both streams present, and enough of the timeline is one-sided to see.
    informative: lists[0].length > 0 && lists[1].length > 0 &&
      differing > 2000 && differing / duration > 0.01
  }
}

/** How much of `iv` is covered by `list`. */
function overlap (list, iv) {
  let total = 0
  for (const other of list) {
    if (other.end <= iv.start) continue
    if (other.start >= iv.end) break
    total += Math.min(iv.end, other.end) - Math.max(iv.start, other.start)
  }
  return total
}

/**
 * Which stream `auto` should be playing at each moment.
 *
 * `rank` orders the streams by preference -- highest resolution first -- and the
 * sweep simply takes the best-ranked stream that has coverage at each point.
 * `absorbShort` then removes the stretches too brief to be worth a switch, which
 * is the whole of the anti-flapping behaviour.
 *
 * Returns `[{ src, start, end }]` covering the timeline in order, or an empty
 * array when no stream has anything.
 */
export function planSegments (index, ranked, fallbackMs) {
  const lists = new Map()
  for (const si of ranked) lists.set(si, coverageOf(index.streams[si], fallbackMs))

  const edges = new Set()
  for (const list of lists.values()) {
    for (const iv of list) { edges.add(iv.start); edges.add(iv.end) }
  }
  const xs = [...edges].sort((a, b) => a - b)

  const segs = []
  for (let i = 0; i + 1 < xs.length; i++) {
    const start = xs[i]
    const end = xs[i + 1]
    if (end <= start) continue
    const mid = (start + end) / 2
    let src = -1
    for (const si of ranked) {
      if (covers(lists.get(si), mid)) { src = si; break }
    }
    if (src < 0) continue
    const last = segs[segs.length - 1]
    // A hole where neither stream has anything is not a segment of its own; the
    // run before it simply reaches the run after it, and the player skips
    // across on the strength of the frame timestamps.
    if (last && last.src === src) { last.end = end; continue }
    segs.push({ src, start, end })
  }

  const minIsland = Math.max(
    MIN_ISLAND_MS,
    ...ranked.map((si) => medianInterval(index.streams[si], fallbackMs) * ISLAND_FRAMES)
  )
  return absorbShort(segs, minIsland, (src) => ranked.indexOf(src))
}

/**
 * Folds away segments too short to be worth switching for.
 *
 * The shortest offender goes first, and its time is given to the better-ranked
 * of its two neighbours -- so a brief flash of main stream in the middle of the
 * sub stream disappears, and so does a quarter-second of sub stream in front of
 * the main one. Each pass removes exactly one segment, so this terminates.
 */
function absorbShort (segs, minIsland, rankOf) {
  for (;;) {
    if (segs.length < 2) return segs
    let worst = -1
    for (let i = 0; i < segs.length; i++) {
      const d = segs[i].end - segs[i].start
      if (d >= minIsland) continue
      if (worst < 0 || d < segs[worst].end - segs[worst].start) worst = i
    }
    if (worst < 0) return segs

    const prev = segs[worst - 1]
    const next = segs[worst + 1]
    const into = !prev ? next : !next ? prev : (rankOf(prev.src) <= rankOf(next.src) ? prev : next)
    if (into === prev) prev.end = segs[worst].end
    else next.start = segs[worst].start
    segs.splice(worst, 1)

    for (let i = 1; i < segs.length; i++) {
      if (segs[i].src === segs[i - 1].src) { segs[i - 1].end = segs[i].end; segs.splice(i, 1); i-- }
    }
  }
}

/**
 * Turns a segment plan into runs of frames: `{ src, from, to }`, contiguous
 * index ranges within one source stream.
 *
 * Contiguity is the point. A decoder handed every frame of one stream from a key
 * frame onwards will decode all of them, whatever the gaps in their timestamps;
 * hand it a sequence with frames missing out of the middle and it produces
 * garbage. So a run may only ever be a slice of one stream's frame table, and
 * every run must open on a key frame.
 *
 * That last requirement is why the switch does not happen exactly where the plan
 * says. The incoming stream can only be entered at one of its key frames, and
 * the two candidates either side of the boundary cost different things. The
 * later one leaves a hole up to a group of pictures long, in which the picture
 * freezes on the outgoing stream's last frame. The earlier one has no hole at
 * all, because the outgoing run simply ends where the incoming one begins -- it
 * costs the tail of the outgoing stream instead, up to the same length.
 *
 * The earlier one wins, as long as it is close enough to be plausibly a key
 * frame interval away. Moving pictures at a lower resolution beat a frozen
 * picture at a higher one, and the difference is a second of a recording that is
 * an hour long. Only when stepping back would cost more than that -- a stream
 * with an unusually long group of pictures -- is the nearer of the two taken
 * instead, on the grounds that neither option is good and the smaller error is
 * the one to make.
 */
export function planRuns (index, segments) {
  const starts = []
  for (const seg of segments) {
    const s = index.streams[seg.src]
    if (!s || !s.count) continue
    // Never at or before where the previous run began, or the merged sequence
    // would run backwards in time.
    const prev = starts[starts.length - 1]
    const from = entryPoint(s, seg, prev ? prev.ts : -Infinity)
    if (from < 0) continue
    starts.push({ src: seg.src, from, ts: s.ts[from] })
  }

  const runs = []
  for (let k = 0; k < starts.length; k++) {
    const cur = starts[k]
    const s = index.streams[cur.src]
    const limit = k + 1 < starts.length ? starts[k + 1].ts : Infinity
    if (s.ts[cur.from] >= limit) continue
    let to = cur.from
    while (to + 1 < s.count && s.ts[to + 1] < limit) to++
    const prev = runs[runs.length - 1]
    if (prev && prev.src === cur.src && prev.to + 1 === cur.from) prev.to = to
    else runs.push({ src: cur.src, from: cur.from, to })
  }
  return runs
}

/**
 * Where a stream can be entered for one segment: the key frame nearest the
 * segment's start, from either side, that does not precede `floor`.
 */
function entryPoint (s, seg, floor) {
  const at = firstAtOrAfter(s, seg.start)

  // Backwards: the key frame this stream's own back-references already point to.
  const back = s.keyIdx[Math.min(at, s.count - 1)]
  const backOk = back >= 0 && s.ts[back] > floor

  // Forwards: the first key frame the segment itself contains.
  let fwd = at
  while (fwd < s.count && !(s.flags[fwd] & FLAG_ISKEY)) fwd++
  const fwdOk = fwd < s.count && s.ts[fwd] < seg.end && s.ts[fwd] > floor

  if (backOk && fwdOk) {
    const stepBack = seg.start - s.ts[back]
    if (stepBack <= MAX_BACKSTEP_MS) return back
    return stepBack <= s.ts[fwd] - seg.start ? back : fwd
  }
  if (backOk) return back
  if (fwdOk) return fwd
  return -1
}

/** Lowest index with `ts >= t`, or `count` when the stream ends before `t`. */
function firstAtOrAfter (s, t) {
  let lo = 0
  let hi = s.count
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (s.ts[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

export { span as coverageSpan }
