/**
 * The panels the dock knows about.
 *
 * One list, used by the layout solver, the persisted settings, the control bar
 * buttons and the panel frames, so a panel cannot exist in one of those places
 * and not the others.
 *
 * `needsFile` panels are closed when the player has nothing loaded: their whole
 * content is a description of the current recording, and an empty shell taking
 * a third of the window is worse than no panel at all.
 */
export const PANELS = [
  { id: 'settings', title: 'Settings', short: 'Settings', icon: 'settings', needsFile: false },
  { id: 'metadata', title: 'Metadata', short: 'Metadata', icon: 'layers', needsFile: true },
  { id: 'export', title: 'Export to MP4', short: 'Export', icon: 'download', needsFile: true }
]

export const PANEL_IDS = PANELS.map((p) => p.id)

const BY_ID = new Map(PANELS.map((p) => [p.id, p]))

export function panelDef (id) {
  return BY_ID.get(id) || null
}

/** The dock a panel opens into when nothing has been saved for it. */
export const DEFAULT_SIDES = {
  settings: 'right',
  metadata: 'right',
  export: 'right'
}
