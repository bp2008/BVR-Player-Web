const KEY = 'bvr-player.settings.v1'

export const DEFAULT_SETTINGS = {
  skipSeconds: 10,
  volume: 1,
  muted: false,
  loop: false,
  timeDisplay: 'elapsed', // 'elapsed' | 'clock'
  streamMode: 'auto',
  // Speed is deliberately not persisted across files -- see App.openFile. It
  // lives here only so the settings menu has one place to read and write.
  playbackRate: 1,
  // Overlay drawing is off by default: these are boxes and text the recorder
  // would have drawn, not part of the picture, and a viewer should opt in.
  overlay: false,
  overlayShapes: true,
  overlayText: true,
  overlayGraphics: true,
  libraryView: 'grid',   // 'grid' | 'list'
  librarySort: 'time-desc'
}

/** localStorage is unavailable in some file:// and private-mode contexts. */
export function loadSettings () {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw)
    const out = { ...DEFAULT_SETTINGS }
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (parsed[k] !== undefined && typeof parsed[k] === typeof DEFAULT_SETTINGS[k]) out[k] = parsed[k]
    }
    out.skipSeconds = Math.min(600, Math.max(1, Math.round(out.skipSeconds) || 10))
    out.volume = Math.min(1, Math.max(0, out.volume))
    out.playbackRate = Math.min(16, Math.max(0.05, out.playbackRate || 1))
    if (out.libraryView !== 'list') out.libraryView = 'grid'
    return out
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings (settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch { /* nothing we can do, and nothing that should break playback */ }
}
