import { describeClip } from './thumbnailer.js'

/**
 * Thumbnail worker.
 *
 * Decoding a key frame per clip is the one part of the folder browser heavy
 * enough to stutter the page, and it is also entirely self-contained -- a Blob
 * goes in, a small image and a summary come out -- so it moves off the main
 * thread cleanly. Blobs cross the boundary by reference rather than by copy, so
 * handing a two-gigabyte recording to the worker costs nothing.
 *
 * `new Worker()` is unavailable on `file://`, so nothing may depend on this
 * existing; `thumbService.js` runs the same module inline when it cannot be
 * started.
 */
self.onmessage = async (event) => {
  const { id, blob, options } = event.data || {}
  if (id === undefined) return
  try {
    const { info, thumbnail } = await describeClip(blob, options)
    self.postMessage({ id, ok: true, info, thumbnail })
  } catch (error) {
    self.postMessage({ id, ok: false, error: error && error.message ? error.message : String(error) })
  }
}
