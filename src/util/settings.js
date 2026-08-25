import { PANEL_IDS, DEFAULT_SIDES } from '../panels/panels.js'
import { DEFAULT_DOCK, MAX_DOCK, MIN_DOCK } from '../panels/layout.js'

const KEY = 'bvr-player.settings.v1'

export const DEFAULT_SETTINGS = {
  skipSeconds: 10,
  volume: 1,
  muted: false,
  loop: false,
  // Opening a recording and having it sit there is the surprising behaviour for
  // a player; anyone who wants a still frame can hit space.
  autoplay: true,
  timeDisplay: 'elapsed', // 'elapsed' | 'clock'
  streamMode: 'auto',
  // Cameras routinely encode a picture of a different shape from the one Blue
  // Iris asked them for, most visibly on sub streams. Showing every stream in
  // the shape the header claims is right far more often than not, so it is on --
  // but it is a guess, and a guess the viewer can decline.
  matchAspect: true,

  // Snapshots. JPEG at 85 is the photographic default; WebP is offered for the
  // roughly two-thirds smaller file but is not the default, because a still that
  // some other program refuses to open is worse than a larger one.
  snapshotFormat: 'jpeg',  // 'jpeg' | 'webp'
  snapshotQuality: 85,
  // Writing into the folder being browsed skips the downloads bar, which
  // interrupts the picture on every save. It needs write permission on that
  // folder, so it is opt-in.
  snapshotToFolder: false,
  // Speed is deliberately not persisted across files -- see App.openFile. It
  // lives here only so the settings panel has one place to read and write.
  playbackRate: 1,
  // Overlay drawing is off by default: these are boxes and text the recorder
  // would have drawn, not part of the picture, and a viewer should opt in.
  overlay: false,
  overlayShapes: true,
  overlayText: true,
  overlayGraphics: true,
  libraryView: 'grid',   // 'grid' | 'list'
  librarySort: 'time-desc',

  // Panel docking. Which panels are *open* is deliberately not remembered: a
  // panel that reappears over the video on every launch is a nuisance, whereas
  // where it lands once opened is worth keeping.
  panelSides: { ...DEFAULT_SIDES },
  panelOrder: [...PANEL_IDS],
  dockLeftWidth: DEFAULT_DOCK,
  dockRightWidth: DEFAULT_DOCK
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/** Docking preferences come back as free-form JSON; neither shape is trusted. */
function readSides (raw) {
  const out = { ...DEFAULT_SIDES }
  if (!raw || typeof raw !== 'object') return out
  for (const id of PANEL_IDS) {
    if (raw[id] === 'left' || raw[id] === 'right') out[id] = raw[id]
  }
  return out
}

/** A stored order may be stale: unknown ids are dropped, missing ones appended. */
function readOrder (raw) {
  const out = []
  if (Array.isArray(raw)) {
    for (const id of raw) {
      if (PANEL_IDS.includes(id) && !out.includes(id)) out.push(id)
    }
  }
  for (const id of PANEL_IDS) if (!out.includes(id)) out.push(id)
  return out
}

function readWidth (raw, fallback) {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return fallback
  return clamp(n, MIN_DOCK, MAX_DOCK)
}

/** localStorage is unavailable in some file:// and private-mode contexts. */
export function loadSettings () {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS, panelSides: { ...DEFAULT_SIDES }, panelOrder: [...PANEL_IDS] }
    const parsed = JSON.parse(raw)
    const out = { ...DEFAULT_SETTINGS }
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (parsed[k] !== undefined && typeof parsed[k] === typeof DEFAULT_SETTINGS[k]) out[k] = parsed[k]
    }
    out.skipSeconds = Math.min(600, Math.max(1, Math.round(out.skipSeconds) || 10))
    out.volume = Math.min(1, Math.max(0, out.volume))
    out.playbackRate = Math.min(16, Math.max(0.05, out.playbackRate || 1))
    out.snapshotQuality = Math.min(100, Math.max(1, Math.round(out.snapshotQuality) || 85))
    if (out.snapshotFormat !== 'webp') out.snapshotFormat = 'jpeg'
    if (out.libraryView !== 'list') out.libraryView = 'grid'
    out.panelSides = readSides(parsed.panelSides)
    out.panelOrder = readOrder(parsed.panelOrder)
    out.dockLeftWidth = readWidth(out.dockLeftWidth, DEFAULT_DOCK)
    out.dockRightWidth = readWidth(out.dockRightWidth, DEFAULT_DOCK)
    return out
  } catch {
    return { ...DEFAULT_SETTINGS, panelSides: { ...DEFAULT_SIDES }, panelOrder: [...PANEL_IDS] }
  }
}

export function saveSettings (settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch { /* nothing we can do, and nothing that should break playback */ }
}
