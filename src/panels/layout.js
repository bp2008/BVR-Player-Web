/**
 * How much width each dock gets, and what to do when there is not enough.
 *
 * Kept as one pure function rather than spread through the component: the rules
 * interact (a preferred width, a floor, a ceiling that belongs to both docks at
 * once, and a fallback shape when even the floors do not fit), and reading them
 * in one place is the only way to be sure they agree.
 *
 * The governing rule is the caller's: panels may never take more than
 * MAX_FRACTION of the window, so the video always keeps the rest.
 */

/** Panels never take more than this share of the window. */
export const MAX_FRACTION = 0.7

/** Narrower than this a panel stops being usable, so a dock is never squeezed below it. */
export const MIN_DOCK = 264
export const DEFAULT_DOCK = 344
export const MAX_DOCK = 720

/** A railed dock is a strip of buttons, one per panel it holds. */
export const RAIL_WIDTH = 40

/** Header plus enough body to be worth expanding; below this a panel collapses. */
export const PANEL_HEADER = 38
export const MIN_PANEL_BODY = 128

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/**
 * Resolves both docks at once.
 *
 * Returns `{ left, right }`, each `{ mode, width }` where mode is one of:
 *   'hidden'  no panels on that side
 *   'open'    panels are shown, `width` px wide
 *   'rail'    no room for two open docks, so this one is a strip of buttons
 *
 * `activeSide` decides who wins when the two cannot both be satisfied: the dock
 * the user last touched keeps its width, and is the one that stays open when
 * only one can.
 */
export function solveDocks ({ viewportWidth, counts, widths, activeSide = 'right' }) {
  const budget = Math.max(0, Math.floor(viewportWidth * MAX_FRACTION))
  const has = { left: counts.left > 0, right: counts.right > 0 }
  const out = {
    left: { mode: 'hidden', width: 0 },
    right: { mode: 'hidden', width: 0 }
  }
  if (!has.left && !has.right) return out

  const want = (side) => clamp(Math.round(widths[side] || DEFAULT_DOCK), MIN_DOCK, MAX_DOCK)

  // One dock: it may use the whole budget, and gets squeezed below MIN_DOCK only
  // on a window too narrow to honour both the floor and the 70% rule at once.
  if (has.left !== has.right) {
    const side = has.left ? 'left' : 'right'
    out[side] = { mode: 'open', width: Math.min(want(side), budget) }
    return out
  }

  const primary = activeSide === 'left' ? 'left' : 'right'
  const secondary = primary === 'left' ? 'right' : 'left'

  // Both docks hold panels but the window cannot seat two of them. The active
  // one opens; the other becomes a rail, whose buttons swap which is which.
  if (budget < MIN_DOCK * 2) {
    out[secondary] = { mode: 'rail', width: RAIL_WIDTH }
    out[primary] = { mode: 'open', width: Math.max(0, Math.min(want(primary), budget - RAIL_WIDTH)) }
    return out
  }

  // Both fit. The active dock keeps its preferred width, up to whatever leaves
  // the other one its floor; the other takes what is left, up to its own
  // preference.
  const a = clamp(want(primary), MIN_DOCK, budget - MIN_DOCK)
  const b = clamp(want(secondary), MIN_DOCK, budget - a)
  out[primary] = { mode: 'open', width: a }
  out[secondary] = { mode: 'open', width: b }
  return out
}

/**
 * How many panels in one dock may be expanded at once.
 *
 * Stacked panels share the dock's height, so past a certain count each one is
 * left with a scroll bar and two visible rows. Collapsing the surplus to their
 * title bars is what keeps the rest readable -- and the titles stay on screen,
 * so swapping which panel is expanded is one click.
 */
export function maxExpanded (dockHeight, panelCount) {
  if (panelCount <= 1) return panelCount
  const room = Math.max(0, dockHeight - PANEL_HEADER * panelCount)
  return clamp(Math.floor(room / MIN_PANEL_BODY), 1, panelCount)
}
