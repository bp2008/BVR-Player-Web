/**
 * The three video-stream choices, labelled for whichever file is loaded.
 *
 * Shared by the settings <select> and the stream chip menu so the two can never
 * describe the same file differently.
 */

const dims = (w, h) => (w > 0 && h > 0 ? `${w}\u00d7${h}` : '')

/** What 'auto' actually resolves to, mirroring buildPlaybackStream(). */
function autoDetail (state) {
  if (state.switchingMode && state.hasMainStream && state.hasSubStream) {
    return dims(
      Math.max(state.mainWidth, state.subWidth),
      Math.max(state.mainHeight, state.subHeight)
    )
  }
  if (state.hasMainStream) return dims(state.mainWidth, state.mainHeight)
  return dims(state.subWidth, state.subHeight)
}

function autoName (state) {
  if (state.switchingMode && state.hasMainStream && state.hasSubStream) return 'Auto (main + sub)'
  return state.hasMainStream ? 'Auto (main)' : 'Auto (sub)'
}

export function streamOptions (state) {
  const list = [
    { value: 'auto', name: autoName(state), detail: autoDetail(state), disabled: false },
    {
      value: 'main',
      name: 'Main',
      detail: state.hasMainStream ? dims(state.mainWidth, state.mainHeight) : 'absent',
      disabled: !state.hasMainStream
    },
    {
      value: 'sub',
      name: 'Sub',
      detail: state.hasSubStream ? dims(state.subWidth, state.subHeight) : 'absent',
      disabled: !state.hasSubStream
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
