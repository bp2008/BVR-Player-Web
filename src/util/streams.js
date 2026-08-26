/**
 * The three video-stream choices, labelled for whichever file is loaded.
 *
 * Shared by the settings <select> and the stream chip menu so the two can never
 * describe the same file differently.
 */

const dims = (w, h) => (w > 0 && h > 0 ? `${w}\u00d7${h}` : '')

/** A stream is offerable only if it is in the file and this device can decode it. */
function playable (state) {
  return {
    main: !!state.hasMainStream && state.mainCodecSupported !== false,
    sub: !!state.hasSubStream && state.subCodecSupported !== false
  }
}

/**
 * What 'auto' has actually resolved to.
 *
 * The player works this out once per file -- it depends on where each stream has
 * pictures, which only the frame index knows -- and publishes it as
 * `autoStreams`, the streams auto will draw on in preference order. Reading it
 * back here is what keeps the menu and the sequence being played from ever
 * describing the same file differently. Before a file is open there is nothing
 * to read, so the old resolution-blind guess stands in.
 */
function autoSources (state) {
  const ok = playable(state)
  const list = Array.isArray(state.autoStreams) ? state.autoStreams.filter((si) => ok[si === 1 ? 'sub' : 'main']) : []
  if (list.length) return list
  const guess = []
  if (ok.main) guess.push(0)
  if (ok.sub) guess.push(1)
  return guess
}

const widthOf = (state, si) => (si === 1 ? state.subWidth : state.mainWidth)
const heightOf = (state, si) => (si === 1 ? state.subHeight : state.mainHeight)

function autoDetail (state) {
  const list = autoSources(state)
  if (!list.length) return ''
  return dims(
    Math.max(...list.map((si) => widthOf(state, si))),
    Math.max(...list.map((si) => heightOf(state, si)))
  )
}

function autoName (state) {
  const list = autoSources(state)
  if (list.length > 1) return 'Auto (main + sub)'
  if (list.length === 1) return list[0] === 1 ? 'Auto (sub)' : 'Auto (main)'
  return 'Auto'
}

/** Why a stream cannot be picked, or '' when it can. */
function unavailable (state, which) {
  if (!state[which === 'main' ? 'hasMainStream' : 'hasSubStream']) return 'absent'
  if (state[which === 'main' ? 'mainCodecSupported' : 'subCodecSupported'] === false) return 'no decoder'
  return ''
}

export function streamOptions (state) {
  const ok = playable(state)
  const mainWhy = unavailable(state, 'main')
  const subWhy = unavailable(state, 'sub')
  const list = [
    {
      value: 'auto',
      name: autoName(state),
      detail: autoDetail(state),
      disabled: !ok.main && !ok.sub
    },
    {
      value: 'main',
      name: 'Main',
      detail: mainWhy || dims(state.mainWidth, state.mainHeight),
      disabled: !ok.main,
      title: mainWhy === 'no decoder' ? `${state.mainCodecLabel} cannot be decoded on this device` : ''
    },
    {
      value: 'sub',
      name: 'Sub',
      detail: subWhy || dims(state.subWidth, state.subHeight),
      disabled: !ok.sub,
      title: subWhy === 'no decoder' ? `${state.subCodecLabel} cannot be decoded on this device` : ''
    }
  ]
  // A flat one-line form for <option>, which cannot hold two columns.
  for (const o of list) o.label = o.detail ? `${o.name} ${o.detail}` : o.name
  return list
}

/** Short form for the control-bar chip, e.g. "auto 1600x1200". */
export function streamChipLabel (state) {
  const size = dims(state.width, state.height)
  return size ? `${state.streamMode} ${size}` : state.streamMode
}
