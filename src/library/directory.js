import { parseBvrName } from './bvrName.js'

/**
 * Getting at a folder of recordings, by whichever route the browser offers.
 *
 * `showDirectoryPicker()` is the good one: it hands back live handles, so files
 * are opened lazily and the directory can be re-listed later without asking
 * again. `<input type="file" webkitdirectory>` is the fallback -- it materialises
 * every `File` up front, which is fine because a `File` is just a handle to disk
 * until something reads it.
 *
 * Neither works from `file://`, where there is no origin to grant anything to.
 * The browser is therefore an enhancement that appears when it can, never
 * something opening a single file depends on.
 */

export function canPickDirectory () {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

export function canBrowseDirectories () {
  if (typeof document === 'undefined') return false
  if (canPickDirectory()) return true
  // Feature-detect webkitdirectory rather than sniffing: Firefox and Safari
  // support it too, and it is the only route they have.
  return 'webkitdirectory' in document.createElement('input')
}

const isBvr = (name) => /\.bvr$/i.test(name)

function toEntry (name, size, lastModified, handle, file) {
  const parsed = parseBvrName(name)
  return {
    // Identity for the thumbnail cache: a recording that is re-recorded under
    // the same name is a different clip, and size plus mtime says so.
    key: `${name}:${size}:${lastModified || 0}`,
    name,
    size,
    lastModified: lastModified || 0,
    camera: parsed.camera,
    startUtc: parsed.startUtc || lastModified || 0,
    nameMatched: parsed.matched,
    handle: handle || null,
    file: file || null
  }
}

/**
 * Asks for a directory and lists the recordings in it.
 *
 * Must be called from a user gesture -- the picker needs activation.
 */
export async function pickDirectory () {
  const dir = await window.showDirectoryPicker({ id: 'bvr-clips', mode: 'read' })
  return { name: dir.name, handle: dir, entries: await listDirectory(dir) }
}

/** Re-reads a directory handle, so a refresh picks up newly written clips. */
export async function listDirectory (dir) {
  const entries = []
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !isBvr(name)) continue
    let size = 0
    let lastModified = 0
    try {
      // getFile() is a metadata read, not a data read; the bytes stay on disk.
      const file = await handle.getFile()
      size = file.size
      lastModified = file.lastModified
    } catch {
      // A file being written right now can refuse to open; list it anyway.
    }
    entries.push(toEntry(name, size, lastModified, handle, null))
  }
  return entries
}

/** Turns a `webkitdirectory` FileList into the same shape. */
export function entriesFromFileList (files) {
  const out = []
  for (const file of files) {
    if (!isBvr(file.name)) continue
    out.push(toEntry(file.name, file.size, file.lastModified, null, file))
  }
  return out
}

/** The Blob for an entry, opened only when something actually needs the bytes. */
export async function openEntry (entry) {
  if (entry.file) return entry.file
  if (!entry.handle) throw new Error('This clip is no longer available.')
  const file = await entry.handle.getFile()
  entry.file = file
  return file
}

/**
 * Whether a stored directory handle can still be read.
 *
 * A handle persisted in IndexedDB survives a reload but its permission grant may
 * not, and re-requesting needs a user gesture -- so the caller has to know which
 * of the two situations it is in before it can do the right thing.
 */
export async function directoryPermission (handle, request = false) {
  if (!handle || typeof handle.queryPermission !== 'function') return 'granted'
  try {
    const state = await handle.queryPermission({ mode: 'read' })
    if (state === 'granted' || !request) return state
    return await handle.requestPermission({ mode: 'read' })
  } catch {
    return 'denied'
  }
}
