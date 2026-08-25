import { dayIndex, dayLabel } from './bvrName.js'

/**
 * The row model behind the folder browser's virtual list.
 *
 * A folder of a quarter of a million files is not a list you can put in the
 * document. Six figures of `<button>`s with a thumbnail each would cost gigabytes
 * of layout before the first paint, so what actually gets rendered is the dozen
 * or so rows that fit on screen, positioned absolutely inside a spacer of the
 * full height.
 *
 * That trade needs the height of everything *not* rendered, which is why the
 * listing is flattened into rows of two kinds and nothing else: a day heading,
 * or a run of clips filling one line of the grid. Both have one height apiece,
 * so the offset of any row is a prefix sum, and the row at a scroll position is
 * a binary search over it -- neither of which cares how long the list is.
 */

/**
 * Flattens a sorted listing into rows.
 *
 * `grouped` inserts a heading each time the calendar day changes, which is only
 * meaningful when the sort is by time; the other sorts get one heading over a
 * flat run. Either way this is a single pass with no intermediate arrays -- the
 * clips stay in the one array they were sorted in, and a row refers to a slice
 * of it by index.
 */
export function buildRows (clips, { grouped, columns, flatLabel = 'All recordings' } = {}) {
  const cols = Math.max(1, columns | 0)
  const rows = []
  const n = clips.length
  let i = 0
  while (i < n) {
    let end = n
    let label = flatLabel
    if (grouped) {
      const day = dayOf(clips[i])
      label = dayLabel(clips[i].startUtc)
      let j = i + 1
      while (j < n && dayOf(clips[j]) === day) j++
      end = j
    }
    rows.push({ head: label, count: end - i, start: i, end })
    for (let s = i; s < end; s += cols) rows.push({ head: '', start: s, end: Math.min(s + cols, end) })
    i = end
  }
  return rows
}

/**
 * The day a clip falls on, remembered on the clip itself.
 *
 * Rows are rebuilt on every keystroke in the filter box, and `new Date()` per
 * clip per keystroke is the one part of that pass that is not simply a compare.
 * `startUtc` only ever changes when an entry is hydrated, which clears this.
 */
function dayOf (clip) {
  let d = clip.day
  if (d === undefined) { d = clip.day = dayIndex(clip.startUtc) }
  return d
}

/**
 * Where each row sits, given what the two kinds of row measure.
 *
 * The heights include the space below a row, so an offset is a plain running
 * total and there is no separate gap to account for anywhere else.
 */
export function measureRows (rows, headHeight, itemHeight) {
  const offsets = new Float64Array(rows.length + 1)
  let y = 0
  for (let i = 0; i < rows.length; i++) {
    offsets[i] = y
    y += rows[i].head ? headHeight : itemHeight
  }
  offsets[rows.length] = y
  return offsets
}

/** The last row starting at or before `y`. */
export function rowAt (offsets, y) {
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * How many clips fit across, from the width there is to put them in.
 *
 * Mirrors what `auto-fill` with a `minmax` track would have worked out, because
 * the row model has to know the answer before anything is laid out, and CSS will
 * only say afterwards.
 */
export function columnsFor (width, view) {
  if (view !== 'grid') return 1
  const min = width < 560 ? 148 : 212
  return Math.max(1, Math.floor((width + GRID_GAP) / (min + GRID_GAP)))
}

export const GRID_GAP = 12
