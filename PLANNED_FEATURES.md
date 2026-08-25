# Planned features

Internal roadmap notes. This file is **not** part of the deployed app — it is not
referenced from `index.html`, not copied out of `public/`, and never reaches the
built `docs/` output.

Version 1 shipped only the transport controls. The four features below have since
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
  of the three has an MP4 form players can be relied on to handle. The dialog
  says so. Audio is encoded first and spliced into the video stream at
  one-second chunk boundaries.
- **Trim.** Handles on the scrub bar, plus "start/end at playhead". A stream copy
  that has to shift to the preceding key frame says by how much and offers the
  re-encode instead.
- **Delivery.** `showSaveFilePicker()` where available, so a multi-gigabyte
  export never exists in memory; a Blob download otherwise, with a warning above
  1.5 GB.
- **Switching mode** is refused for a stream copy and the dialog explains why —
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
- **Very large files — not done, deliberately.** The design still scans the whole
  file once on open. Making the index sparse and seeking by the spec's
  interpolate-and-search (§9.5) would help a multi-gigabyte clip on a network
  share, but it trades away the property the current design is built on: every
  seek is exact and needs no searching. `src/bvr/tail.js` now implements the
  backwards last-frame scan (§9.3) that such a mode would need, so the groundwork
  is there — but the switch itself is a change to how seeking works, not an
  addition, and should be a deliberate decision rather than a side effect of
  building the features above.
