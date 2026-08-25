/**
 * Whether a key event's target is somewhere a space bar means a space.
 *
 * The player claims Space wherever else focus happens to be -- see
 * App.onSpaceKey -- so this is the one exception, and it has to be a narrow
 * one. Buttons, checkboxes, radios, selects and the scrub bar are all things a
 * browser will act on when Space is pressed, and none of them are typing.
 */
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password', 'number',
  'date', 'datetime-local', 'month', 'time', 'week'
])

export function acceptsTypedText (el) {
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag !== 'INPUT') return false
  // A missing or unrecognised type is a text field as far as the browser is
  // concerned, and `el.type` already normalises both cases to "text".
  return TEXT_INPUT_TYPES.has(String(el.type || 'text').toLowerCase())
}

/** True for the space bar, across the spellings browsers have used for it. */
export function isSpaceKey (event) {
  return event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar'
}
