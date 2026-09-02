/**
 * Handing a blob the page has produced to the browser's downloader.
 *
 * Three places need this -- a still, a finished export, a metadata report --
 * and each of them had grown its own copy of the same six lines. The only part
 * worth thinking about is the revoke: doing it immediately cuts the download
 * off in some builds, so the URL is left alive long enough for the browser to
 * have taken the bytes. How long "long enough" is depends on the size, hence
 * the parameter rather than one number for every caller.
 */
export function downloadBlob (blob, name, holdMs = 20000) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), holdMs)
}
