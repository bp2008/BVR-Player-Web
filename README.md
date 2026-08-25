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
| Save a snapshot | camera button | <kbd>S</kbd> |
| Metadata inspector | layers button | <kbd>I</kbd> |
| Export to MP4 | download button | <kbd>E</kbd> |
| Settings | gear button | |
| Close a panel | its &times; | <kbd>Esc</kbd> |

Double-clicking the video resets the zoom when zoomed in, and toggles fullscreen
otherwise.

<kbd>Space</kbd> always means play/pause, whatever has keyboard focus at the
time — a button you clicked a moment ago does not get a second click out of it.
Buttons, checkboxes and the rest are still activated from the keyboard with
<kbd>Enter</kbd>. The exception is a field you type into, where a space is a
space.

Dragging the scrub bar shows the nearest key frame as you go, which is what lets
a drag keep up on an hour-long recording; letting go settles on the exact frame
under the pointer. Frames keep arriving for as long as you hold the pointer down
— a picture already being decoded is never thrown away to chase a newer position,
because seeing every few frames of what you dragged past beats seeing none of it.

The skip interval (default 10 s), whether a recording starts playing when it is
opened (it does), time display (elapsed or wall clock), loop, playback speed,
overlay drawing, whether scrubbing decodes the exact frame rather than the
nearest key frame, whether playback pauses while you seek, and — for dual-stream
recordings — the main/sub stream selection and whether the two are shown in the
same shape, all live in the settings panel and persist in the web browser's
`localStorage`.

### Panels

Settings, the metadata inspector and export are panels rather than dialogs. Any
number of them can be open at once, docked to the left or right of the video, and
each takes its width from the picture rather than covering it — the video is
never hidden behind a panel.

- **Move one** by dragging its title bar to the other side, or double-click the
  title bar to send it across.
- **Resize a dock** by dragging its inner edge. Panels are never allowed more
  than 70% of the window between them; the video always keeps the rest.
- **Too little room** and panels fold up to their title bars, or a whole dock
  becomes a strip of buttons down the edge. Either way one click brings a panel
  back, and nothing it was holding — a scroll position, a tab, a half-configured
  export — is lost.
- **Pop one out** into a small window of its own with the ⧉ button, and put it
  back with the button in its place. Useful on a second monitor, and the panel
  keeps working exactly as it did while docked.

### Streams of the wrong shape

Blue Iris writes into every recording the resolution it asked each camera for.
Cameras do not always oblige. A sub stream declared 640×480 arriving encoded
704×480, or one declared 848×480 arriving encoded 704×480, is ordinary output —
and either way the picture on screen is stretched sideways, changing shape
mid-playback in switching mode, where the two streams arrive interleaved.

**Match declared shape** (on by default) takes the header's main-stream
resolution as the truth — it is the field of view the recording claims — and puts
any frame that decodes to a different shape back into it. Frames that already
agree are left alone, so a recording whose encoders did what they were told is
untouched. The short axis is stretched rather than the long one cropped, so
nothing the recording contains is discarded. Turn it off to see every stream
exactly as encoded.

The settings panel names both numbers for the file that is open, and the metadata
panel lists each stream's real size with the header's declared size beside it
where the two differ — so it is always visible whether a picture is being
corrected, and by how much.

Exports carry the correction too, by whichever route suits the method. **Copy
frames** cannot touch the pixels, so it writes the corrected size into the MP4
track header and a `pasp` pixel-aspect-ratio box beside the codec configuration —
a 704×480 stream under a 4:3 header comes out as the textbook 10:11. **Re-encode**
is redrawing every frame anyway, so it bakes the correction in and produces a
square-pixel file, which is the simpler and more widely understood of the two;
the resolution choices are then all of the corrected shape (704×528, 640×480,
480×360 and so on). The export panel says which is happening.

### Snapshots

The camera button, or <kbd>S</kbd>, saves the frame on screen as an image. The
whole picture is saved, aspect-corrected, rotated and with overlays exactly as
shown — without the letterboxing, and without the digital-zoom crop, so a
snapshot taken while zoomed in still holds every pixel the recording has.

Files are named after the recording and the frame's own UTC, to the millisecond:
`hillsidedrivet.20260824_203945.310Z.jpg`. The format is JPEG at 85% quality by
default; both the format (WebP is offered where the browser can encode it) and
the quality are in the settings panel.

Stills download as ordinary files. **Save into the open folder** writes them
straight into the folder **Browse** has open instead, which avoids the browser's
downloads bar popping up over the video on every save. It needs write permission
on that folder, asked for once, and it never overwrites: a name already in use
gains a `-2`.

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
whole (including the codec, resolution and frame count of whatever is playing),
the current frame, and a timeline of marks and recording-segment starts that
seeks on click. Overlays can also be drawn back over the video, where they
stay registered with the picture under rotation, flip and zoom.

### Exporting to MP4

**Export** writes an MP4 of the whole recording or a trimmed range, in one of two
ways:

- **Copy frames** — the compressed frames are moved into an MP4 container
  untouched. Fast, lossless, and the file is about the size of the source. It can
  only begin on a key frame, so the panel says when the start has to shift.
- **Re-encode** — decode and encode again, which trims exactly and can change
  codec, bitrate, resolution and frame rate.

The range is set by dragging the handles on the scrub bar, by the **start here**
and **end here** buttons, or by typing either timestamp into the panel. The
playhead follows whichever you use — including a handle being dragged — so the
frame you are cutting on is the frame on screen rather than a guess. Typing is
the way to pick a precise moment in a long recording, where a scrub bar a few
hundred pixels wide cannot resolve a particular second. Times are read as
`m:ss.mmm`, and shorthands work too: `12` is twelve seconds, `90:00` is ninety
minutes.

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
src/bvr/         format layer  - frame headers, file header, full-file index,
                                 codec probe, overlay metadata records
src/player/      playback      - decode pipelines, media clock, canvas renderer,
                                 zoom/pan gestures, overlay painting
src/library/     folder browser - directory access, thumbnail worker, IndexedDB cache
src/export/      MP4 export    - Annex-B to AVCC, ISO BMFF muxer, remux/transcode
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
- **Zoom.** The renderer never relies on the canvas intrinsic size; it draws
  through an explicit transform (fit → zoom → pan → rotate → flip), so zooming
  is a matter of writing the view and re-drawing. Frames are retained as
  `ImageBitmap`s at native resolution, so zooming in reveals real detail rather
  than magnifying a display-sized copy, and a zoom while paused re-presents the
  current frame at full resolution. Pan is bounded by how far the drawn image
  extends past the viewport, which collapses to zero at 1× and pins the picture
  centred.
- **Overlay metadata.** Type-2 records (spec §7) are deltas, so the state at a
  given time is the first record folded together with every record since.
  Replaying all of them after each seek would be thousands of reads on a long
  clip, and the format's placement guarantees make that unnecessary: shapes and
  every object that has ever changed are rewritten after each key frame, so a
  rebuild costs record 0 plus the handful inside the current GOP. Overlays are
  painted inside the frame transform, so they stay registered with the picture
  under rotation, flip and zoom without handling any of them.

  One correction to the spec: §7.1 calls the overlay and shape rectangles "video
  pixels", but every file Blue Iris writes uses per-axis thousandths — a
  full-frame overlay is `(0, 0, 1000, 1000)`, and boxes on a 1920×1080 recording
  reach exactly 1000 at the frame edge. The parser reads thousandths and falls
  back to pixels for any rectangle that overflows that range.
- **Export.** A stream copy never decodes: each access unit's start codes become
  length prefixes and the same slice bytes are handed to the writer, with the
  parameter sets hoisted into `avcC`/`hvcC`. The muxer writes `ftyp`, `mdat`,
  `moov` in that order — index last is what keeps the job to one pass, since
  sample sizes are only known once each sample has been converted, and reading
  the source twice to learn them in advance would double the I/O on a file that
  may be gigabytes. It also means parameter sets can be collected from every key
  frame visited rather than guessed from the first.
- **Thumbnails.** Fixed cost per clip regardless of length: the header, a walk to
  the first key frame, that key frame, and a backwards read from EOF for the
  duration (spec §9.3). Decoding runs in a small worker pool, feature-detected
  with an inline fallback because `new Worker()` is unavailable on `file://`;
  Vite's `?worker&inline` keeps the worker inside the single-file build.

The container format details were provided by the Blue Iris developer and is avialable here: [BVR_File_Format_Spec.md](BVR_File_Format_Spec.md).

Roadmap notes for this app live in [PLANNED_FEATURES.md](PLANNED_FEATURES.md).
