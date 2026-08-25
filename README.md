# BVR-Player-Web

A web-based player for Blue Iris `.bvr` files. Everything runs locally in the
browser — the file is never uploaded anywhere.

## Using it

https://bp2008.github.io/BVR-Player-Web/

Open the player, then drag a `.bvr` file onto the page or press **Open**. Press
**Browse** to page through a whole folder of recordings with thumbnails.

### Requirements

A Chromium-based browser (Chrome, Edge, Opera) for WebCodecs. H.265/HEVC clips
additionally need platform HEVC decode support (should work on most modern devices).

### Controls

| Action | Control | Keyboard |
|---|---|---|
| Play / pause | ▶︎ button, or click the video | <kbd>Space</kbd> / <kbd>K</kbd> |
| Skip back / forward | ↺ / ↻ buttons | <kbd>←</kbd> / <kbd>→</kbd> |
| Previous / next frame | ⏮ / ⏭ buttons | <kbd>,</kbd> / <kbd>.</kbd> (or <kbd>Shift</kbd>+arrow) |
| Seek | scrub bar | <kbd>Home</kbd>, <kbd>End</kbd>, <kbd>0</kbd>–<kbd>9</kbd> |
| Playback speed | speed chip | <kbd>[</kbd> / <kbd>]</kbd> |
| Zoom / pan | wheel, pinch, drag | <kbd>+</kbd> / <kbd>-</kbd>, <kbd>Z</kbd> to reset |
| Volume / mute | speaker button + slider | <kbd>↑</kbd> / <kbd>↓</kbd>, <kbd>M</kbd> |
| Fullscreen | ⛶ button, or double-click the video | <kbd>F</kbd> |
| Open a file | Open button | <kbd>O</kbd> |
| Browse a folder | Browse button | <kbd>L</kbd> |
| Metadata inspector | layers button | <kbd>I</kbd> |
| Export to MP4 | download button | <kbd>E</kbd> |

Double-clicking the video resets the zoom when zoomed in, and toggles fullscreen
otherwise.

The skip interval (default 10 s), time display (elapsed or wall clock), loop,
playback speed, overlay drawing, and — for dual-stream recordings — the main/sub
stream selection live in the settings menu and persist in the web browser's
`localStorage`.

### Browsing a folder

**Browse** lists every `.bvr` file in a directory with a thumbnail, camera name,
start time and duration, grouped by day. Nothing is uploaded, and only a few
hundred kilobytes of each file is read: the header, the first key frame, and a
short read from the end for the clip length. Thumbnails are cached in IndexedDB
so a folder is only paid for once.

This needs the page to be served over http(s) — the directory APIs have nothing
to grant access to on a `file://` page — so the button only appears where it
works. Opening one file at a time is unaffected.

### Metadata

BVR carries more than pictures: overlay text and clocks, motion and AI bounding
boxes, GPS, per-frame camera state and DIO inputs, marks, and the camera's motion
mask. The **metadata** button opens an inspector over three tabs — the file as a
whole, the current frame, and a timeline of marks and recording-segment starts
that seeks on click. Overlays can also be drawn back over the video, where they
stay registered with the picture under rotation, flip and zoom.

### Exporting to MP4

**Export** writes an MP4 of the whole recording or a trimmed range, in one of two
ways:

- **Copy frames** — the compressed frames are moved into an MP4 container
  untouched. Fast, lossless, and the file is about the size of the source. It can
  only begin on a key frame, so the dialog says when the start has to shift.
- **Re-encode** — decode and encode again, which trims exactly and can change
  codec, bitrate, resolution and frame rate.

Audio is always re-encoded to AAC: none of the formats BVR carries (FLAC, PCM,
G.711 µ-law) has an MP4 form players can be relied on to handle. Where the
browser supports it, the file is written straight to disk as it is produced, so
an export can be far larger than memory.


## Technical Details for Developers

Video is decoded with [WebCodecs](https://developer.mozilla.org/docs/Web/API/WebCodecs_API).

Two deployment shapes are supported from the same build:

- **Served** (GitHub Pages or any static host) — point Pages at the `docs/`
  folder on `main`. This gets the full PWA: installable, offline app shell, and
  an OS file handler for `.bvr` once installed.
- **Off the filesystem** — double-click `docs/index.html`. Everything is inlined
  into that one file, so it works over `file://` with no server. The service
  worker and install prompt are simply absent there.


### Development

```bash
npm install
npm run dev
```

`npm run build` regenerates the PWA icons and writes the single-file bundle plus
the PWA side-files to `docs/`. That directory is committed on purpose — it is
what GitHub Pages serves and what you double-click. `build.bat` does the same
from Explorer or a plain `cmd` window, installing dependencies first if
`node_modules` is missing; pass `nopause` to skip the prompt at the end.

The service worker is registered only in production builds; a dev page instead
unregisters any worker left behind by a production build loaded from the same
origin, so `npm run dev` can never be served a stale module.

Its caching is arranged so a deploy is picked up without any cache-busting
ritual. Navigations are network-first, and because the whole app is inlined into
`index.html` there are no separate JS/CSS files that could go stale behind it —
a new build lands on the next visit, subject only to the `max-age=600` GitHub
Pages puts on every file. Icons and the manifest are stale-while-revalidate:
served from cache at once, refreshed in the background. `CACHE` is a constant
and does not need bumping per build; that would re-download the shell every
deploy to fix a problem stale-while-revalidate already solves.

Put `.bvr` files in `sample/` for local testing; that folder is git-ignored.

### How it works

```
src/bvr/       format layer  - frame headers, file header, full-file index, codec probe
src/player/    playback      - decode pipelines, media clock, canvas renderer
src/components/  Vue 3 UI (Options API)
```

- **Indexing.** BVR has no index or trailer, so the whole file is scanned once on
  open to build a frame table (offset, size, timestamp, UTC, flags) per stream.
  Every seek is then exact and needs no searching. Corrupt regions are
  resynchronised by hunting for the next validated `BLUE` signature, and a
  truncated tail is played up to the last complete frame.

  The scan is bounded by how fast the platform hands over bytes, not by anything
  it computes, so reads run ahead of the parse: fixed 16 MB chunks are fetched
  three deep, which keeps a queue outstanding at the storage layer instead of one
  request at a time. Chunks overlap by 64 bytes so a frame header straddling a
  boundary still reads whole, which keeps the per-frame loop free of stitching.
  That is worth roughly 3x on an hour-long recording — about 0.6 s for 1.9 GB
  here, against 1.6 s for a single sliding window — and the margin grows with
  read latency, on a VM disk or a network share.
- **Codec support, up front.** Before the index scan reads the rest of the file,
  a short probe walks the first frames for each stream's first key frame and
  settles what it is and whether this device can decode it. A machine with no
  HEVC decoder finds out in milliseconds rather than after a gigabyte has gone
  past. The two streams are judged separately: a file whose main stream cannot be
  decoded here still plays from its sub stream, and the picker greys out only the
  stream that has no decoder.
- **Decoding.** Key frames carry their own parameter sets, so a
  `VideoDecoderConfig` is derived from the first key frame by parsing the SPS for
  profile/tier/level. Chunks are fed to `VideoDecoder` in Annex-B form. Switching
  mode merges main and sub into one sequence only when both go through the same
  decoder — same codec, and both decodable here.
- **Frame window.** Decoded pictures are copied into `ImageBitmap`s and kept in a
  window around the current position. The copy matters: a hardware decoder owns a
  small pool of output pictures and stalls once an application holds more than a
  handful, and the frames kept *behind* the playhead are what make backward frame
  stepping instant.
- **Timing.** Presentation is driven by a media clock anchored to
  `AudioContext.currentTime` whenever audio is actually running, so audio and
  video share one timebase and cannot drift. Video never waits on audio: a
  context that is suspended by autoplay policy leaves the clock on
  `performance.now()` and joins later.
- **Audio.** Packet start times are reconstructed from cumulative sample counts
  rather than trusted from the stored per-packet timestamps, which the format
  spec notes are unreliable (FLAC packets are stamped near their end; legacy
  files stamp every packet 0). PCM and G.711 µ-law are decoded directly; FLAC
  goes through `AudioDecoder`.

The container format details were provided by the Blue Iris developer and is avialable here: [BVR_File_Format_Spec.md](BVR_File_Format_Spec.md).

Roadmap notes for this app live in [PLANNED_FEATURES.md](PLANNED_FEATURES.md).
