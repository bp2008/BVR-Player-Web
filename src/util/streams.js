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

/** What 'auto' actually resolves to, mirroring buildPlaybackStream(). */
function autoDetail (state) {
  const ok = playable(state)
  if (mergesStreams(state)) {
    return dims(
      Math.max(state.mainWidth, state.subWidth),
      Math.max(state.mainHeight, state.subHeight)
    )
  }
  if (ok.main) return dims(state.mainWidth, state.mainHeight)
  if (ok.sub) return dims(state.subWidth, state.subHeight)
  return ''
}

/** Switching mode only merges the two streams when one decoder can take both. */
function mergesStreams (state) {
  const ok = playable(state)
  return !!state.switchingMode && ok.main && ok.sub && state.mainFourcc === state.subFourcc
}

function autoName (state) {
  const ok = playable(state)
  if (mergesStreams(state)) return 'Auto (main + sub)'
  if (ok.main) return 'Auto (main)'
  if (ok.sub) return 'Auto (sub)'
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
