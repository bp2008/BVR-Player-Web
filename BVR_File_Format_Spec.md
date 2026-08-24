# Blue Iris BVR File Format Specification

**Version:** 1.0 (derived from the Blue Iris 5.x recorder and `CBVR` player implementations)
**Status:** Informational — describes the on-disk format as written and read by shipping Blue Iris.

This document describes the Blue Iris Video Recording (`.bvr`) container format in enough detail for a third party to write a parser or a standalone player. Sections 2–10 are written from the point of view of a *reader*; §11 records what the Blue Iris recorder guarantees so that readers know which invariants they may rely on and third-party writers can produce native-equivalent files.

---

## 1. Overview

A BVR file is a flat, append-only sequence of **frames**. There is no global index, no trailer, and no table of contents. Every frame begins with a fixed 16-byte header whose first four bytes are the ASCII signature `BLUE`, optionally followed by a small extension block ("post bytes"), followed by a variable-length payload.

```
+------------------+------------------+------------------+-----
|  Frame 0         |  Frame 1         |  Frame 2         | ...
|  (file header)   |  (video/audio/   |                  |
|                  |   metadata)      |                  |
+------------------+------------------+------------------+-----
```

The **first frame** in the file is special: its payload carries the stream configuration (audio format, video format(s), area-of-interest rectangles and optional motion-mask data). Every subsequent frame is a compressed video access unit, a compressed audio packet, or a metadata record.

Key properties:

| Property | Value |
|---|---|
| Byte order | Little-endian throughout (native x86/x64 Windows layout) |
| Structure packing | Natural alignment. `WAVEFORMATEX` is 2-byte packed (18 bytes); every other structure is 4-byte aligned. |
| Signature | `'B' 'L' 'U' 'E'` at offset 0 of every frame |
| Streams | 1 or 2 video elementary streams (main + optional sub), 0 or 1 audio stream, metadata |
| Video codecs | H.264, H.265/HEVC, MJPEG, MPEG-4 Part 2 (identified by FourCC) |
| Audio codecs | PCM, G.711 µ-law, FLAC (identified by `WAVEFORMATEX.wFormatTag`) |
| Timebases | Per-frame relative milliseconds (32-bit) and optional absolute UTC (64-bit, ms) |
| Seeking | Linear scan / signature search; no index. Readers build their own. |
| Extensibility | Header `postbytes` field lets the frame header grow; readers skip unknown post bytes |

The format is deliberately simple so that a recorder can write it with no seeking and a file that is truncated mid-frame (e.g. power loss) remains playable up to the last complete frame.

---

## 2. Frame Header

Every frame starts with this 16-byte structure (`BlueVideoFrame`, "version 1"):

| Offset | Size | Type | Field | Description |
|---|---|---|---|---|
| 0 | 4 | `DWORD` | `ID` | Signature. Must equal the bytes `42 4C 55 45` (`"BLUE"`). As a little-endian `DWORD` this reads as the multi-char constant `'EULB'` = `0x45554C42`. |
| 4 | 2 | `WORD` | `flags` | Bit flags; see §3. |
| 6 | 2 | `WORD` | `postbytes` | Number of extension bytes that follow this 16-byte header and precede the payload. Currently `0` (legacy) or `16`. |
| 8 | 4 | `DWORD` | `timestamp` | For the file-header frame: frame interval in **microseconds**. For all other frames: presentation time in **milliseconds**, relative to the start of the recording. |
| 12 | 4 | `DWORD` | `datasize` | Payload length in bytes. |

Immediately after the 16-byte header come `postbytes` bytes of extension, then `datasize` bytes of payload.

**Total frame size on disk = 16 + postbytes + datasize.**

### 2.1 Post-byte extension (`postbytes == 16`)

Modern Blue Iris writes `postbytes = 16` on every frame. The 16 extension bytes are laid out as (`BlueVideoFrame2`):

| Offset (from frame start) | Size | Type | Field | Description |
|---|---|---|---|---|
| 16 | 8 | `ULONGLONG` | `utc` | Absolute wall-clock time: `time_t * 1000 + milliseconds` (i.e. Unix epoch milliseconds, UTC). |
| 24 | 4 | `DWORD` | `dio_inputs` | Bitmask of global digital I/O input states at the time of the frame. |
| 28 | 4 | `DWORD` / `float` | `state_bits` **or** `audio_power` | Union. For **video** frames: camera state bits (see §2.2). For **audio** frames: a `float` in `[0.0, 1.0]` giving the peak audio level of the packet (§6). |

### 2.2 `state_bits` (video frames)

| Bit | Mask | Name | Meaning |
|---|---|---|---|
| 0 | `0x1` | Triggered | Camera was in the triggered state when this frame was captured. |
| 1 | `0x2` | Overlay | Live display of overlays was enabled on the camera at the time of recording. |
| 2 | `0x4` | Recording | A clip was actively being recorded at the time of this frame. |
| 3 | `0x8` | Alerted | Camera was in the alerted state. |

Other bits are reserved and currently zero. These are a per-frame snapshot of camera state; their only consumer is overlay rendering, where an object's `stateflags` (§7.1) holds the matching **"Require …"** options from the overlay editor — *Require live display of overlay at the time of recording*, *Require triggered*, *Require alerted*, *Require recording* — and the object is drawn only when every required bit is set on the current frame. A video-only player can ignore the field.

### 2.3 Handling other `postbytes` values

Readers MUST use `postbytes` to locate the payload and MUST NOT assume it is 16:

* `postbytes == 0` — legacy files. No UTC is available; treat `utc` as 0 and rely on `timestamp` only.
* `postbytes == 16` — current format, interpret as §2.1.
* Any other value — skip `postbytes` bytes to reach the payload. If `postbytes > 16`, the first 16 bytes MAY be interpreted as §2.1 (Blue Iris itself only reads the first 16 and then seeks forward by `postbytes - 16`). If `postbytes < 16` and `> 0`, treat the UTC/DIO/state fields as absent.

The reference implementation reads a full 32-byte `BlueVideoFrame2` unconditionally and then adjusts the file pointer by `postbytes - 16`. A reader that reads exactly 16 header bytes and then `postbytes` extension bytes is equivalent and more robust near end-of-file.

---

## 3. Frame Flags

`flags` is a 16-bit field. Bits 0–7 classify the frame; bits 8–15 carry a small integer whose meaning depends on frame type.

| Bit | Mask | Name | Meaning |
|---|---|---|---|
| 0 | `0x0001` | `ISKEY` | Video frame is a key frame (IDR / I-frame / independently decodable). Decoding MUST begin at a frame with this bit set. |
| 1 | `0x0002` | `ISAUDIO` | Frame payload is a compressed audio packet. |
| 2 | `0x0004` | `ISMETADATA` | Frame payload is a metadata record (see §7). |
| 3 | `0x0008` | `ISDISCONTINUITY` | First frame of a recording segment (start of file, or a restart after a gap/reconnect/resume). Time may have jumped before this frame; motion/state derived from prior frames should be reset. Decoders do not need to be reset — the frame is a key frame (§5). |
| 4 | `0x0010` | `SUBSTREAM` | On the file header: a sub-stream `BITMAPINFOHEADER` is present. On a video frame: this frame belongs to the **sub** (low-resolution) stream rather than the main stream. |
| 5 | `0x0020` | `ISHEADER` | Frame is a stream configuration/header frame. Skip during playback. |
| 6 | `0x0040` | `MARK` | A user/system "mark" (bookmark) was placed on this frame. Playback-neutral. |
| 7 | `0x0080` | `MAINAVAILABLE` | Dual-stream recording. On the file header (together with `SUBSTREAM`): the file was recorded in *switching* mode (see §5.3). On a sub-stream video frame: a main-stream frame with the same timestamp also exists. |
| 8–11 | `0x0F00` | **Rotation / orientation** (file header only) | See §3.1. |
| 8–15 | `0xFF00` | **Metadata subtype** (metadata frames only) | `flags >> 8` selects the metadata record type; see §7. |
| 12 | `0x1000` | `AI` | Reserved (defined as "scanned by AI" but not currently written). |

`STREAMFLAGS` is defined as `ISAUDIO | ISMETADATA | SUBSTREAM` (`0x0016`). A video frame's stream identity is `flags & STREAMFLAGS`: `0` = main stream, `SUBSTREAM` = sub stream.

> **Note:** `BLUEVIDEOFRAME_ENCODE (1<<17)` exists in the header file but cannot fit in the 16-bit on-disk field; it is an in-memory-only flag and never appears in files.

### 3.1 Rotation bits (file header frame)

On the first (header) frame, `flags >> 8` carries the camera's orientation settings, written by the recorder as `(rotate | (fliph ? 4 : 0)) << 8`:

| Bits | Mask (in `flags`) | Name | Meaning |
|---|---|---|---|
| 8–9 | `0x0300` | rotation | 2-bit value: `0` = none, `1` = 90°, `2` = 180°, `3` = 270° (clockwise). The header defines `ROTATE90 = 0x0100`, `ROTATE180 = 0x0200`, `ROTATE270 = 0x0300`. |
| 10 | `0x0400` | `FLIPH` | Mirror horizontally |
| 11 | `0x0800` | `360` | Reserved (defined for 360°/fisheye sources but not currently written). |

**These bits are written only when Blue Iris is re-encoding the video** (transcoding to its own encoder). In direct-to-disc recording they are always 0 and the video is stored exactly as delivered by the camera. When set, the reference player applies the rotation/flip at display time; a minimal player may ignore them and display frames as encoded.

---

## 4. File Header Frame (Frame 0)

The file MUST begin with a frame whose signature is `BLUE`. Its fields are interpreted as follows:

| Field | Meaning in header frame |
|---|---|
| `flags` | `SUBSTREAM` bit → a second `BITMAPINFOHEADER` (sub stream) follows the main one. `MAINAVAILABLE` + `SUBSTREAM` → switching-mode dual-stream file (§5.3). Bits 8–10 → rotation/flip (§3.1). `ISHEADER` is always set. |
| `postbytes` | Always 16 in files written by Blue Iris. The `utc` post-byte is the **recording start time**: the UTC of the first queued video frame, or wall-clock time at file creation if none was queued. The reference reader ignores it and takes the start from the first video frame; the two normally agree within a frame interval. `dio_inputs`/`state_bits` are zero. |
| `timestamp` | Nominal frame **interval in microseconds**. Nominal FPS = `1,000,000 / timestamp`. Informational only; real frame timing comes from per-frame timestamps. |
| `datasize` | Length of the configuration payload described below. |

### 4.1 Header payload layout

The payload is a concatenation of the following, in order:

```
WAVEFORMATEX            wfx            (18 bytes)
BYTE[wfx.cbSize]        audio_extradata  (only if wfx.wFormatTag > WAVE_FORMAT_PCM and wfx.cbSize > 0)
BITMAPINFOHEADER        bmih_main      (40 bytes)
BITMAPINFOHEADER        bmih_sub       (40 bytes, only if flags & SUBSTREAM)
RECT                    aoi[2]         (32 bytes; always written by Blue Iris >= 5.8.5)
[mask block]                           (only if a motion mask is defined)
```

Readers MUST compute `extra = datasize - 18 - cbSize - 40 - (sub ? 40 : 0)` and, if `extra > 0`, parse the extra block per §4.4. Files from before 5.8.5 have `extra == 0`. Any bytes beyond what the reader understands MUST be skipped so that the next frame is located at `16 + postbytes + datasize` from the start of the header frame.

The `SUBSTREAM` flag is set on the header when the sub-stream `BITMAPINFOHEADER` has a non-zero `biCompression`.

### 4.2 `WAVEFORMATEX` (audio format)

Standard Windows structure, packed to 18 bytes:

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 2 | `wFormatTag` | `1` = `WAVE_FORMAT_PCM`, `7` = `WAVE_FORMAT_MULAW` (G.711 µ-law), `0xF1AC` = `WAVE_FORMAT_FLAC`. Other values with `cbSize > 0` are treated as µ-law by the reference player. `0` means **no audio stream**. |
| 2 | 2 | `nChannels` | 1 or 2 |
| 4 | 4 | `nSamplesPerSec` | e.g. 8000, 16000, 44100, 48000 |
| 8 | 4 | `nAvgBytesPerSec` | |
| 12 | 2 | `nBlockAlign` | bytes per sample frame |
| 14 | 2 | `wBitsPerSample` | typically 16 |
| 16 | 2 | `cbSize` | Length of codec-specific extradata immediately following. **Only meaningful when `wFormatTag > WAVE_FORMAT_PCM`.** For PCM, readers must treat `cbSize` as 0 regardless of the stored value. |

If `wFormatTag > 1` and `cbSize > 0`, `cbSize` bytes of codec extradata follow. This is the encoder's `extradata` written verbatim (for FLAC, the `STREAMINFO` block). The writer only emits it when it is running its own audio encoder; the reader nonetheless trusts `cbSize`, so a writer that stores `cbSize > 0` MUST write those bytes.

A file has audio if `nSamplesPerSec * nBlockAlign != 0`.

### 4.3 `BITMAPINFOHEADER` (video format)

Standard 40-byte Windows structure. Relevant fields:

| Field | Notes |
|---|---|
| `biSize` | 40 |
| `biWidth` | Coded width in pixels |
| `biHeight` | Coded height. May be negative (top-down DIB convention); use `abs(biHeight)`. |
| `biCompression` | FourCC identifying the codec (§5.1) |

Other fields (`biPlanes`, `biBitCount`, `biSizeImage`, etc.) should be ignored.

If `SUBSTREAM` is set, a second `BITMAPINFOHEADER` for the sub stream follows the main one. If `SUBSTREAM` is *not* set but the first video frame encountered carries the `SUBSTREAM` flag, the file was recorded with only the sub stream (a recorder edge case); readers SHOULD treat `bmih_sub = bmih_main` and select the sub stream.

### 4.4 Extra block (Blue Iris ≥ 5.8.5)

If present, parse sequentially from the remaining `extra` bytes:

1. **Area-of-interest rectangles** — if `extra >= 32`: two `RECT` structures (4 × `LONG` each: `left, top, right, bottom`), `aoi[0]` for the main stream and `aoi[1]` for the sub stream, in that stream's pixel coordinates. Subtract 32 from `extra`. Blue Iris always writes these (they may be empty rectangles).

2. **Motion mask** — present when the camera has a motion-detection mask defined; if `extra >= 16`: read four `DWORD`s `x[0..3]`:

   | Index | Meaning |
   |---|---|
   | `x[0]` | `0x1200 | show_motion_flags`. Valid if `(x[0] & 0xFF00) == 0x1200`. The low byte is the camera's "show motion" option set at the time of recording: `0x01` highlight motion, `0x02` show object rectangles, `0x04` blackout masked areas, `0x08` highlight/rectangles only when triggered, `0x10` obscure (blur) masked areas. Bits `0x04` and `0x10` are what make the mask relevant to the video content; the others describe live-view rendering. |
   | `x[1]` | Total block length **including** `x[2]` and `x[3]` (i.e. `8 + mask_bytes`). The writer adds `8 + x[1]` to the header `datasize` for this block. |
   | `x[2]` | Mask width (cells) |
   | `x[3]` | Mask height (cells) |

   Then `x[1] - 8` bytes of packed mask bits follow (one bit per cell, row-major). Subtract `8 + x[1]` from `extra`. If the tag check fails, still skip `8 + x[1]` bytes.

   The mask bits are the camera's motion-detection mask grid (`x[2]` × `x[3]` cells over the frame). When `x[0] & 0x04` (blackout) or `x[0] & 0x10` (obscure) is set, masked cells were *already* blacked out or blurred in the encoded video, so a player does not need to apply the mask. It is stored so that editing/export tools can preserve it and so the source geometry of the privacy region is known.

Any remaining bytes are reserved for future use and MUST be skipped.

---

## 5. Video Frames

A **video frame** is any frame with none of `ISAUDIO`, `ISMETADATA`, `ISHEADER` set.

* `timestamp` — presentation time in milliseconds relative to recording start, computed by the writer as `timescale × (capture_ms − segment_start_ms + toffset)`, clamped to 0 if negative (main/sub streams can start a frame apart), plus the resume offset of §11.2. `timescale` is 1.0 for normal recording and < 1.0 for time-lapse, so this is *playback* time, not wall time — use `utc` for wall time. Monotonically non-decreasing within a stream; may repeat. **Not guaranteed to start at 0** after a resume. Wraps at 2³² ms (~49.7 days) — not a practical concern.
* `utc` — absolute time in Unix epoch milliseconds (if `postbytes == 16`). The writer rejects frames with `utc < 0x14000000000` (≈ 2013-07), so any lower non-zero value indicates corruption.
* `flags & SUBSTREAM` — which stream this frame belongs to.
* `flags & ISKEY` — key frame. When Blue Iris re-encodes (rather than writing the camera's stream directly), `MARK` and `ISDISCONTINUITY` force an I-frame, so those frames are also key frames. On direct-to-disc recording the writer discards frames at the start of each segment until the first key frame arrives, so the first frame of every segment is a key frame regardless.
* `flags & ISDISCONTINUITY` — set by the writer on the first frame of each recording segment (the frame whose capture time equals the segment's `tcreate`). It marks "time may have jumped before this frame", not "decoder state is invalid".
* `flags & MARK` — set when the caller asked for a mark (e.g. manual/alert bookmark) on that frame.
* `dio_inputs`, `state_bits` — auxiliary state snapshot (§2.2); used only for conditional overlay rendering (§7.1).

The payload is a single compressed access unit in the codec's native elementary-stream form. No length prefix, no container framing.

### 5.1 Codec identification and payload format

| `biCompression` FourCC | Bytes on disk | Codec | Payload format |
|---|---|---|---|
| `'H264'` | `48 32 36 34` | H.264 / AVC | Annex-B byte stream (`00 00 01` / `00 00 00 01` start codes). Key frames carry SPS/PPS (and optional SEI) in-band before the IDR slice. |
| `'H265'` | `48 32 36 35` | H.265 / HEVC | Annex-B byte stream. Key frames carry VPS/SPS/PPS in-band before the IRAP slice. |
| `'MJPG'` | `4D 4A 50 47` | Motion JPEG | One complete JPEG image (`FF D8 … FF D9`) per frame. Every frame is a key frame. |
| anything else | — | MPEG-4 Part 2 | Raw MPEG-4 visual elementary stream. (Reference player default for unrecognised FourCCs.) |

Note the multi-character constants in the source (`'462H'`, `'562H'`, `'GPJM'`) are the little-endian `DWORD` readings of the FourCC bytes `H264`, `H265`, `MJPG`.

### 5.2 Decoder initialisation (extradata)

Because parameter sets are carried in-band, a player can initialise a decoder from the first key frame alone. The reference implementation derives `extradata` for FFmpeg by scanning the key-frame payload for the first NAL start code (`00 00 01`) whose NAL type is **not** a parameter set/SEI, and using everything before that point as extradata:

* **H.264:** keep leading NALs of type 6 (SEI), 7 (SPS), 8 (PPS); stop at the first NAL whose `(byte & 0x1F)` is anything else.
* **H.265:** keep leading NALs whose first header byte is `0x40` (VPS), `0x42` (SPS), `0x44` (PPS); stop at the first other NAL.

Passing the full Annex-B key frame to any standard decoder (FFmpeg, Media Foundation, hardware) without separately extracting extradata also works.

### 5.3 Dual-stream files

Blue Iris can record two elementary streams of the same camera into one file:

**Independent dual-stream (`SUBSTREAM` set, `MAINAVAILABLE` clear on header):**
Both streams are complete and independently playable. Main-stream frames have `flags & STREAMFLAGS == 0`; sub-stream frames have `SUBSTREAM` set. A player selects one stream and filters frames by `(flags & STREAMFLAGS) == selected`. Main and sub frames interleave in the file in recording order.

**Switching mode (`SUBSTREAM` and `MAINAVAILABLE` both set on header):**
Set by the recorder when the camera's record mode is one of the dual-stream "sub continuous + main when triggered" options. The sub stream is recorded continuously; the main stream is recorded only during triggered/alert periods. Sub-stream frames recorded while a main frame also exists carry `MAINAVAILABLE`. To play "best available quality":

* Prefer main-stream frames (`STREAMFLAGS == 0`) when present.
* Use sub-stream frames only where `MAINAVAILABLE` is **not** set.
* Expect resolution changes at the switch points; the first frame after a switch is always a key frame.

Each stream has its own `BITMAPINFOHEADER` and its own AOI rectangle.

### 5.4 Decode order and B-frames

Frames are stored in decode order (which for typical IP-camera streams equals presentation order — no B-frames). Timestamps are presentation times. A player should not reorder.

---

## 6. Audio Frames

A frame with `ISAUDIO` set contains one compressed audio packet.

* `timestamp` — milliseconds, same timebase as video (with the same resume offset as video, §11.2), but **derived from the sample count, not the capture clock**: `timestamp = samples_written_so_far × 1000 / nSamplesPerSec`. The writer aligns the audio origin to the first video frame by inserting silence (if audio started late) or trimming samples (if it started early), so audio time 0 = video segment start. Time-lapse scaling is not applied to audio. For PCM/µ-law passthrough this is the start time of the packet. For encoded audio (FLAC) it is the timestamp of the **last** PCM chunk fed to the encoder before the packet was emitted, i.e. close to the *end* of the packet's content rather than the start. **Legacy note:** very old files store `timestamp = 0` on every audio packet; readers should detect `0` on the second and later audio packets and free-run audio from the first video frame's time.
* `utc` (post bytes) — **always 0** on audio frames written by Blue Iris. Readers MUST NOT rely on it and MUST NOT treat a zero value as an error.
* `dio_inputs` (post bytes) — global DIO inputs at write time (not tied to the packet).
* `audio_power` (post bytes, `float`) — peak level of this packet in `[0, 1]`, computed by the writer from the left channel only as:

  ```
  dc       = max_sample - (max_sample - min_sample) / 2          (midpoint offset)
  peak_dB  = 20 * log10( (max(|max_sample|, |min_sample|) - dc) / 32768 )
  power    = 0                            if peak_dB <= -48        (≤ -48 dBFS)
           = (peak_dB + 48) / 48          otherwise                (1.0 = 0 dBFS)
  (16-bit samples only; left channel only for stereo)
  ```

  Only computed when the writer is encoding audio itself and samples are 16-bit; otherwise 0. Useful for drawing a waveform/activity bar without decoding.
* Payload format by `wFormatTag`:

| `wFormatTag` | Payload |
|---|---|
| `1` (PCM) | Raw interleaved little-endian PCM samples at `wBitsPerSample`/`nChannels`. |
| `7` (µ-law) or other with `cbSize` | G.711 µ-law bytes, 1 byte/sample. |
| `0xF1AC` (FLAC) | One FLAC frame (no container). Extradata from the file header must be given to the decoder first. |

Typical packet duration is 50–70 ms for FLAC and ~200 ms for PCM/µ-law, but readers MUST NOT assume a fixed duration; derive it from the decoded sample count.

### 6.1 A/V synchronisation and interleaving

Audio and video share the millisecond timebase. The writer **queues** audio packets and flushes them just before writing each video frame: every queued packet with `audio.timestamp < video.timestamp + 200` is written ahead of that video frame. Consequently:

* Because the flush threshold is `video.timestamp + 200`, an audio packet may be placed in the file ahead of a video frame that is up to 200 ms *older* than it. Interleaving is therefore approximate; readers must order by `timestamp`, not by file position.
* An audio packet for time *t* reaches the disk only when a video frame with timestamp > *t* − 200 ms is written, so audio trails video on disk by roughly one video frame during live recording.
* Within the audio stream, packets are in monotonic `timestamp` order.
* Audio is never written after the last video frame; on close, queued audio is discarded.

The reference player tolerates the first audio packet arriving up to 1 s after the corresponding video time and pads with silence to align. A simple player can present each audio packet at `timestamp` and drop packets that are more than a few seconds stale after a seek.

---

## 7. Metadata Frames

A frame with `ISMETADATA` set carries metadata. The record type is `flags >> 8`:

| `flags >> 8` | Type | Description |
|---|---|---|
| `1` | Overlay object definitions | Appears once, near the start of the file, after the header frame. Defines the set of on-screen overlay objects (text/clock/graphic/shape layers) used by later type-2 records. |
| `2` | Overlay object updates | Appears throughout the file. Updates the *content* of one or more previously defined objects (new text, new shape list, new image, GPS position). |

**Placement guarantees (files written by Blue Iris):**

* The type-1 record, if any, is the **second frame in the file**, immediately after the header frame. Its `timestamp` and `utc` are 0; `dio_inputs` is set.
* A type-2 record is written **immediately after a video frame**, never between audio packets, and carries the same `utc` and `timestamp` as that video frame.
* The **first video frame is always followed by a type-2 record** containing the initial content of every object (and GPS, if enabled), so a player can seek to the first key frame and have a complete overlay state.
* Thereafter a type-2 record follows a video frame when any object's content changed since the last write, and after every `ISKEY` or `ISDISCONTINUITY` frame for objects that are "volatile" (have changed at least once in this session) and for all shape objects. Text-only overlays that never change may therefore appear only in the first type-2 record.

Metadata records apply from their timestamp forward.

### 7.1 Type 1 — Object definitions

Payload is an array of fixed-size **692-byte** `overobdata` structures. Each defines one overlay object, assigned index 0, 1, 2, … in file order. The writer supports at most 63 objects (indices 0–62; bit 63 of its change mask is reserved for GPS). The number of objects is `datasize / 692`.

Layout (little-endian, `TCHAR` = UTF-16LE code unit, 4-byte alignment):

| Offset | Size | Type | Field | Description |
|---|---|---|---|---|
| 0 | 16 | `RECT` | `r` | Placement rectangle `left, top, right, bottom` (4 × `int32`) in video pixels of the stream it was configured for. If `right <= left`, treat width as 100. |
| 16 | 520 | `TCHAR[260]` | `path` | Configured source: macro/text template for text objects, image path for graphic objects. Null-terminated. Informational only — rendered content arrives via type-2 records. |
| 536 | 80 | `TCHAR[40]` | `font` | Font face name, null-terminated (only the first 32 code units are meaningful). |
| 616 | 4 | `int32` | `nlines` | Number of text lines. |
| 620 | 4 | `int32` | `stateflags` | "Require …" conditions, same bit layout as §2.2. Draw only when `(video.state_bits & stateflags) == stateflags`. `0` = no conditions. |
| 624 | 32 | `BYTE[32]` | `extra` | Reserved, zero. |
| 656 | 4 | `uint32` | `dio` | Draw only when `(video.dio_inputs & dio) != 0`. `0` = always. |
| 660 | 4 | `BYTE[4]` | `dio_x` | Reserved, zero. The reader honours `dio` only if `dio_x[2] == 0`. |
| 664 | 4 | `int32` | `type` | `0` = text, `1` = bitmap/graphic, `2` = shapes. |
| 668 | 4 | `uint32` | `weight` | Font weight (`FW_*`). |
| 672 | 4 | `COLORREF` | `color` | Foreground `0x00BBGGRR`. |
| 676 | 4 | `COLORREF` | `bkcolor` | Background `0x00BBGGRR`. |
| 680 | 1 | `BYTE` | `alpha` | Opacity 0–100. |
| 681 | 3 | — | (pad) | |
| 684 | 4 | union | `transparent` / `align` | Bitmaps: `BOOL transparent`. Text: low byte is `char align`: `0` centre, `-1` (`0xFF`) left, `1` right. |
| 688 | 4 | union | `shadow` / `constrain` | Text: `BOOL shadow`. Bitmaps: `BOOL constrain` (keep aspect). |

Total: **692 bytes**.

Readers that do not render overlays MAY skip type-1 records entirely; a player that only displays video can ignore all metadata.

### 7.2 Type 2 — Object updates

Payload is a sequence of records, each:

```
int32  i       // object index into the type-1 list, or -1 for GPS
int32  size    // length of data that follows
BYTE   data[size]
```

Parse until fewer than 8 bytes remain. When a GPS record is present it is written first, followed by object records in ascending index order. Interpretation of `data` depends on `i` and the referenced object's `type`:

| `i` | Object type | `data` |
|---|---|---|
| `-1` | (GPS) | If `size == 24`: three `double`s — altitude, latitude, longitude. |
| `>= 0` | `2` (shape) | Array of **56-byte** `shapeobdata` structures (`size / 56` of them; see below). `size == 0` clears the shape list. |
| `>= 0` | `1` (graphic) | An encoded image file (PNG/JPEG/GIF/BMP — anything GDI+ `Bitmap::FromStream` accepts). Animated GIFs are supported; frame delay is clamped to 200 ms. |
| `>= 0` | other (text) | Null-terminated UTF-16LE string. The writer emits `(strlen + 1) × 2` bytes, at most 2048; the reference reader ignores records larger than 2046 bytes. |

Records referencing an unknown object index MUST be skipped using `size`.

`shapeobdata` layout (56 bytes):

| Offset | Size | Type | Field | Description |
|---|---|---|---|---|
| 0 | 16 | `RECT` | `rect` | Shape rectangle in video pixels (`left, top, right, bottom`). |
| 16 | 4 | `uint32` | `flags` | Bit 0 = this object is currently *triggering* (drawn in the "triggered" style, typically a highlighted box). Other bits reserved, zero. |
| 20 | 4 | `COLORREF` | `color` | Outline colour `0x00BBGGRR`. |
| 24 | 32 | `char[32]` | `label` | ASCII/ANSI label, null-terminated (e.g. AI object class). |

Shape objects are how motion-detection and AI bounding boxes are recorded; they are rewritten on every key frame (§7 placement guarantees) so seeking to any key frame restores the box set.

---

## 8. Time Model

Two clocks exist:

| Clock | Field | Units | Origin | Availability |
|---|---|---|---|---|
| Relative | `timestamp` | ms | Start of the *first* recording session into this file (≈ 0 for the first session; continues across resumes, §11.2) | Always |
| Absolute | `utc` | ms | Unix epoch, UTC | `postbytes == 16` |

The header frame's `timestamp` (frame interval in µs) is the unit used to align resume offsets; the writer does not otherwise rely on it.

For any two video frames *a*, *b* in the same file, `utc_b - utc_a ≈ timestamp_b - timestamp_a` for normal recordings, except across `ISDISCONTINUITY` gaps, where the UTC clock jumps and the relative clock may or may not. For time-lapse recordings (`timescale < 1`) the relative clock runs slower than UTC by that factor.

Conversion between the two within a file is linear interpolation between the first and last video frames:

```
msec(utc) = firstmsec + (utc - firstutc) * (lastmsec - firstmsec) / (lastutc - firstutc)
```

The reference player prefers `utc` for seeking when it is available and non-zero, and falls back to `timestamp`.

---

## 9. Reading Algorithm

### 9.1 Open

1. Read 16 bytes; verify `ID == "BLUE"`. Read `postbytes` extension bytes.
2. `fps = 1e6 / timestamp`; `rotate = flags >> 8`; note `SUBSTREAM` / `MAINAVAILABLE`.
3. Parse the payload per §4.
4. Position at `16 + postbytes + datasize`.

### 9.2 Locate first video frame and metadata definitions

Scan forward frame-by-frame (the reference player gives up after 300 frames):

* If `ISMETADATA` with subtype 1 → load object definitions.
* If `ISMETADATA` with subtype 2 → apply updates.
* If `ISAUDIO` → note audio exists.
* Otherwise it is a video frame: record its offset, `timestamp`, and `utc` as the start of the chosen stream (first frame of either stream is the file's start).

Stop once you have seen a frame for each stream you care about.

### 9.3 Locate last frame

Because there is no index, read backwards from EOF in 64 KB windows searching for the byte sequence `B L U E`. For each candidate, parse the header and accept it if:

* it is not `ISAUDIO` / `ISMETADATA`,
* it belongs to the selected stream (or either stream in switching mode), and
* `offset + 16 + postbytes + datasize <= filesize` (frame is complete).

Its `timestamp`/`utc` give the file's duration. (This also tolerates a truncated final frame.) Overlap windows by a few bytes so a signature spanning a window boundary is not missed.

> Caveat: `BLUE` may appear inside compressed payload data. The completeness check above rejects most false positives; a stricter reader can additionally verify that the *next* frame (at `offset + size`) also starts with `BLUE` or is EOF.

### 9.4 Sequential playback

```
pos = first_video_frame_offset
loop:
    read header at pos; if ID != "BLUE" -> stop (EOF or corruption)
    payload_pos = pos + 16 + postbytes
    if ISMETADATA:  apply (§7)
    elif ISAUDIO:   decode/queue audio at timestamp
    elif ISHEADER:  skip
    elif (flags & STREAMFLAGS) == selected_stream (or switching rule §5.3):
                    decode video, present at timestamp
    pos = payload_pos + datasize
```

Decoding MUST start at an `ISKEY` frame. After a seek, walk backward (or re-scan forward from a known point) to the nearest preceding key frame of the selected stream, feed all frames from there, and discard decoded pictures with `timestamp < target`.

### 9.5 Seeking

With no index, the reference player:

1. Estimates a byte offset by linear interpolation of the target time between the known (offset, time) pairs it has already visited (initially just first and last frame; it inserts a new pair every ≥5 s of media seen).
2. Reads a 256 KB window at that offset and scans for `BLUE`.
3. Walks frames forward or backward from the hit until it brackets the target time, remembering the last key frame seen.
4. Decodes from that key frame.

A third-party player may instead do a one-time full scan on open to build a complete (offset, timestamp, utc, flags) table; for typical files (tens of MB to a few GB, one header read per frame) this takes well under a second on local storage and makes seeking trivial. For very large files or network shares, the interpolate-and-search approach avoids reading the whole file.

### 9.6 Reference playback model (how Blue Iris drives the reader)

The shipping player does not run a demux-and-present loop. Instead it is **clock-driven and seek-based**, and the format's design (in-band parameter sets, self-describing frames, no index) is what makes this cheap:

1. A periodic 33 ms multimedia timer advances a virtual play position: `playpos += 33 * playspeed / 100`, where `playspeed` is a percentage (100 = real time, 200 = 2×, −100 = reverse at real time, etc.).
2. Each tick calls `Seek(playpos)`. The reader resolves that time to the nearest video frame of the selected stream (walking from the last decoded position, or key-frame search if the jump is large), decodes forward as needed, and signals an event when a picture is ready.
3. The consumer wakes on that event, reads `nowmsec`/`nowutc` (the time of the frame actually decoded), and emits it only if `floor((nowmsec − base) × 100 / playspeed / 33.333)` differs from the last emitted frame index — i.e. output is **capped at 30 fps** regardless of the source rate, and frames are dropped, never duplicated.
4. End of clip is detected when `playpos > lastframemsec + 50` (or `< 0` in reverse). The player either signals EOF to the network encoder or loops by seeking to 0.
5. **Audio** is served only at `playspeed == 100`. The reader decodes audio packets into a PCM ring buffer as it passes them; the consumer pulls 200 ms chunks (`nAvgBytesPerSec / 5`) keeping roughly 400 ms ahead of the video position, and substitutes silence if the ring underruns. Any other speed is silent.
6. Slider/UI position is reported as `nowmsec / 33` "frames" and as `GetPosition()` (byte-offset fraction of the file); neither is a true frame count, since the file has no frame index.

A third-party player is free to use a conventional pull/present loop instead; nothing in the file format depends on this model. But it explains why every key frame is self-contained, why `timestamp` is the only thing needed to seek, and why `lastframemsec` is found by scanning backward from EOF rather than from a trailer.

---

## 10. Robustness Requirements for Readers

* **Truncated files.** The last frame may be incomplete. A reader MUST check `offset + 16 + postbytes + datasize <= filesize` before using a frame.
* **Corruption.** If `ID != "BLUE"` where a frame is expected, resynchronise by scanning forward for the signature and validating as in §9.3.
* **Unknown flags / post bytes / metadata subtypes / extra header bytes.** MUST be ignored (skipped by size), never treated as errors.
* **Missing key frame.** Frames preceding the first `ISKEY` of a stream cannot be decoded; skip them.
* **Resolution changes.** In switching-mode files the decoder must be reinitialised (or be resolution-agnostic) when the selected frame's stream changes. Parameter sets are in-band on every key frame.
* **Negative `biHeight`.** Use the absolute value.

---

## 11. Writer Rules (as implemented by Blue Iris)

This section records what the reference recorder actually guarantees, for writers who want their files to be indistinguishable from native ones, and for readers who want to know which invariants they can rely on.

### 11.1 Frame emission

* Every frame is written as a 32-byte `BlueVideoFrame2` (`postbytes = 16`) followed by `datasize` bytes. No padding between frames.
* **Video:** `flags` = the camera stream's flags (`ISKEY`, `SUBSTREAM`, `MAINAVAILABLE`) OR'd with `ISDISCONTINUITY` (first frame of segment) and `MARK` (on request), truncated to 16 bits (so `ENCODE` is dropped); `timestamp` per §5; `utc` = capture UTC; `dio_inputs`, `state_bits` = snapshot at capture.
* **Audio:** written from a queue just before the next video frame (§6.1). `flags = ISAUDIO` only; `utc = 0`; `dio_inputs` = global inputs at write time; `audio_power` per §6.
* **Sub-stream frames are only ever written to BVR.** The AVI/MP4 paths silently drop them.
* **Metadata:** per §7 placement guarantees.
* When two streams are being recorded live, the writer holds each frame until the other stream has advanced ~2 s past it, so that main and sub frames are emitted in timestamp order despite arriving on different network paths.
* If an encoder introduces delay, the writer keeps a FIFO of (utc, flags, timestamp) so each emitted packet carries the metadata of its *source* frame, not the frame that caused it to be emitted.

### 11.2 Resuming (appending to an existing file)

When Blue Iris reopens an existing `.bvr` for continued recording:

1. If the file is **shorter than 64 KB** it is truncated to zero and rewritten from scratch.
2. Otherwise the existing header frame, `WAVEFORMATEX`, `BITMAPINFOHEADER`(s), AOI rectangles, and (if present) the type-1 object list are read and compared **byte-for-byte** against the current configuration. Any mismatch (including the header `flags`) aborts with `ERROR_MEDIA_CHANGED` — the recorder will not append a differently-configured stream. The header `timestamp` (nominal FPS) is *not* compared.
3. The type-2 record following the first video frame is compared to the current object contents to mark objects volatile (so their first new value is rewritten at the next key frame).
4. The last frame is located by scanning backward from EOF for `BLUE`. The last frame **must end exactly at EOF** (`offset + 16 + postbytes + datasize == filesize`); a truncated tail is treated as `ERROR_BAD_FORMAT` and the append is refused. Readers, by contrast, tolerate a truncated tail (§10).
5. `resume_offset` is set from the last video frame: `n = floor((last.timestamp + 16) * 1000 / interval_us) + 1; resume_offset = n * interval_us / 1000` — i.e. the next nominal frame slot after the last frame. All new `timestamp` values (video and audio) have `resume_offset` added, so the relative clock is continuous and monotonic across sessions.
6. No new header or type-1 record is written; writing continues at the old EOF. The first frame of the new session is a key frame and typically carries `ISDISCONTINUITY`.

A reader therefore sees a resumed file as one continuous recording with a time gap.

### 11.3 File-level invariants a reader may rely on

* Frame 0 is the header (`ISHEADER` set).
* If overlays exist: frame 1 is type-1 metadata; the first video frame is immediately followed by a type-2 record.
* The first video frame of each stream is a key frame with in-band parameter sets.
* `timestamp` is monotonic non-decreasing per stream. `utc` is monotonic on video frames (may be 0 on frames flushed at close) and is always 0 on audio frames.
* Every video `utc` is ≥ `0x14000000000`.
* The file may end mid-frame (crash/power loss); the writer's own resume logic refuses such files, but they are otherwise valid and playable.

---

## 12. Quick Reference

```
Frame:
  0   "BLUE"                 4
  4   flags        WORD      2   bit0 KEY, bit1 AUDIO, bit2 META, bit3 DISC, bit4 SUB,
                                 bit5 HDR, bit6 MARK, bit7 MAINAVAIL, bits8-10 rotate/flip (hdr) or meta-subtype
  6   postbytes    WORD      2   0 or 16
  8   timestamp    DWORD     4   ms (µs frame interval in file header)
 12   datasize     DWORD     4
 16   utc          QWORD     8   (postbytes>=16) unix ms
 24   dio_inputs   DWORD     4   (postbytes>=16)
 28   state_bits   DWORD     4   (postbytes>=16) float audio_power for audio frames
 16+postbytes      payload   datasize

File header payload:
  WAVEFORMATEX(18) [+cbSize extradata if wFormatTag>1]
  BITMAPINFOHEADER(40) main
  [BITMAPINFOHEADER(40) sub  if flags&SUB]
  RECT aoi[2] (32)                          (always, >= 5.8.5)
  [DWORD tag,len,w,h + (len-8) mask bytes   if motion mask; (tag&0xFF00)==0x1200]

Video codec by bmih.biCompression: "H264" | "H265" | "MJPG" | else MPEG-4 pt2
Audio codec by wfx.wFormatTag:     1 PCM | 7 µ-law | 0xF1AC FLAC | 0 none
```

---

## Appendix A — C-style structure definitions

```c
#pragma pack(push, 1)   /* all fields are naturally aligned; pack(1) is safe */

typedef struct {
    uint32_t id;         /* "BLUE" */
    uint16_t flags;
    uint16_t postbytes;  /* 0 or 16 */
    uint32_t timestamp;  /* ms (µs interval in header frame) */
    uint32_t datasize;
} bvr_frame_hdr_t;       /* 16 bytes */

typedef struct {
    uint64_t utc;        /* unix epoch ms */
    uint32_t dio_inputs;
    union {
        uint32_t state_bits;   /* video frames */
        float    audio_power;  /* audio frames, 0..1 */
    };
} bvr_frame_ext_t;       /* 16 bytes, present when postbytes >= 16 */

typedef struct {
    uint16_t wFormatTag, nChannels;
    uint32_t nSamplesPerSec, nAvgBytesPerSec;
    uint16_t nBlockAlign, wBitsPerSample, cbSize;
} bvr_waveformatex_t;    /* 18 bytes */

typedef struct {
    uint32_t biSize; int32_t biWidth, biHeight;
    uint16_t biPlanes, biBitCount;
    uint32_t biCompression, biSizeImage;
    int32_t  biXPelsPerMeter, biYPelsPerMeter;
    uint32_t biClrUsed, biClrImportant;
} bvr_bitmapinfoheader_t; /* 40 bytes */

typedef struct {
    int32_t i;           /* object index or -1 = GPS */
    int32_t size;
    /* uint8_t data[size]; */
} bvr_meta_update_hdr_t; /* 8 bytes */

typedef struct { int32_t left, top, right, bottom; } bvr_rect_t;

typedef struct {                  /* type-1 metadata payload element */
    bvr_rect_t r;                 /*   0 */
    uint16_t   path[260];         /*  16  UTF-16LE */
    uint16_t   font[40];          /* 536  UTF-16LE */
    int32_t    nlines;            /* 616 */
    int32_t    stateflags;        /* 620 */
    uint8_t    extra[32];         /* 624  reserved */
    uint32_t   dio;               /* 656 */
    uint8_t    dio_x[4];          /* 660  reserved */
    int32_t    type;              /* 664  0 text, 1 bitmap, 2 shapes */
    uint32_t   weight;            /* 668 */
    uint32_t   color;             /* 672  COLORREF */
    uint32_t   bkcolor;           /* 676  COLORREF */
    uint8_t    alpha;             /* 680 */
    uint8_t    _pad[3];           /* 681 */
    int32_t    transparent_or_align; /* 684  BOOL / char align in low byte */
    int32_t    shadow_or_constrain;  /* 688  BOOL */
} bvr_overobdata_t;               /* 692 bytes */

typedef struct {                  /* type-2 shape record element */
    bvr_rect_t rect;              /*  0 */
    uint32_t   flags;             /* 16 */
    uint32_t   color;             /* 20  COLORREF */
    char       label[32];         /* 24 */
} bvr_shapeobdata_t;              /* 56 bytes */

#pragma pack(pop)

#define BVR_FLAG_ISKEY           0x0001
#define BVR_FLAG_ISAUDIO         0x0002
#define BVR_FLAG_ISMETADATA      0x0004
#define BVR_FLAG_ISDISCONTINUITY 0x0008
#define BVR_FLAG_SUBSTREAM       0x0010
#define BVR_FLAG_ISHEADER        0x0020
#define BVR_FLAG_MARK            0x0040
#define BVR_FLAG_MAINAVAILABLE   0x0080
#define BVR_FLAG_ROTATE90        0x0100
#define BVR_FLAG_ROTATE180       0x0200
#define BVR_FLAG_FLIPH           0x0400
#define BVR_FLAG_360             0x0800
#define BVR_FLAG_AI              0x1000
#define BVR_FLAG_ROTATE270       (BVR_FLAG_ROTATE90|BVR_FLAG_ROTATE180)
#define BVR_FLAG_STREAMFLAGS     (BVR_FLAG_ISAUDIO|BVR_FLAG_ISMETADATA|BVR_FLAG_SUBSTREAM)

/* state_bits (video frames) / overobdata.stateflags */
#define BVR_STATE_TRIGGERED      0x1
#define BVR_STATE_OVERLAY        0x2
#define BVR_STATE_RECORDING      0x4
#define BVR_STATE_ALERTED        0x8

/* motion-mask tag low byte (header extra block) */
#define BVR_MASK_HIGHLIGHT       0x01
#define BVR_MASK_RECTANGLES      0x02
#define BVR_MASK_BLACKOUT        0x04
#define BVR_MASK_TRIGGERED_ONLY  0x08
#define BVR_MASK_OBSCURE         0x10
#define BVR_MASK_TAG             0x1200
```

## Appendix B — Minimal Python frame walker

```python
import struct

HDR = struct.Struct('<4sHHII')          # id, flags, postbytes, timestamp, datasize
EXT = struct.Struct('<QII')             # utc, dio_inputs, state_bits/audio_power

def walk(path):
    with open(path, 'rb') as f:
        pos = 0
        while True:
            f.seek(pos)
            h = f.read(HDR.size)
            if len(h) < HDR.size:
                return
            sig, flags, post, ts, size = HDR.unpack(h)
            if sig != b'BLUE':
                return                   # corrupt / EOF garbage
            ext = None
            if post >= EXT.size:
                ext = EXT.unpack(f.read(EXT.size))
            payload_pos = pos + HDR.size + post
            yield dict(pos=pos, flags=flags, ts=ts, size=size,
                       utc=ext[0] if ext else 0, payload=payload_pos)
            pos = payload_pos + size

for i, fr in enumerate(walk('clip.bvr')):
    kind = ('HDR' if fr['flags'] & 0x20 else
            'AUD' if fr['flags'] & 0x02 else
            'META%d' % (fr['flags'] >> 8) if fr['flags'] & 0x04 else
            ('SUB' if fr['flags'] & 0x10 else 'MAIN') + ('*' if fr['flags'] & 1 else ''))
    print(f"{i:6} @{fr['pos']:10} {kind:6} t={fr['ts']:8}ms utc={fr['utc']} n={fr['size']}")
```
