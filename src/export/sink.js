/**
 * Where an export's bytes go.
 *
 * Both sinks accept an append-only stream of writes plus one back-patch, which
 * is all the muxer asks for -- the `mdat` length is the only field it cannot
 * know in advance.
 *
 * `showSaveFilePicker()` is the one worth having: bytes go straight to the file
 * the user chose, so a multi-gigabyte export never has to exist in memory at
 * once. It needs a secure context and a served origin, so the download path
 * remains for `file://` and for browsers without it.
 */

export function canStreamToDisk () {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
}

/** Bytes streamed straight into a file the user picked. */
class FileSink {
  constructor (handle, writable) {
    this.handle = handle
    this.writable = writable
    this.streaming = true
    this.name = handle.name
    this.blob = null
  }

  async write (bytes) {
    await this.writable.write(bytes)
  }

  async patch (position, bytes) {
    await this.writable.write({ type: 'write', position, data: bytes })
  }

  async close () {
    await this.writable.close()
  }

  async abort () {
    try { await this.writable.abort() } catch { /* already closed */ }
  }
}

/** Bytes accumulated for a download; the browser spools large blobs to disk. */
class MemorySink {
  constructor (name) {
    this.name = name
    this.streaming = false
    this.chunks = []
    this.offsets = []
    this.length = 0
    this.blob = null
  }

  async write (bytes) {
    // Copy: callers reuse their scratch buffers between samples.
    const copy = bytes.slice()
    this.offsets.push(this.length)
    this.chunks.push(copy)
    this.length += copy.length
  }

  async patch (position, bytes) {
    let remaining = bytes.length
    let from = 0
    for (let i = 0; i < this.chunks.length && remaining > 0; i++) {
      const start = this.offsets[i]
      const chunk = this.chunks[i]
      const end = start + chunk.length
      if (position + from >= end) continue
      const at = position + from - start
      if (at < 0) break
      const n = Math.min(remaining, chunk.length - at)
      chunk.set(bytes.subarray(from, from + n), at)
      from += n
      remaining -= n
    }
  }

  async close () {
    this.blob = new Blob(this.chunks, { type: 'video/mp4' })
    this.chunks = []
    this.offsets = []
  }

  async abort () {
    this.chunks = []
    this.offsets = []
  }
}

/**
 * Opens an output for `fileName`.
 *
 * Must be called from the click that started the export: the file picker needs
 * user activation, and any await before it spends that activation.
 */
export async function openOutput (fileName) {
  if (canStreamToDisk()) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }]
      })
      const writable = await handle.createWritable()
      return new FileSink(handle, writable)
    } catch (e) {
      // A cancelled picker is the user saying no, not a failure to report.
      if (e && e.name === 'AbortError') return null
      // Anything else (a sandboxed frame, a policy block) still has a fall-back.
    }
  }
  return new MemorySink(fileName)
}

/**
 * Hands a finished in-memory export to the browser's downloader.
 *
 * A file sink has already written its bytes and needs nothing here.
 */
export function deliver (sink) {
  if (!sink || sink.streaming || !sink.blob) return false
  const url = URL.createObjectURL(sink.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = sink.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking immediately can cut the download off in some builds; one turn of
  // the event loop is enough for the navigation to have taken the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60000)
  return true
}
