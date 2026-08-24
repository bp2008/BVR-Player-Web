# Planned features

Internal roadmap notes. This file is **not** part of the deployed app — it is not
referenced from `index.html`, not copied out of `public/`, and never reaches the
built `docs/` output.

Version 1 deliberately ships only the transport controls. The notes below record
which of the planned features already have a hook in the current design and what
each one still needs, so the groundwork stays intentional rather than accidental.

---

## 1. Folder browser with thumbnails

In-app browsing of a directory of `.bvr` files, with a thumbnail per clip.

**Already in place**

- `BvrPlayer.open()` accepts any `Blob`/`File`, so it does not care whether the
  file came from a picker, a drop, or a directory listing.
- `BlobReader` is windowed and never reads a whole file, so producing a thumbnail
  costs one header parse plus one key frame — a few hundred kilobytes regardless
  of clip length.
- `describeVideoCodec()` derives a complete `VideoDecoderConfig` from a single
  key frame, so a thumbnail needs no playback pipeline at all.

**Still needed**

- Directory access. `showDirectoryPicker()` (File System Access API) on Chromium,
  with `<input type="file" webkitdirectory>` as the fallback; neither works from
  `file://`, so the browser must degrade to the current single-file flow there.
- A thumbnail worker: open → parse header → read first key frame → decode one
  frame → `createImageBitmap` → downscale to a canvas → cache. Keep it off the
  main thread, but remember that `new Worker()` is unavailable on `file://`.
- A thumbnail cache keyed by (name, size, mtime), most likely in IndexedDB.
- A grid/list view, sorting, and a filename-derived timeline (Blue Iris encodes
  camera and UTC start into the file name, e.g.
  `hillsidedrivet.20260824_203931Z.bvr`).

**Design constraint**

Persisted directory handles require IndexedDB and a served origin. The folder
browser should therefore be an enhancement that appears when supported, never a
precondition for opening a single file.

---

## 2. Digital zoom and pan

Pinch-zoom, mouse-wheel zoom, and click-drag panning of the video surface.
Implementation specifics to be supplied later.

**Already in place**

- `Renderer` never relies on the canvas intrinsic size. It sizes the backing
  store to the element box and draws through an explicit transform chain
  (fit → zoom → pan → rotate → flip). The zoom feature only has to write to
  `renderer.view = { zoom, panX, panY }` and re-draw.
- `BvrPlayer._repaint()` re-presents the current frame from the decoded-frame
  window, so zoom changes while paused redraw at full resolution rather than
  upscaling a stale bitmap.
- Frames are retained as `ImageBitmap`s at native resolution, so zooming in
  reveals real detail instead of magnifying a display-sized copy.

**Still needed**

- Pointer handling: wheel (zoom about the cursor), two-pointer pinch, drag to
  pan, double-click to reset.
- Clamping so the visible region cannot leave the frame, and a minimum zoom of
  1 (or a configurable "fit" mode).
- Interaction with fullscreen and with the rotation bits from the file header.
- A zoom indicator, and a decision about whether zoom state survives a seek or a
  file change (it should survive a seek).

---

## 3. Export to MP4

Two distinct modes:

**a. Remux (cheap).** Copy the existing access units into an MP4 container with
no re-encoding. BVR stores Annex-B elementary streams with in-band parameter
sets, so this requires converting Annex-B start codes to length-prefixed AVCC /
HVCC samples, building `avcC`/`hvcC` from the SPS/PPS (and VPS for HEVC) that
`codec.js` already knows how to locate, and writing the `moov` from the frame
table the indexer already builds.

**b. Transcode.** Decode with `VideoDecoder` and re-encode with `VideoEncoder`,
exposing codec, bitrate, resolution and frame-rate options.

**Already in place**

- The index carries byte offset, size, timestamp, UTC and flags for every frame
  of both streams, which is exactly the sample table an MP4 writer needs — no
  second pass over the file.
- `splitAnnexB()` already separates NAL units, which is the core of the Annex-B →
  AVCC conversion.
- Audio packet start times are reconstructed exactly from cumulative sample
  counts (`AudioPipeline.prepare()`), so an audio track can be written with
  correct sample durations.
- The `VideoPipeline` decode-window design (feed from a key frame, drop the
  lead-in) is the same machinery a range export needs.

**Still needed**

- An MP4 muxer. Writing one is very feasible for this narrow case (no B-frames,
  one or two tracks); a library is the alternative but must stay bundle-friendly
  and work without a server.
- Trim range selection in the UI, plus the rule that a remux can only start at a
  key frame — a non-key start either shifts to the previous key frame or forces
  transcoding.
- Output delivery. `showSaveFilePicker()` where available, otherwise a Blob
  download; large exports need streaming to avoid materialising the whole file
  in memory.
- Audio handling: FLAC and µ-law are not MP4-native, so audio must either be
  transcoded (AAC/Opus via `AudioEncoder`) or dropped, and the UI has to say so.
- Switching-mode files change resolution mid-stream, which MP4 tolerates poorly;
  export should offer a single-stream selection in that case.

---

## 4. BVR metadata viewer

Surface the overlay objects, GPS records, AI/motion bounding boxes, camera state
bits, marks and the motion mask that the format carries.

**Already in place**

- `parseFileHeader()` returns the full header: `WAVEFORMATEX`, both
  `BITMAPINFOHEADER`s, the AOI rectangles and the decoded motion mask
  (dimensions, packed bits and the "show motion" flag byte).
- `buildIndex()` collects every metadata frame as
  `{ offset, size, subtype, ts, utc }` and every `MARK` frame as
  `{ stream, idx, ts, utc }`, so the viewer needs no extra file scan.
- Per-frame `utc`, `dio_inputs` and `state_bits` are parsed by
  `readFrameHeader()`; the index currently keeps `utc` and drops the other two.

**Still needed**

- Record parsers for spec §7: the 692-byte `overobdata` array (type 1) and the
  `{ int32 index, int32 size, bytes }` update stream (type 2), including the
  56-byte `shapeobdata` boxes, UTF-16LE text, embedded images and the GPS
  triple.
- Widen the index to retain `dio_inputs` and `state_bits` per video frame — two
  extra typed arrays — so overlay draw conditions (`stateflags`, `dio`) can be
  evaluated.
- A panel UI: a per-frame inspector, a timeline of marks and discontinuities, and
  a file-level summary (codecs, streams, recording window, mask geometry).
- Optional overlay rendering on the video surface (bounding boxes and text drawn
  from type-2 records), which shares the `Renderer` transform so it stays correct
  under rotation and, later, zoom.

---

## Cross-cutting items not yet addressed

- **Playback speed.** The clock (`MediaClock.rate`) already has the field and the
  presentation loop is rate-agnostic; audio would need resampling or muting
  above/below 1×, which is what the reference Blue Iris player does.
- **Workers.** Indexing and thumbnailing want a worker, but `new Worker()` is
  blocked on `file://`. Any worker use must be feature-detected with an inline
  fallback so the double-click-the-HTML deployment keeps working.
- **Very large files.** The current design scans the whole file once on open. A
  multi-gigabyte clip on a network share would want the spec's
  interpolate-and-search seeking (§9.5) instead; the index structure could be
  made sparse without changing the player above it.
