# Development

Implementation notes, design decisions and behaviour in detail for
BVR-Player-Web. For what the app is and how to drive it, see
[README.md](README.md).

- [Behaviour in detail](#behaviour-in-detail)
- [Working on the code](#working-on-the-code)
- [How it works](#how-it-works)
- [Design decisions](#design-decisions)
- [References](#references)


## Behaviour in detail

### Settings

The skip interval (default 10 s), whether a recording starts playing when it is
opened (it does), time display (elapsed or wall clock), loop, playback speed,
overlay drawing, whether scrubbing decodes the exact frame rather than the
nearest key frame, whether playback pauses while you seek, and — for dual-stream
recordings — the main/sub stream selection and whether the two are shown in the
same shape, all live in the settings panel and persist in the web browser's
`localStorage`.

### Seeking and scrubbing

Dragging the scrub bar shows the nearest key frame as you go, which is what lets
a drag keep up on an hour-long recording; letting go settles on the exact frame
under the pointer. Frames keep arriving for as long as you hold the pointer down
— a picture already being decoded is never thrown away to chase a newer position,
because seeing every few frames of what you dragged past beats seeing none of it.

### Playback speed

0.25× to 8×, from the control-bar chip, the settings panel or <kbd>[</kbd> /
<kbd>]</kbd>. Audio is muted away from 1×, which is what the reference Blue Iris
player does; resampling it would only produce pitch-shifted surveillance audio
nobody wants.

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

Panels stay open when the next recording is opened.

### Streams of the wrong shape

Blue Iris writes into every recording the resolution it asked each camera for.
Cameras do not always oblige. A sub stream declared 640×480 arriving encoded
704×480, or one declared 848×480 arriving encoded 704×480, is ordinary output —
and either way the picture on screen is stretched sideways, changing shape
mid-playback in switching mode, where the two streams arrive interleaved.

**Match declared shape** (on by default) takes the header's main-stream
resolution as the truth — it is the field of view the recording claims — and puts
any frame that decodes to a different shape back into it. That is decided per
frame, as a switching-mode file interleaving two shapes needs; frames that
already agree are left alone, so a recording whose encoders did what they were
told is untouched. The short axis is stretched rather than the long one cropped,
so nothing the recording contains is discarded. Turn it off to see every stream
exactly as encoded.

It is the renderer's destination rectangle that changes, so overlays stay
registered with the picture, and toggling the setting simply re-presents the
current frame.

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
whole (including the codec, resolution and frame count of whatever is playing,
the recording window, the AOI, and the motion-mask geometry with a rendered
grid), the current frame, and a timeline of marks and recording-segment starts
that seeks on click. Overlays can also be drawn back over the video, where they
stay registered with the picture under rotation, flip and zoom.

### Exporting to MP4

**Export** writes an MP4 of the whole recording or a trimmed range, in one of two
ways:

- **Copy frames** — the compressed frames are moved into an MP4 container
  untouched. Fast, lossless, and the file is about the size of the source. It can
  only begin on a key frame, so the panel says when the start has to shift and by
  how much, and offers the re-encode instead.
- **Re-encode** — decode and encode again, which trims exactly and can change
  codec, bitrate, resolution and frame rate.

A stream copy is refused for a switching-mode recording, and the panel explains
why: a resolution change mid-stream is what MP4 tolerates poorly, so the user is
pointed at the single-stream selection instead.

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
an export can be far larger than memory; otherwise it arrives as a Blob download,
with a warning above 1.5 GB.


## Working on the code

```bash
npm install
npm run dev
```

`npm run build` regenerates the PWA icons and writes the single-file bundle plus
the PWA side-files to `docs/`. That directory is committed on purpose — it is
what GitHub Pages serves and what you double-click. `build.bat` does the same
from Explorer or a plain `cmd` window, installing dependencies first if
`node_modules` is missing; pass `nopause` to skip the prompt at the end.

Put `.bvr` files in `sample/` for local testing; that folder is git-ignored.

### Deployment shapes

Two are supported from the same build:

- **Served** (GitHub Pages or any static host) — point Pages at the `docs/`
  folder on `main`. This gets the full PWA: installable, offline app shell, and
  an OS file handler for `.bvr` once installed.
- **Off the filesystem** — double-click `docs/index.html`. Everything is inlined
  into that one file, so it works over `file://` with no server. The service
  worker and install prompt are simply absent there.

### The service worker

It is registered only in production builds; a dev page instead unregisters any
worker left behind by a production build loaded from the same origin, so
`npm run dev` can never be served a stale module.

Its caching is arranged so a deploy is picked up without any cache-busting
ritual. Navigations are network-first, and because the whole app is inlined into
`index.html` there are no separate JS/CSS files that could go stale behind it —
a new build lands on the next visit, subject only to the `max-age=600` GitHub
Pages puts on every file. Icons and the manifest are stale-while-revalidate:
served from cache at once, refreshed in the background. `CACHE` is a constant
and does not need bumping per build; that would re-download the shell every
deploy to fix a problem stale-while-revalidate already solves.


## How it works

Video is decoded with [WebCodecs](https://developer.mozilla.org/docs/Web/API/WebCodecs_API).

```
src/bvr/         format layer   - frame headers, file header, full-file index,
                                  codec probe, overlay metadata, tail scan
src/player/      playback       - decode pipelines, media clock, canvas renderer,
                                  zoom/pan gestures, overlay painting
src/library/     folder browser - directory access, thumbnail worker, IndexedDB cache
src/export/      MP4 export     - Annex-B to AVCC, ISO BMFF muxer, remux/transcode
src/panels/      docking        - the panel list, the layout solver, pop-out windows
src/util/        shared rules   - aspect correction, settings, formatting, keys
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

  Indexing stays on the main thread deliberately. It already yields to the event
  loop often enough to keep the progress bar painting, and it is bounded by read
  throughput rather than by computation, so a worker would buy little.
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

  `src/player/ViewController.js` holds the gestures: wheel zoom about the
  pointer, two-finger pinch about the midpoint, drag to pan once zoomed, and a
  drag-versus-click latch so panning never toggles playback on release. Zoom
  survives seeks, stream switches and fullscreen; it resets on a new file, from
  <kbd>Z</kbd>, or from the chip that appears in the control bar while zoomed.
- **Overlay metadata.** `src/bvr/metadata.js` reads the 692-byte `overobdata`
  array (type 1), the `{ int32 index, int32 size, bytes }` update stream (type
  2), 56-byte `shapeobdata` boxes, UTF-16LE text, embedded images and the GPS
  triple. The frame index also retains `dio_inputs` and `state_bits` per video
  frame — two extra typed arrays — so an overlay object's `stateflags` / `dio`
  draw conditions can be evaluated against any frame.

  Type-2 records (spec §7) are deltas, so the state at a given time is the first
  record folded together with every record since; `src/player/MetadataPipeline.js`
  folds them forward as the playhead moves. Replaying all of them after each seek
  would be thousands of reads on a long clip, and the format's placement
  guarantees make that unnecessary: shapes and every object that has ever changed
  are rewritten after each key frame, so a rebuild costs record 0 plus the
  handful inside the current GOP. `src/player/overlayPainter.js` paints inside the
  frame transform, so overlays stay registered with the picture under rotation,
  flip and zoom without handling any of them; glyphs are counter-rotated so a
  rotated recording does not get unreadable text.

  Marks and segment starts are collected from the **whole file** rather than from
  the stream being played: a dual-stream recording routinely puts its mark on one
  stream only.

  One correction to the spec: §7.1 calls the overlay placement rectangle and
  `shapeobdata.rect` "video pixels", but every file Blue Iris writes uses per-axis
  thousandths — a full-frame overlay is `(0, 0, 1000, 1000)`, and boxes on a
  1920×1080 recording reach exactly 1000 at the frame edge. Thousandths are also
  the only reading under which the spec's own "if `right <= left`, treat width as
  100" default makes sense as a placement rule. The parser reads thousandths and
  falls back to pixels for any rectangle that overflows that range.
- **Export.** A stream copy never decodes: `src/export/bitstream.js` turns each
  access unit's start codes into length prefixes and hands the same slice bytes
  to the writer, with the parameter sets hoisted into `avcC` / `hvcC` — including
  the High-profile chroma and bit-depth extension for H.264 and the full
  profile-tier-level block for HEVC. A stream that redefines a parameter-set id
  mid-file is detected and reported rather than silently mangled. A re-encode
  runs `VideoDecoder` into `VideoEncoder` instead, which is what lets it trim
  exactly: decoding starts at the preceding key frame and the lead-in is dropped.

  The muxer writes `ftyp`, `mdat`, `moov` in that order — index last is what
  keeps the job to one pass, since sample sizes are only known once each sample
  has been converted, and reading the source twice to learn them in advance would
  double the I/O on a file that may be gigabytes. It also means parameter sets
  can be collected from every key frame visited rather than guessed from the
  first.

  Audio is encoded first, through `AudioEncoder` to AAC, and spliced into the
  video stream at one-second chunk boundaries.
- **Thumbnails.** Fixed cost per clip regardless of length — a few hundred
  kilobytes whether the recording is thirty seconds or two hours: the header, a
  walk of the opening frames to the first key frame, that key frame, and a
  backwards read from EOF for the duration (spec §9.3, `src/bvr/tail.js`). The
  **sub** stream is preferred when present: smaller, faster, and it scales down to
  a thumbnail better anyway.

  The key frame is read **whole**. Reading only its front — enough for the
  parameter sets — was enough to configure a decoder but not to decode a picture,
  and any key frame past that budget came out half black: the top slices decoded,
  the rest missing. A 1920×1080 key frame is routinely 200 KB.

  The downscale goes through `createImageBitmap`'s own resize rather than one
  `drawImage`. A single bilinear step from 1920 to 384 samples one source pixel in
  five and discards the rest, which is why it read as nearest-neighbour; the
  native resize is both the better picture and the cheaper one. Where it is
  unavailable the fallback halves repeatedly, each step averaging four pixels into
  one.

  Decoding runs in a small worker pool (`thumbWorker.js` and `thumbService.js`),
  feature-detected with the identical module run inline, because `new Worker()` is
  unavailable on `file://`; Vite's `?worker&inline` keeps the worker inside the
  single-file build. Blobs cross to the worker by reference, so handing over a
  two-gigabyte recording costs nothing.

  `thumbCache.js` is IndexedDB, keyed by (name, size, mtime), with LRU trimming.
  It also persists the directory handle so the last folder reopens, subject to the
  permission re-grant browsers require after a reload. `bvrName.js` reads the
  camera and start time Blue Iris encodes into the file name
  (`hillsidedrivet.20260824_203931Z.bvr`), which is free to read and lets the grid
  group by day and sort before any file is touched.
- **Panel layout.** `src/panels/panels.js` is the one list of panels, read by the
  layout solver, the persisted settings, the control-bar buttons and the panel
  frames, so a panel cannot exist in one of those and not the others.
  `solveDocks()` in `src/panels/layout.js` decides both dock widths at once: a
  preferred width, a floor, a ceiling that belongs to the two docks together, and
  a different shape again when even the floors do not fit. Those rules interact,
  and are only checkable if they are read in one place.

  The 70% rule is the governing constraint: whatever else happens, the video keeps
  30% of the window. Below roughly 750 px there is no room for two open docks, so
  the inactive one becomes a strip of buttons; its panels stay mounted, which is
  what makes swapping instant and lossless. Vertically, panels in one dock share
  its height and fold to their title bars when there is not enough of it,
  most-recently-used staying open. The titles never leave, so switching is one
  click either way.

  `src/components/PanelFrame.vue` only *detects* a title-bar drag; where it may
  land is a question about the docks, which the frame cannot see. `App` answers it
  by reading where the panels actually are on screen, because CSS `order` decides
  that and only the layout knows.

  Pop-out is a `<Teleport>` into a second window's document rather than a second
  copy of the panel: the same component instance, so the scroll position, the open
  tab and a half-configured export all survive the move. `src/panels/popout.js`
  handles the two things that do not travel by themselves — the stylesheets, and
  the window's own lifetime. A blocked popup is an ordinary outcome and leaves the
  panel docked with a notice.


## Design decisions

Where the obvious implementation was tried and replaced, or deliberately not
taken.

### Very large files — not done, on purpose

The design still scans the whole file once on open. Making the index sparse and
seeking by the spec's interpolate-and-search (§9.5) would help a multi-gigabyte
clip on a network share, but it trades away the property the current design is
built on: every seek is exact and needs no searching. `src/bvr/tail.js` already
implements the backwards last-frame scan (§9.3) that such a mode would need, so
the groundwork is there — but the switch itself is a change to how seeking works,
not an addition, and should be a deliberate decision rather than a side effect of
building something else.

### Matched stream shapes, corrected once

The first version compared the two streams' *declared* resolutions and rescaled
the odd one out. That was the wrong comparison, and on real files it did nothing
at all: Blue Iris writes down the resolution it asked the camera for, and cameras
hand back something else. Two samples in hand declare 1600×1200 + 640×480 and
2688×1520 + 848×480 — declared shapes agreeing to within a fraction of a percent
— while both sub streams actually arrive encoded 704×480. The setting reported
"both streams are already the same shape" over a visibly stretched picture.

The reference is now the header's main-stream resolution outright, and the real
encoded size is read out of the H.264 / H.265 SPS (and a JPEG's SOF marker) so
that the two can be told apart at all. A percent of slack absorbs macroblock
rounding, since re-shaping a picture that is already right only costs sharpness.
Reading the SPS pays for itself elsewhere: the stream picker, the metadata panel
and the MP4 track header an export writes now all carry the size the pictures
really are, with the declared size shown alongside where they differ.

The rule itself lives in `src/util/aspect.js` rather than in the renderer,
because the exporter has to reach the same answer: a saved clip that plays at a
different shape from the one that was on screen would be a worse bug than the one
this exists to fix.

The two export methods then carry the correction by opposite routes, which is the
point. A stream copy says it in the container: the `tkhd` display size becomes the
corrected one — it was previously the coded size, which is what the *sample entry*
is for — and a `pasp` box (ISO 14496-12 8.5.2) goes in beside the codec
configuration. The spacings are derived from the header's two integers rather than
from their quotient, so they come out exact: 704×480 under a 1600×1200 header is
10:11, the textbook NTSC D1 value, where a float would have produced whatever
six-figure pair the rounding landed on. A re-encode is redrawing every frame
regardless, so it scales to the corrected size and writes a square-pixel file with
no `pasp` at all — simpler, and understood by everything, including the players
that quietly ignore pixel aspect ratios. The resolution cap then works from the
corrected shape, so "480p" on a 704×480 sub stream under a 4:3 header means
640×480 rather than 704×480. Both output dimensions are rounded to even numbers:
the corrected size is as likely to be odd as any other, and 4:2:0 encoders reject
odd dimensions.

### One gesture, one meaning

Double click toggles fullscreen. It once reset the zoom when zoomed and fell
through to fullscreen otherwise, but one gesture meaning two things by context was
more surprising than useful; zoom now resets from <kbd>Z</kbd> or the chip alone.

### What the docked panels replaced

`SettingsMenu.vue` and `ExportDialog.vue` are gone. Export in particular was the
wrong shape as a modal: it trims a range, and the video it is trimming was behind
it with the scrub bar unreachable. The recording's own facts — codec, resolution,
nominal rate, frame count — moved from the settings popup to the metadata panel,
which is where a description of the file belongs. Panels no longer close when the
next recording is opened either; that was only ever a consequence of their having
been overlays.

### Snapshots are taken synchronously

The picture is taken before anything is awaited, so what is saved is the frame
that was on screen when the button was pressed, however long the encode and the
write take afterwards; and nothing serialises, so a rapid burst is one still per
press. Overlay line and glyph sizes are taken from the on-screen fit rather than
from the still's own pixel count, so a saved frame looks like the one that was
being looked at instead of carrying hairlines across 2688 pixels. WebP is
feature-tested on a single pixel, because a canvas asked for a format it lacks
quietly writes PNG instead. The flash cue is one element per still, each running
its own animation and discarded when it finishes — sharing one element would mean
restarting an animation mid-flight, and a burst would read as a single long flash
rather than as one cue per still.


## References

- [BVR_File_Format_Spec.md](BVR_File_Format_Spec.md) — the container format,
  provided by the Blue Iris developer.
