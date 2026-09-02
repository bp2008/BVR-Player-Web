/**
 * "Export metadata": what the player knows about a recording, as a file.
 *
 * Two situations want this, and they want different amounts of it. A viewer
 * holding a file that will not play needs to know what it *does* contain -- the
 * player refusing it is not an answer -- and that fits in a page of text.
 * Anyone chasing an oddity in a recording wants the overlay record log, every
 * bounding box and every clock tick, which only an interactive page can carry.
 * So there are two formats, and they share everything up to the rendering:
 *
 *   analysis.js    reads the file once and builds the model
 *   reportText.js  the simple summary
 *   reportHtml.js  the detailed summary
 *
 * This module is only the seam between them and the button that asks.
 */

import { collectAnalysis, reportBaseName } from './analysis.js'
import { renderTextReport } from './reportText.js'
import { renderHtmlReport } from './reportHtml.js'

export const REPORT_FORMATS = [
  {
    value: 'text',
    name: 'Simple summary',
    detail: 'Plain text',
    // Every overlay record has to be read for the detailed report, so the two
    // differ in cost as well as in shape. The menu says so.
    hint: 'The shape of the file: header, formats, frame inventory, stream statistics.'
  },
  {
    value: 'html',
    name: 'Detailed summary',
    detail: 'HTML page',
    hint: 'Everything above plus every overlay record, filterable, with its text, boxes, images and GPS.'
  }
]

/**
 * Describes a recording as completely as the chosen format asks for.
 *
 * `header`, `index` and `probe` may be passed in when the file is already open,
 * which is the difference between an instant report and reading a gigabyte
 * again. `onProgress` reports whatever reading is left. Nothing about the file
 * itself can make this throw.
 */
export async function analyzeRecording (file, opts = {}) {
  const format = opts.format === 'html' ? 'html' : 'text'
  const blob = opts.blob || file
  const fileName = opts.fileName || (file && file.name) || ''

  const model = await collectAnalysis(blob, { ...opts, fileName, detailed: format === 'html' })
  const base = reportBaseName(fileName)

  if (format === 'html') {
    return { name: `${base}.html`, text: renderHtmlReport(model), mime: 'text/html;charset=utf-8' }
  }
  return { name: `${base}.txt`, text: renderTextReport(model), mime: 'text/plain;charset=utf-8' }
}
