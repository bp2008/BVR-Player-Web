# Planned features

Internal roadmap notes. This file is **not** part of the deployed app — it is not
referenced from `index.html`, not copied out of `public/`, and never reaches the
built `docs/` output.

Version 1 shipped only the transport controls. The five features below have since
been built; what follows records how each one turned out, the places where the
implementation had to disagree with the spec, and the one item still outstanding.

---

## 1. Folder browser with thumbnails — **done**

In-app browsing of a directory of `.bvr` files, with a thumbnail per clip.

**How it works**

- `src/library/directory.js` — `showDirectoryPicker()` on Chromium, with
  `<input type="file" webkitdirectory>` as the fallback. Neither works from
  `file://`, so the **Browse** button only appears where one of them does; the
  single-file flow is untouched either way.
- `src/library/thumbnailer.js` — per clip: file header, a walk of the opening
  frames to the first key frame, that key frame decoded, downscaled to an
  `OffscreenCanvas` and encoded as WebP. Cost is fixed at a few hundred kilobytes
  whether the recording is thirty seconds or two hours. The **sub** stream is
  preferred when present: smaller, faster, and it scales down to a thumbnail
  better anyway.
- The key frame is read **whole**. Reading only its front — enough for the
  parameter sets — was enough to configure a decoder but not to decode a picture,
  and any key frame past that budget came out half black: the top slices decoded,
  the rest missing. A 1920×1080 key frame is routinely 200 KB.
- The downscale goes through `createImageBitmap`'s own resize rather than one
  `drawImage`. A single bilinear step from 1920 to 384 samples one source pixel in
  five and discards the rest, which is why it read as nearest-neighbour; the
  native resize is both the better picture and the cheaper one. Where it is
  unavailable the fallback halves repeatedly, each step averaging four pixels into
  one.
- Clip length comes from spec §9.3 — read backwards from EOF for the last
  complete video frame (`src/bvr/tail.js`). Two short reads give a duration for a
  file that is never otherwise opened.
- `src/library/thumbWorker.js` + `thumbService.js` — a small worker pool, with
  the identical module run inline where `new Worker()` is unavailable. Blobs
  cross to the worker by reference, so handing over a two-gigabyte recording
  costs nothing. Vite's `?worker&inline` keeps it inside the single-file build.
- `src/library/thumbCache.js` — IndexedDB, keyed by (name, size, mtime), with LRU
  trimming. It also persists the directory handle so the last folder reopens,
  subject to the permission re-grant browsers require after a reload.
- `src/library/bvrName.js` — Blue Iris encodes camera and start time into the
  file name (`hillsidedrivet.20260824_203931Z.bvr`), which is free to read and
  lets the grid group by day and sort before any file is touched.

## 2. Digital zoom and pan — **done**

- `Renderer` gained `zoomAt`, `panBy`, `clampView` and a screen-to-frame mapping.
  Pan is bounded by how far the drawn image extends past the viewport, so at zoom
  1 it collapses to zero (the picture stays centred) and above that it stops
  exactly when a frame edge meets a viewport edge.
- `src/player/ViewController.js` — wheel zoom about the pointer, two-finger
  pinch about the midpoint, drag to pan once zoomed, and a drag-versus-click
  latch so panning never toggles playback on release.
- Zoom survives seeks, stream switches and fullscreen; it resets on a new file.
- **Double click** resets zoom when zoomed and toggles fullscreen otherwise —
  the roadmap wanted both on the same gesture, and this is the ordering that
  reads naturally. <kbd>F</kbd> and the button still reach fullscreen either way.
- A zoom chip appears in the control bar while zoomed, and clicking it resets.

## 3. Export to MP4 — **done**

Both modes shipped, sharing one muxer (`src/export/`).

- **Remux.** `bitstream.js` converts Annex-B to length-prefixed samples and
  builds `avcC` / `hvcC` from the parameter sets, including the High-profile
  chroma/bit-depth extension for H.264 and the full profile-tier-level block for
  HEVC. Parameter sets are collected across *every* key frame visited, which the
  moov-last layout makes possible; a stream that redefines one id mid-file is
  detected and reported rather than silently mangled.
- **Transcode.** `VideoDecoder` into `VideoEncoder`, with codec, bitrate,
  resolution and frame-rate options. This is the mode that can trim exactly:
  decoding starts at the preceding key frame and the lead-in is dropped.
- **Layout.** `ftyp`, `mdat`, `moov`. Index-last is what keeps the job to one
  pass — sample sizes are only known once each sample has been converted, and
  reading the source twice to learn them in advance would double the I/O on a
  file that may be gigabytes.
- **Audio.** FLAC, PCM and µ-law all go through `AudioEncoder` to AAC, since none
  of the three has an MP4 form players can be relied on to handle. The panel
  says so. Audio is encoded first and spliced into the video stream at
  one-second chunk boundaries.
- **Trim.** Handles on the scrub bar, plus "start/end at playhead". A stream copy
  that has to shift to the preceding key frame says by how much and offers the
  re-encode instead.
- **Delivery.** `showSaveFilePicker()` where available, so a multi-gigabyte
  export never exists in memory; a Blob download otherwise, with a warning above
  1.5 GB.
- **Switching mode** is refused for a stream copy and the panel explains why —
  the resolution change mid-stream is what MP4 tolerates poorly, so the user is
  pointed at the single-stream selection instead.

## 4. BVR metadata viewer — **done**

- `src/bvr/metadata.js` — the 692-byte `overobdata` array (type 1), the
  `{ int32 index, int32 size, bytes }` update stream (type 2), 56-byte
  `shapeobdata` boxes, UTF-16LE text, embedded images and the GPS triple.
- The index now retains `dio_inputs` and `state_bits` per video frame — two extra
  typed arrays — so an overlay object's `stateflags` / `dio` draw conditions can
  be evaluated against any frame.
- `src/player/MetadataPipeline.js` folds records forward as the playhead moves.
  A seek does not replay the file: spec §7 guarantees shapes and every changed
  object are rewritten after each key frame, so rebuilding costs record 0 plus
  the handful inside the current GOP.
- `src/player/overlayPainter.js` draws boxes, text and images through the
  `Renderer` transform, so they stay registered with the picture under rotation,
  flip and zoom. Glyphs are counter-rotated so a rotated recording does not get
  unreadable text.
- `MetadataPanel.vue` — a per-frame inspector, a file-level summary (codecs,
  streams, recording window, AOI, motion-mask geometry with a rendered grid), and
  a timeline of marks and segment starts that seeks on click.

### Where the files disagreed with the spec

Spec §7.1 describes the overlay placement rectangle and `shapeobdata.rect` as
"video pixels". Every file Blue Iris actually writes disagrees: a full-frame
overlay is `(0, 0, 1000, 1000)`, and bounding boxes on a 1920×1080 recording
reach exactly 1000 at the frame edge. They are per-axis thousandths — which is
also the only reading under which the spec's own "if `right <= left`, treat width
as 100" default makes sense as a placement rule. The parser reads thousandths and
falls back to pixels for any rectangle that overflows that range.

Marks and segment starts are collected from the **whole file** rather than from
the stream being played: a dual-stream recording routinely puts its mark on one
stream only, and `utilityvisible` in `sample/` does exactly that.

## 5. Docked panels — **done**

Settings, the metadata inspector and export share one docking system instead of
being a popup, an overlay and a modal dialog respectively.

- `src/panels/panels.js` — the one list of panels, read by the layout solver, the
  persisted settings, the control-bar buttons and the panel frames, so a panel
  cannot exist in one of those and not the others.
- `src/panels/layout.js` — `solveDocks()` decides both dock widths at once. The
  rules interact (a preferred width, a floor, a ceiling that belongs to both docks
  together, and a different shape when even the floors do not fit), and they are
  only checkable if they are read in one place.
- **The 70% rule** is the governing constraint: whatever else happens, the video
  keeps 30% of the window. Below roughly 750 px there is no room for two open
  docks, so the inactive one becomes a strip of buttons; its panels stay mounted,
  which is what makes swapping instant and lossless.
- **Vertically**, panels in one dock share its height and fold to their title bars
  when there is not enough of it, most-recently-used staying open. The titles
  never leave, so switching is one click either way.
- `src/components/PanelFrame.vue` only *detects* a title-bar drag; where it may
  land is a question about the docks, which the frame cannot see. `App` answers it
  by reading where the panels actually are on screen, because CSS `order` decides
  that and only the layout knows.
- **Pop-out** is a `<Teleport>` into a second window's document rather than a
  second copy of the panel: same component instance, so the scroll position, the
  open tab and a half-configured export all survive the move. `src/panels/popout.js`
  handles the two things that do not travel by themselves — the stylesheets, and
  the window's own lifetime. A blocked popup is an ordinary outcome and leaves the
  panel docked with a notice.

### What this replaced

`SettingsMenu.vue` and `ExportDialog.vue` are gone. Export in particular was the
wrong shape as a modal: it trims a range, and the video it is trimming was behind
it with the scrub bar unreachable. The recording's own facts — codec, resolution,
nominal rate, frame count — moved from the settings popup to the metadata panel,
which is where a description of the file belongs.

Panels no longer close when the next recording is opened. That was only ever a
consequence of their having been overlays.

---

## Cross-cutting items

- **Playback speed — done.** 0.25× to 8×, from the control bar chip, the settings
  menu or <kbd>[</kbd> / <kbd>]</kbd>. Audio is muted away from 1×, which is what
  the reference Blue Iris player does; resampling it would only produce
  pitch-shifted surveillance audio nobody wants.
- **Workers — done.** Thumbnailing runs in a small worker pool, feature-detected
  with an inline fallback so the double-click-the-HTML deployment keeps working.
  Indexing stays on the main thread: it already yields to the event loop often
  enough to keep the progress bar painting, and it is bounded by read throughput
  rather than by computation, so a worker would buy little.
- **Matched stream shapes — done, then corrected.** The first version compared
  the two streams' *declared* resolutions and rescaled the odd one out. That was
  the wrong comparison, and on real files it did nothing at all: Blue Iris writes
  down the resolution it asked the camera for, and cameras hand back something
  else. Two samples in hand declare 1600x1200 + 640x480 and 2688x1520 + 848x480 --
  declared shapes agreeing to within a fraction of a percent -- while both sub
  streams actually arrive encoded 704x480. The setting reported "both streams are
  already the same shape" over a visibly stretched picture.

  The reference is now the header's main-stream resolution outright, and the real
  encoded size is read out of the H.264 / H.265 SPS (and a JPEG's SOF marker) so
  that the two can be told apart at all. Any frame that decodes to a different
  shape is put back into the declared one; frames that already agree are
  untouched, which is decided per frame, as a switching-mode file interleaving
  two shapes needs. It is the renderer's destination rectangle that changes, so
  overlays stay registered with the picture and the current frame is simply
  re-presented when the setting is toggled. The short axis is stretched rather
  than the long one cropped: nothing the recording contains is discarded. A
  percent of slack absorbs macroblock rounding, since re-shaping a picture that
  is already right only costs sharpness.

  Reading the SPS pays for itself elsewhere: the stream picker, the metadata
  panel and the MP4 track header an export writes now all carry the size the
  pictures really are, with the declared size shown alongside where they differ.

  The rule itself lives in `src/util/aspect.js` rather than in the renderer,
  because the exporter has to reach the same answer: a saved clip that plays at a
  different shape from the one that was on screen would be a worse bug than the
  one this exists to fix.

- **Aspect ratio in exported MP4s — done.** The two export methods carry the
  correction by opposite routes, which is the point. A stream copy cannot touch
  the pixels, so it says so in the container: the `tkhd` display size becomes the
  corrected one -- it was previously the coded size, which is what the *sample
  entry* is for -- and a `pasp` box (ISO 14496-12 8.5.2) goes in beside the codec
  configuration. The spacings are derived from the header's two integers rather
  than from their quotient, so they come out exact: 704x480 under a 1600x1200
  header is 10:11, the textbook NTSC D1 value, where a float would have produced
  whatever six-figure pair the rounding landed on.

  A re-encode is redrawing every frame regardless, so it scales to the corrected
  size and writes a square-pixel file with no `pasp` at all -- simpler, and
  understood by everything, including the players that quietly ignore pixel
  aspect ratios. The resolution cap then works from the corrected shape, so
  "480p" on a 704x480 sub stream under a 4:3 header means 640x480 rather than
  704x480. Both output dimensions are rounded to even numbers: the corrected size
  is as likely to be odd as any other, and 4:2:0 encoders reject odd dimensions.

- **Snapshots — done.** The camera button, or `S`, saves the frame on screen.
  The picture is taken synchronously before anything is awaited, so what is saved
  is the frame that was on screen when the button was pressed however long the
  encode and the write take afterwards, and nothing serialises, so a rapid burst
  is one still per press. The whole picture is written -- aspect corrected,
  rotated, overlaid -- without the letterbox bars or the digital-zoom crop, which
  belong to the viewport rather than to the recording. Overlay line and glyph
  sizes are taken from the on-screen fit rather than from the still's own pixel
  count, so a saved frame looks like the one that was being looked at instead of
  carrying hairlines across 2688 pixels.

  JPEG at 85% is the default; WebP is offered where the canvas can encode it
  (feature-tested on one pixel, because a canvas asked for a format it lacks
  quietly writes PNG instead). Stills download by default, or go straight into
  the folder the browser has open -- which needs write permission on top of the
  read grant browsing asked for, so it is opt-in, and it never overwrites.

  The cue is one element per still, each running its own animation and discarded
  when it finishes. Sharing one element would mean restarting an animation
  mid-flight, and a burst would read as a single long flash rather than as one
  cue per still.

- **Very large files — not done, deliberately.** The design still scans the whole
  file once on open. Making the index sparse and seeking by the spec's
  interpolate-and-search (§9.5) would help a multi-gigabyte clip on a network
  share, but it trades away the property the current design is built on: every
  seek is exact and needs no searching. `src/bvr/tail.js` now implements the
  backwards last-frame scan (§9.3) that such a mode would need, so the groundwork
  is there — but the switch itself is a change to how seeking works, not an
  addition, and should be a deliberate decision rather than a side effect of
  building the features above.
