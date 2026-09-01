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
whether the controls stay on screen rather than fading out, whether the
main-stream jump buttons are shown, overlay drawing, whether scrubbing decodes the exact frame rather than the
nearest key frame (it does), whether playback pauses while you seek, and — for dual-stream
recordings — the main/sub stream selection and whether the two are shown in the
same shape, all live in the settings panel and persist in the web browser's
`localStorage`.

The panel also reports how much of the browser's own storage this page is using
and offers two ways to give it back: **Delete thumbnails**, which costs only the
work of making them again as folders are re-browsed, and **Clear all site data
and close**, which erases settings, cached listings, thumbnails and the folder
permission grant and then shuts the page. Both ask first, in the panel rather
than through a dialog.

Closing is part of the second one rather than decoration: what is left on screen
otherwise is an app whose settings and cached listings have been erased
underneath it, and which writes a fresh set the moment anything is touched. An
ordinary tab is not allowed to close itself — only a window script opened, or an
installed PWA — so when the browser refuses, the panel says the tab still needs
closing instead of pretending it happened.

The figure itself comes from `navigator.storage.estimate()`, which every browser
pads and rounds on purpose: an exact number would say more about what else the
browser has been doing than about this page. It is presented as an approximation
for that reason. The thumbnail *count* beside it is read from the store and is
exact. Chrome's own accounting also lags a delete by a while, so the count drops
at once where the size does not.

### The top bar and control bar

Both fade out after a couple of seconds of a motionless pointer and come back
the moment it moves — 2.6 s for a mouse, 4.2 s for touch, which has no hover to
bring them back with and so is given longer. Plenty pins them open in the
meantime: the pointer resting on the bars themselves, an open menu, a drag of
the scrub bar, the folder browser, a panel being dragged or resized, and
keyboard focus anywhere inside the chrome — hiding a control someone tabbed to
would strand them. Nothing hides while a recording is still loading.

**Always show the controls**, in the settings panel, turns the fading off
entirely. The default stays as it was, because on a player the picture is the
point, but the disappearing act surprises people who expect a seek bar to stay
where they left it, and there is no way to discover the setting exists except by
finding it in the panel — so it is stated in plain terms there rather than
buried in the picture group.

It is one test, `canHideUi()`, that every route to hiding already had to pass:
the idle timer, the pointer leaving the window, and anything added later. The
setting is the first line of that test, which is why turning it on cannot leave
some other path still able to drop the chrome. Turning it on also has to put the
chrome back at once — the timer that hid it has already run and there is nothing
left to cancel — so the setting is watched, and both directions go through
`wakeUi()`: on, it reappears and no new timer is armed; off, the fade starts
again without waiting for the next pointer move.

#### Fitting the row, and the size of what is in it

There is never enough width for a transport, a readout, two pickers and half a
dozen toggles on a phone. The bar used to answer that with a stack of media
queries, each dropping whichever control was least missed at the next breakpoint
down — the frame counter, then the speed chip, then the stream chip, then every
chip there was. A viewer on a narrow window ended up with no speed control at
all, and no way to know one existed.

The row wraps instead. Everything stays on it and the bar grows a line when it
has to. The controls that belong at the far end are one group with `margin-left:
auto`, so they sit right-aligned at the end of the first line when they fit there
and right-aligned on their own line when they do not, rather than scattering.

Heights come from the same flex layout. Every control asks for its natural height
through `min-height` rather than fixing one, and the row stretches its items; the
tallest control on a line — the play button, at 44px — therefore sets that line's
height and every other control on it fills that height. Each is a centring flex
container in its own right, so the extra height goes above and below the icon
instead of into it. The clickable area of everything on a line is as tall as the
line, and nothing moves to achieve it.

The chips are the exception that proves the pattern: a pill 44px tall would look
absurd, so what stretches is a bare button (`.ctl-hit`) and the pill is a span
centred inside it. Hover and the focus ring are drawn on the pill, which is what
the eye reads as the control; the hit area is simply bigger than it looks.

#### The volume slider, and why it is never animated

The wide slider used to grow sideways out of the speaker button on hover. On a
row with width to spare that was fine. On a row without, it was a trap: the
slider appearing rewrapped the bar, the rewrap moved the button out from under
the pointer, the pointer no longer being on the button collapsed the slider
again, and the bar rewrapped back — a loop that ran for as long as the pointer
stayed where it was.

So the slider is now either laid out or not, with nothing in between and no
transition, and it is laid out only where it is free. Free is measured rather
than guessed at from a breakpoint: the control bar lays the row out both ways and
compares the heights, and the slider is shown when having it costs no extra line.
Both measurements happen in one task, before anything is painted, so what reaches
the screen is only ever the answer. The test is `<=`, not `==`, so a row that has
already wrapped for other reasons still gets the slider if one of its lines has
78px going spare.

The measurement is driven by a `ResizeObserver` on the row, plus a watch on a
string of everything that changes what the row has to hold — a chip appearing,
the panel buttons, the readout gaining a digit. Re-measuring on every render
instead would mean three forced layouts per frame of playback for a row that has
not changed. The observer's callback schedules the measurement a frame later
rather than doing it inline, and the measurement settles because it does not
depend on the state it is asked from: both arrangements are measured every time,
so the pass triggered by a change agrees with the one that caused it.

Where the slider is not laid out, hovering or clicking the speaker button opens
the vertical pop-out instead — absolutely positioned, and so incapable of moving
anything. It carries the volume as a number and a mute toggle, since the button
that normally carries mute is now the one that opens this. Hover only counts for
a mouse; a tap synthesises the same event and would open the pop-out only for the
click behind it to close it again. It closes on Escape, on a click outside, or a
sixth of a second after the pointer leaves — with a hover bridge across the gap
between the button and the panel, so travelling from one to the other does not
count as leaving.

### Seeking and scrubbing

Dragging the scrub bar decodes the frame under the pointer, which is the picture
a drag is looking for; letting go settles on it either way. **Exact frame while
scrubbing** is on by default and is the setting to turn off where key frames are
far enough apart that a drag starts to lag — off, the drag shows the nearest key
frame instead, which costs no decoding at all and is what lets a drag keep up on
a recording with minutes between key frames. Frames keep arriving for as long as
you hold the pointer down — a picture already being decoded is never thrown away
to chase a newer position, because seeing every few frames of what you dragged
past beats seeing none of it.

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

### Streams that cover different parts of the recording

A Blue Iris recording need not hold both of its streams for its whole length.
The arrangement that makes this matter is continuous sub-stream recording with a
motion-triggered main stream: an hour-long file whose sub stream runs end to end
and whose main stream exists in a handful of islands totalling a few minutes.
The two streams do not have to share a codec either — H.265 main alongside H.264
sub is ordinary — and their frame rates can differ by a factor of sixty.

**Auto** plays the best picture available at each moment, switching between the
streams as their coverage comes and goes. "Best" means the largest picture, read
from the bitstream rather than from the header, so a recording that happens to
carry the bigger picture on its sub stream is played from the sub stream. Each
stream gets its own decoder, which is what lets the two carry different codecs.

Coverage is worked out from the frames rather than from the MAINAVAILABLE flag,
because the question is about stretches of time and the flag answers it one frame
at a time. A stream counts as absent only once it has gone without a frame for
several times its own typical spacing — so a main stream recorded at half a frame
per second beside a 30 fps sub stream reads as continuously present, and is
played continuously, rather than flickering between resolutions twice a second.
Stretches shorter than a couple of seconds are not worth a switch either way and
are absorbed into their neighbours, so a brief flash of main stream costs nothing
and a sub stream that starts a quarter-second before the main one goes unnoticed.

Switches land on a key frame of the stream being switched to, and preferably the
one just *before* the changeover, so the outgoing stream plays right up to where
the incoming one begins and the picture never freezes across a switch.

**Main** and **Sub** still play exactly the stream named. Where that stream has
nothing — before its first frame, or across a hole — playback skips forward to
the next picture that exists rather than sitting on a still frame while the audio
runs on. Past its *last* picture there is nothing to skip to, so the clip is over:
the playhead jumps to the end and playback stops, or loops, as it would at the end
of any other file. Either way it is the recording that ends, not the stream — the
timeline is the recording's throughout, not the selected stream's, so a file whose
main stream covers twenty minutes of an hour is still an hour long, and both the
audio and the other stream are still there to be reached.

Where the two streams differ, the scrub bar says so. Stretches with main-stream
video are drawn light, stretches with only the sub stream are the plain rail, and
stretches with neither are darkened; hovering names which it is. Nothing assumes
the main stream is the sparser of the two, so a recording whose *sub* stream
dropped out reads correctly the other way round. On the ordinary recording whose
streams cover the same hour, the banding is not drawn at all.

#### Jumping between main-stream stretches

**Main-stream jump buttons**, off by default in the settings panel, adds a pair
of buttons either side of the transport that move the playhead to the moments
the main stream starts up. They land on exactly the left edges of the light bands
the scrub bar already draws, which is the point of them: on a motion-triggered
recording those bands are where anything happened, and finding the next one
otherwise means dragging an hour-long scrub bar past a few pixels of light.

The starts are read from the same coverage intervals as the banding, so the two
cannot disagree. A first island within a second of the beginning is not counted:
a recording that simply opens on the main stream is not transitioning into it,
and <kbd>Home</kbd> already goes there. That rule is also what makes the buttons
dead on the two shapes of recording with nowhere to jump — one covered end to end
by the main stream, and one with no main stream at all — and dead is what they
are, rather than hidden, so the pair does not appear and disappear between files.
Each button says in its tooltip which of the three things is true: where it would
go, that there is nothing further that way, or that this recording has no
main-stream starts at all.

Off by default because most recordings do not have the shape it is for. On a file
whose streams cover the same hour the buttons would sit there permanently dead,
and a control that is always dead is worse than one that is absent.

<kbd>Ctrl</kbd>+<kbd>,</kbd> and <kbd>Ctrl</kbd>+<kbd>.</kbd>, or <kbd>Ctrl</kbd>
with the left and right arrows, do the same jumps from the keyboard, and they do
them whether or not the buttons are turned on. The setting is about what the
control row has room for; a shortcut takes no room, and on a recording with no
main-stream starts it simply does nothing, which is what an unused key already
does. Ctrl is what keeps <kbd>,</kbd> and <kbd>.</kbd> on frame step and the bare
arrows on skip — the pairing is deliberate, since a jump between stretches is the
same motion as those, several minutes at a time instead of a frame or ten seconds.

An `auto` sequence that really is built from two streams cannot be copied into
an MP4 — one track holds one codec, and one resolution — so exporting it
re-encodes, and the export panel says to pick main or sub on its own to copy
frames instead. An `auto` sequence that *collapsed* to a single stream, which is
what happens whenever the better stream already covers the whole recording, is
one stream like any other and copies.

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
`hillsidedrivet.20260824_203945.310Z.jpg`. That holds whichever way the
recording itself was named — a clip downloaded through UI3 arrives as
`Front Wide 2026-08-25 05.00.00 PM.bvr` and its stills come out as
`Front Wide.20260825_230145.310Z.jpg`, so a folder of stills sorts by camera and
moment however they were collected. The format is JPEG at 85% quality by
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

A folder small enough to read quickly is read again every time rather than
served from that cache — see below.

This needs the page to be served over http(s) — the directory APIs have nothing
to grant access to on a `file://` page — so the button only appears where it
works. Opening one file at a time is unaffected.

The filter box matches on the file name, which is also where the camera name
lives, and the sort menu offers newest, oldest, name, camera and largest first.
Time-ordered views are broken into day headings; the others are one flat run.

Two naming conventions are recognised, because a folder of downloads is as
ordinary a thing to browse as a folder of recordings:

| | Example | Time is |
|---|---|---|
| Blue Iris storage | `hillsidedrivet.20260824_203931Z.bvr` | UTC (the trailing `Z`) |
| UI3 download | `Front Wide 2026-08-25 05.00.00 PM.bvr` | the server's local time |

The UI3 form keeps the camera under its configured name, spaces and all, and
carries no zone marker of any kind — so it is read as local time, which is what
it is. A 24-hour clock and the browser's `(2)` duplicate suffix are both
accepted. A name that matches neither is listed under its whole name with no
date, which sorts to the end of a newest-first listing.

#### Folders with six figures of recordings in them

A Blue Iris folder that has been recording for a while is not a few hundred
clips. The folder this was built against holds 220,000 files on a mechanical
disk behind an SMB share — 111,000 recordings and a `.dat` sidecar beside each
one — and everything about the browser is arranged around that being normal
rather than exceptional.

- **The listing reads names, not files.** At the file system level, enumerating
  a quarter of a million names is one streamed operation that finishes in about
  340 ms, even off a spinning disk over SMB, while reading each file's metadata
  is an individual round trip at ~0.29 ms — half a minute of nothing happening.
  So the listing carries only what the name says — camera and start time, which
  is what the grid is grouped and sorted by anyway — and size and modified time
  are read per clip as it scrolls into view. Opening that folder costs a few
  dozen file reads instead of 111,000.

- **Chrome's own per-entry cost is the ceiling, and on a network share it is
  brutal.** Measured on the folder above, through `showDirectoryPicker()`:

  | | ms per directory entry | 223,078 entries |
  |---|---|---|
  | default Chrome | 25.6 | **95 minutes** |
  | `--disable-features=FileSystemAccessDirectoryIterationBlocklistCheck` | 0.255 | 57 seconds |

  A hundredfold, from one feature flag. Chrome checks every entry it hands out
  against a sensitive-path blocklist, and that check runs on the *resolved* path
  — over SMB, a round trip each time, for a quarter of a million entries,
  inside the browser process. That process also serves new tabs and DevTools,
  which is why the whole browser stops responding rather than just this page. A
  tab that will not open is the tell that the problem is over there.

  The cost is not a property of the API in general. The same share, the same
  Chrome, the same session, folders of empty files:

  | files in folder | ms per entry |
  |---|---|
  | 500 | 0.477 |
  | 2,000 | 0.493 |
  | 8,000 | 0.481 |
  | 30,000 | 0.454 |
  | 60,000 | 0.423 |
  | 120,000 | 0.462 |
  | 223,078 | 0.697 |
  | Aux1, quiet disk | 0.458 – 0.485 |
  | Aux1, disk busy | 10 – 25 |

  **Folder size is not the variable**, and neither is anything else about Aux1:
  the same folder measures 0.458 ms an entry when nothing else is touching the
  drive and twenty times that when a camera happens to be writing a clip to the
  same spindle. The whole spread is contention for one mechanical disk.

  `--disable-features=FileSystemAccessDirectoryIterationBlocklistCheck` is worth
  about 2x on a quiet disk — 0.219 ms an entry against 0.458. An earlier reading
  here claimed a *hundredfold*, from a single measurement that happened to land
  on a quiet disk while its comparison landed on a busy one. Two runs, one
  variable each, is the difference between the two numbers, and the wrong one
  nearly went upstream.

  What does hold across every folder and every disk state is the floor itself.
  0.5 ms an entry means two minutes for a 223,000-entry folder, where .NET
  enumerates the same directory in 340 ms and Explorer opens it in seconds —
  something like 450 times slower for the same work. That is the number worth
  explaining, and it is reproducible with a folder of empty files.

  Worse, **starting one of these is not a decision that can be taken back.**
  Breaking out of the `for await` calls `return()` on the iterator, which stops
  this page reading — it does not stop Chrome. Measured by abandoning an
  iteration after twenty entries and then timing `getFileHandle()` until it
  returned to normal: 368 ms against a 239 ms full pass, 846 ms against 987 ms,
  4.3 s against 3.8 s. Recovery takes about one complete enumeration at every
  size, which is what continuing to the end looks like.

  It shows up more plainly still in the first operation issued after walking
  away. Abandon an iteration at 2,000 entries and the next `getFileHandle()` on
  that directory blocks until the enumeration reaches the end — 25 s at 60,000
  entries, 55 s at 120,000, 48.3 s on Aux1's 223,078 against a projected full
  pass of 48.8 s. Subsequent calls take under a millisecond. Averaging that first
  call in with the others hides it completely, which is how it went unnoticed for
  so long.

  This is what settles what the browser can do while a folder is being read: the
  names arrive as they are found, but *nothing else about the folder can be read
  at all* until the walk ends. Sizes, durations, thumbnails and playback all go
  through `getFileHandle`, so all of them queue. The listing is therefore drawn
  progressively — the grid fills, and scrolling and the filter box work on what
  has arrived — while per-clip work is held back until the scan finishes rather
  than being queued into a heap that lands all at once (`fill` returns early
  while `scanning`). That is the real reason
  the browser has to be killed from Task Manager: not the page, but a job in the
  process that serves every tab.

  So the folder is enumerated once and the names are kept (`saveListing`).
  Reopening the browser reads them back instead of walking the directory again,
  which is what turns a folder like Aux1 from unusable into a two-minute wait
  paid once; Refresh is the way back to the disk. Only names are stored, because
  only names are known at listing time anyway — a few megabytes for six figures
  of recordings.

  **Only where it is worth it.** The cache is not free: what it costs is a
  listing that does not show a recording made since, until someone thinks to
  press Refresh. That is a fair trade against two minutes and a bad one against
  half a second, so a listing of 3,000 directory entries or fewer is thrown away
  and the folder read again (`worthRelisting`). Chrome's floor is about half a
  millisecond an entry whatever the folder, which puts that ceiling under two
  seconds on a busy network share and out of sight on a local disk. It is also
  the size the listing already treats as small enough to read whole up front
  (`EAGER_STAT_LIMIT`), counted in entries rather than recordings — the cost is
  per directory entry, and Blue Iris writes a `.dat` beside every clip, so a
  folder's real price is about twice what the grid shows. Entries scanned is
  therefore what `saveListing` records alongside the names.

  A scan that falls under 400 entries a second for twelve seconds is still noted
  against the folder, but as a warning rather than a refusal, and it expires
  after a day. A slow reading almost always means the disk was busy at that
  moment, not that the folder is beyond reach, so the panel says so and offers to
  try again.

  **A walk nobody saw the end of is a refusal.** The walk is recorded before it
  starts (`markScanStarted`) and the record removed only when `listDirectory`
  returns; anything else — the panel closed, the tab closed, Chrome killed from
  Task Manager to get the machine back — leaves the record behind. On the next
  launch `restore` finds it and stops there: the folder is named, the directory
  handle is deliberately not adopted, and the only way on is to pick the folder
  from the picker again. Reopening it automatically would start the same
  hour-long enumeration on the way to recovering from it, every launch, for as
  long as it kept failing — the one failure that repairs itself only by not being
  retried. Unlike the slow-folder note this one does not expire: it is a fact
  about that folder, not about how busy the disk was at the time.

  **There is no Stop.** The button that offered one is commented out in
  `FolderBrowser` rather than deleted, with the reason beside it, because the
  question comes up again every time someone watches the spinner. Aborting the
  `for await` stops this page reading the results and nothing else: Chrome
  finishes the directory whatever the page does, so a Stop button would report
  the browser as recovered while it was still an hour from it. What genuinely
  does stop — the bulk metadata pass behind the size sort, which is a loop of
  this page's own — keeps its Cancel.

  `<input webkitdirectory>` is not a way out. It is a genuinely different code
  path, but it cannot be interrupted once a folder is chosen, and on this folder
  it froze the browser outright both times it was tried.

- **Handles are not kept.** A `FileSystemFileHandle` is not a plain object:
  Chrome mints one per directory entry in the browser process, each with its own
  Mojo endpoint, and it does this for `entries()` / `values()` / `keys()` alike —
  Blink builds a handle from every entry it receives whichever one you asked for,
  so `keys()` is not the cheap door it looks like. Keeping one per clip holds six
  figures of pipes open for as long as the folder is listed.

  So the listing keeps names and drops each handle as it arrives, and a clip's
  handle is resolved from the directory by name when something needs it
  (`fileHandleFor`). `File` objects go the same way — a `File` is a blob
  registered in the browser process — with one exception: a `webkitdirectory`
  listing has no way back to the bytes except the `File` it was handed, so
  `releaseEntry` leaves those alone. Browsing a six-figure folder end to end
  leaves zero handles and zero files retained.

  This is hygiene rather than the cure. It stops the page adding to the browser
  process's problems; it does not make the iteration above any cheaper.

- **Yielding uses a `MessageChannel`, not `setTimeout`.** A background tab clamps
  timers to one a second, so a scan left running while its tab is not in front
  slows to a crawl — 223,078 entries took 35 seconds that way and 418 ms once the
  yield stopped going through a timer. Nested timeouts are pinned to a 4 ms floor
  even in the foreground. A channel message is neither throttled nor clamped.

  Folders of up to 1,500 recordings are still read whole up front, because at
  that size nobody notices and having every size in hand from the first paint is
  nicer. **Largest first** is the one view that needs metadata for clips nobody
  has looked at; choosing it runs a bulk pass with a progress bar and a Cancel,
  once.

- **Only the visible rows exist.** 111,000 tiles with a thumbnail each is not a
  document a browser will lay out. The listing is flattened into rows — a day
  heading, or one line of the grid — and since each kind has one height, the
  offset of any row is a prefix sum and the row at a scroll position is a binary
  search (`src/library/clipRows.js`). Thirty-odd tiles are in the document at any
  time, positioned absolutely inside a spacer of the full height. Row heights are
  guessed from the width and then corrected against what was actually laid out,
  so the stylesheet stays the thing that decides how tall a tile is.

- **Thumbnail work follows the window.** With only the visible rows in the
  document there is nothing to ask an `IntersectionObserver` about — the window
  *is* the answer, and it is already computed. Each scroll points the pool at
  what is on screen and cancels what has left it, and because every pass reads
  the current window, flinging past ten thousand clips abandons them rather than
  queueing them: a fling of that size starts about sixty file reads, not ten
  thousand.

  **What is on screen goes first, and says so.** Which rows are *visible* is
  tracked apart from which rows are *rendered*: the document keeps three rows
  beyond each fold so a flick lands on something, but only the visible rows and
  one row either side are ever asked for a picture. A thumbnail costs a file read
  and a key-frame decode and two or three run at a time, so one spent three rows
  off screen is one the row being looked at is waiting for.

  Order alone was not enough. The pool served newest-first, on the reasoning that
  in a grid being scrolled the last thing asked for is the thing on screen — true
  only while every request comes from the same screenful. A clip a row below the
  fold, queued a frame later than one in the middle of the window, took priority
  over it, which is what made the fill order look arbitrary while the pictures
  actually being looked at were still blank. Each request now carries a rank —
  visible rows in reading order, then the overscan row on whichever side the list
  is moving towards — and the pool serves the best rank in its queue rather than
  the most recent. Ties still go to the newest, which is the old rule surviving
  where it was always right. Scrolling re-ranks a job already waiting rather than
  queueing it again.

- **The listing is not reactive.** Handing a six-figure array to Vue means a
  proxy per entry and a dependency per field read, paid on every scroll for rows
  that are not in the document. The component keeps the listing as plain data and
  publishes only the rendered window; results arriving are folded in through a
  counter bumped once per frame.

- **Filtering does not re-sort.** The listing is sorted once, in place, so the
  filter is a subset of an array that is already in order. A keystroke is one
  scan of pre-lowered names plus a row rebuild — about 10 ms across 111,000
  clips, behind 120 ms of typing debounce. Sorting by name uses a cached
  `Intl.Collator`; `localeCompare` with options resolves them on every call,
  which at two million comparisons is two seconds of frozen page against
  seventy-odd milliseconds.

### Playing MP4 files

`.mp4`, `.m4v` and `.mov` open with the same controls as a `.bvr` recording:
scrubbing, frame stepping, digital zoom, snapshots, the speed control, the
inspector and export all work unchanged. What a file *is* is decided from its
first bytes rather than its name, so a recording that arrived with the wrong
extension still opens.

The things an MP4 cannot offer are the Blue Iris ones: overlay metadata, marks,
segment starts, per-frame camera state and digital inputs, motion masks, areas of
interest and the writer version are all written by Blue Iris into the BVR
container and have no MP4 equivalent. The inspector says so in those places rather than showing empty
sections, and it gains an **MP4 structure** section instead — brands, timescale,
whether the index is a `moov` sample table or a run of fragments, and a line per
track.

Two differences are visible in ordinary use:

- **It opens instantly.** A BVR file has no index, so opening one means reading
  every byte to find out where its frames are. An MP4 wrote that table down, so
  opening one reads `moov` and stops — a few megabytes however long the
  recording is. The progress bar only appears for a fragmented file, where the
  table has to be gathered from each fragment in turn.
- **The streams are called what they are.** "Main" and "Sub" are Blue Iris's
  words for two streams recorded in parallel, and they mean something that does
  not apply to MP4. A file with one video track just says "Video"; one with two
  says "Video 1" and "Video 2". Internally they still occupy the player's main
  and sub slots — largest picture first — which is what lets the stream menu,
  the coverage banding and the export's stream selection work without knowing
  the difference.

Audio is decoded from whatever the file states: AAC, MP3, Opus and FLAC through
WebCodecs, and PCM, G.711 mu-law and A-law expanded in the player as BVR's own
audio is. Unlike BVR, an MP4 states exactly when each audio packet starts, so
none of the reconstruction described in spec section 6 is needed.

Fragmented MP4 (`moof`/`trun`) is read as well as the ordinary indexed kind,
which matters because it is what a recorder that may be killed mid-write
produces. A file whose `moov` was never written cannot be played by anything and
says so plainly.

### Metadata

BVR carries more than pictures: overlay text and clocks, motion and AI bounding
boxes, GPS, per-frame camera state and DIO inputs, marks, and the camera's motion
mask. The **metadata** button opens an inspector over three tabs — the file as a
whole (including the codec, resolution and frame count of whatever is playing,
the recording window, the Blue Iris build that wrote the file, the AOI, and the
motion-mask geometry with a rendered grid), the current frame, and a timeline of
marks and recording-segment starts
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

A stream copy is refused for a sequence that genuinely switches between the two
streams, and the panel explains why: one MP4 track holds one codec and one
resolution, and a switching sequence offers neither. The user is pointed at the
single-stream selection instead. A re-encode handles it either way, running a
decoder per source stream into one encoder and draining each before the other
takes over, so the output follows exactly the sequence that was on screen.

**Video source: Both** is not refused on principle, though, and saying so is the
job of the `?` beside the disabled option. Both copies whenever the sequence it
builds never has to switch — either because the better stream already covers the
whole recording, so `auto` collapses to that stream alone (the common case), or
because the two streams happen to share a codec and a picture size. The reason
on the radio itself names *every* thing that is wrong with the file rather than
the first one found, since "the two streams use different codecs" on its own
reads as a promise that matching codecs would be enough when a size mismatch
would still refuse.

The range is set by dragging the handles on the scrub bar, by the **start here**
and **end here** buttons, or by typing either timestamp into the panel. The
playhead follows whichever you use — including a handle being dragged — so the
frame you are cutting on is the frame on screen rather than a guess. Typing is
the way to pick a precise moment in a long recording, where a scrub bar a few
hundred pixels wide cannot resolve a particular second. Times are read as
`m:ss.mmm`, and shorthands work too: `12` is twelve seconds, `90:00` is ninety
minutes.

Audio from a BVR recording is always re-encoded to AAC: none of the formats it
carries (FLAC, PCM, G.711 µ-law) has an MP4 form players can be relied on to
handle. Audio that is *already* AAC — which in practice means the source was an
MP4 — is copied across instead, which is lossless, far faster, and the only audio
path at all in a browser with no `AudioEncoder`.

Exporting from an MP4 works the same way and is mostly a faster version of the
same job, since its frames are already stored as MP4 samples and its parameter
sets are already an `avcC`/`hvcC` — nothing has to be converted or gathered out
of the bitstream on the way past. A source with B-frames is copied in decode
order with its composition offsets rewritten; see *Decode order is a permutation*
below for why that is not simply the frame table walked forwards.

Where the browser supports it, the file is written straight to disk as it is
produced, so an export can be far larger than memory; otherwise it arrives as a
Blob download, with a warning above 1.5 GB.


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
src/container/   container seam - sniff and dispatch, and the documented contract
                                  every reader below produces
src/bvr/         BVR reader     - frame headers, file header, full-file index,
                                  codec probe, overlay metadata, tail scan
src/mp4/         MP4 reader     - ISO box walk, sample tables, fragments, sample
                                  entry -> WebCodecs configuration
src/player/      playback       - decode pipelines, media clock, canvas renderer,
                                  zoom/pan gestures, overlay painting
src/library/     folder browser - directory access, virtual list rows, thumbnail
                                  worker, IndexedDB cache
src/export/      MP4 export     - Annex-B to AVCC, ISO BMFF muxer, remux/transcode
src/panels/      docking        - the panel list, the layout solver, pop-out windows
src/util/        shared rules   - aspect correction, settings, formatting, keys
src/components/  Vue 3 UI (Options API)
```

- **One seam, two containers.** `src/container/open.js` is the only code in the
  app that knows what a container is. It sniffs the opening bytes and hands back
  the same three objects either way — a `header` describing the recording, an
  `index` of frame tables, and a `probe` saying whether this device can decode
  any of it. Everything above it works from those alone, which is why MP4
  support did not need the pipelines, the renderer, the scrub bar or the export
  rewritten. The fields each reader fills are written down in
  `src/container/mediaInfo.js`, because that contract used to be implicit in a
  BVR file header half a dozen modules reached into.
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
  profile/tier/level. Chunks are fed to `VideoDecoder` in Annex-B form.
- **Stream coverage and switching.** `src/player/coverage.js` reads from the
  frame table where each stream actually has pictures, and turns that into the
  plan `auto` plays: which stream is preferred at each moment, and the runs of
  frames the merged sequence is built from. A run is always a contiguous slice of
  one stream's frame table opening on a key frame, which is the only shape a
  decoder will accept; key-frame back-references never cross a run boundary, so a
  seek restarts the right decoder on the right stream. `VideoPipeline` keeps one
  decoder per source stream, routed per frame, which is what lets the two carry
  different codecs — and drains the outgoing one at each changeover, or the
  pictures it is still holding would never be handed over.
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

### Chunks fed and pictures kept are two different numbers

The video pipeline keeps a sliding window of decoded frames around the position
being played, sized from a memory budget — an `ImageBitmap` is RGBA-backed, so a
3632×1632 picture is 23 MB and a 4K clip would otherwise eat GPU memory by the
gigabyte. The same number used to bound how far ahead of the anchor *chunks were
fed into the decoder*, which was one number doing two jobs, and on one recording
the two jobs wanted opposite things.

A decoder does not hand a picture back the moment it is fed one. It fills its
decoded picture buffer first so that it can emit in display order, and how many
it swallows before the first one comes out is set by the stream's level and
picture size. Measured through WebCodecs on a level-5.1 recording:

| stream | picture | chunks in before the first picture out |
|---|---|---|
| main, hardware | 3632×1632 | **8** |
| main, `prefer-software` | 3632×1632 | 2 |
| sub, hardware | 1200×536 | **17** |

Chrome's hardware H.264 path does this whatever `optimizeForLatency` says — the
flag made no difference to either measurement. The memory budget, meanwhile,
gives a 5.9 megapixel picture a window of six, and six frames behind the anchor
have to come out of that too. Seven chunks in, nothing out, and nothing more fed
because the window was already "full" of them: each side waiting for the other,
nothing actually failed so no error raised, and the buffering chip up for as long
as the page was left open. That is what a recording that would not play looked
like, and it looked like nothing at all.

The two are now separate. `maxAhead` is pictures kept and stays a memory
question; `_feedAhead()` is chunks fed and carries an extra allowance for the
decoder's reorder depth. The extra chunks sit inside the decoder rather than in
the frame buffer, so the allowance is paid in input rather than in memory — and
the two demands trade against each other anyway, since the picture buffer a
decoder is entitled to shrinks as the pictures grow. **The deepest reordering
belongs to the smallest frames**, which are the cheapest to keep.

The depth itself is measured rather than predicted. Deriving it from the
bitstream means the level table, VUI parsing, and trusting the decoder to agree
with all of it; instead the pipeline notices that it is starved — the decoder has
taken every chunk, nothing is on its way back, and the look-ahead has not filled
— and feeds it more, until pictures appear. Nothing at all happens on a file that
never stalls.

Two details matter more than they look:

- **The test is whether the look-ahead filled, not whether the frame being waited
  on arrived.** A decoder handing back frame *N* only once frame *N+17* has gone
  in keeps playback technically alive with no look-ahead whatsoever: every
  picture lands exactly when it is needed, the buffering chip never goes out, and
  one slow read is a visible stutter. The first version of this check stopped at
  "the anchor's own frame is here" and left the sub stream limping in exactly
  that state.

- **The stall has to last.** A decoder dequeues a chunk before it delivers the
  picture that chunk produced, so "queue empty, nothing back yet" is also the
  ordinary moment just before an output — and `ondequeue` fires often enough to
  catch several of them. A real deadlock lasts as long as the page is open, so
  the reading has to hold still for 150 ms, with any picture arriving counting as
  movement. Without that the allowance grew on healthy files too.

What a stream's decoder turned out to want is remembered per stream for as long
as the file is open, so switching between main and sub does not pay for the
discovery twice. It looked like the decoder was being left dirty by a switch; it
was the measurement being thrown away with the old pipeline.

### Decode order is a permutation, not a second timeline

BVR guarantees that frames decode in the order they are shown (spec 5.4), and the
whole player was built on it: `ts[]` is binary-searched for a seek, the feed walks
the frame table forwards, key-frame back-references point backwards, and the
frame counter counts the frames on screen. MP4 makes no such promise. Any file
with B-frames stores its samples in one order and shows them in another, and
three of those four assumptions break at once.

The obvious fix — keep the table in decode order and translate on the way out —
was rejected because it puts the translation in every consumer. The scrub bar,
the frame counter, single-frame stepping, the coverage banding, the export's trim
range and the metadata panel all count frames, and all of them would have had to
learn a second ordering.

So the table stays in *presentation* order, which is the order everything above
the pipeline already means, and decode order is carried beside it as a
permutation:

```
feedOrder[step]  the frame to feed at decode step `step`
feedPos[i]       the decode step at which frame i is fed
feedHigh[i]      the highest decode step among frames 0..i
```

Only `VideoPipeline` reads them, and only in three places: what to feed next,
where to restart after a seek, and how far ahead it may run. On a stream that
does not reorder — every BVR recording, and most surveillance MP4s — the arrays
are absent, a step *is* a frame index, and the code path is exactly what it was.

`feedHigh` is the subtle one, and it is the difference between working and
deadlocking. The feed has to be bounded or it would decode the whole file, but a
bound expressed in presentation order can refuse to send the very chunk the
decoder is waiting for: in decode order `I P B B`, the `P` is shown *last* and so
looks far ahead, while the two `B`s shown next cannot be decoded without it.
Stopping at "anchor + N frames" therefore stalls with the decoder holding
everything and the feed convinced it has run too far ahead. `feedHigh[i]` is the
highest decode step among the first `i` frames, so feeding every step up to it
guarantees each of those frames has been handed over, and it never runs further
ahead than the stream's own reorder depth requires.

The same permutation is what lets an export copy such a file: the samples are
written in decode order and timed by their decode timestamps, with each frame's
presentation time riding along so the muxer can write the composition offsets
back out. `sample/_check/testMp4Export.mjs` checks this by round trip — demux the
output and confirm it presents the same frames, in the same order, with the same
bytes as the source.

### The frame window is sized once and then left alone

A sequence that switches between a 5120×1440 main stream and a 1904×536 sub
stream has pictures ten times apart in area, and the obvious refinement — size
the window from whichever stream is playing, so the sub stream gets the two dozen
frames of look-ahead it fits in rather than the four the main stream allows — is
wrong, in a way worth writing down because it looked so reasonable.

The window and the feed allowance above are two ends of one invariant: nothing is
fed that the window will not have room for by the time it comes back. Re-size the
window mid-flight and the invariant breaks. Shrinking it — which is what crossing
into the larger stream does — leaves pictures already inside the decoder outside
the new bound, and they are dropped on arrival. They are never decoded again
either: the feed has moved past them and only a restart goes back, so the
sequence acquires a hole of exactly the difference between the two windows. In
practice that was ten missing frames immediately after every switch to the main
stream, the player waiting forever for the first of them, the clock held, and the
buffering chip up — the same symptom as the deadlock above and a completely
different cause.

So the window is sized from the sequence's *largest* picture, once, and a
handful of frames of look-ahead while the sub stream plays is the price. It is
the price this pipeline has always paid on a switching-mode recording.

### Nothing fed is ever discarded

The section above fixed one way of shrinking the frame window under a feed that
had already run ahead. There is another, and it took a stall report on a
switching-mode recording to find it: the window does not only change size, it
also *moves*, and it moves backwards whenever the anchor does.

Stepping back one frame moves the anchor back one frame. So does a small seek
that lands inside the buffer, and so does letting go of the scrub bar. None of
them restarts the decoder — that is the point of keeping frames behind the
anchor — so the feed pointer stays exactly where it was while the top of the
window drops by the distance moved. Any frame between the new top and the old
one has been fed, is thrown away on arrival or trimmed if it had already
arrived, and will never be fed again. The player reaches it a fraction of a
second later, finds nothing, holds the clock, and waits for a picture that no
longer exists anywhere. A held clock never asks for a different frame, so the
wait is permanent: the buffering chip stays up until the file is reopened.

Whether that costs anything depends on how much slack there is between the feed
limit (`anchor + maxAhead + reorder`) and the top of the window
(`anchor + maxAhead + max(4, reorder)`), and on how far the decoder's output
lags its input. On the recording this was reported against, playing `auto`:

| | picture | reorder allowance | output lag | slack |
|---|---|---|---|---|
| main alone | 5120×1440 | 0 — never widened | 0 | 4 frames |
| auto, in the main run | 5120×1440 | **16** — learned from the sub stream | 0 | **0** |

The main stream's H.265 decoder hands every picture back the moment it is fed
one, so it never trips the starvation detector and, played on its own, sits at a
reorder allowance of zero where `max(4, reorder)` leaves four frames of slack —
enough to absorb a step back, which is why the bug was invisible on `main`. In
`auto` the allowance is one number for the whole pipeline and the *sub* stream's
decoder swallows sixteen chunks before its first picture, so the allowance is
pinned at `MAX_REORDER`. Back inside the main run that allowance buys nothing —
that decoder needed none of it — but it does move the feed limit up to exactly
the top of the window. Zero slack, and one press of the step-back key drops one
decoded frame on the floor.

The fix is the invariant stated directly rather than arithmetically:
**`_keepTo` never returns less than the highest frame already handed to a
decoder.** The pipeline tracks that as `_fedHigh`, reset on every restart, and
floors the window with it. Nothing that has been fed can be discarded before it
has been shown, which is what the window was always meant to guarantee, and it
covers every way the window can retreat under the feed rather than the one that
was reported. It costs no memory in steady state — the feed limit and the window
top coincide there — and at most `maxBehind` extra frames while the anchor is
behind where the feed reached, which is bounded because an anchor that moves
back further than the buffer reaches restarts the decoder anyway.

**And the player no longer waits forever for a picture that is not coming.**
A decoder emits in presentation order, so a picture in hand for a *later* frame
proves the absent earlier one was skipped or dropped rather than merely slow —
the one test that tells a hole apart from a decoder that is behind. Where
`_loop` finds nothing at or before the frame it wants and something after it, it
now seeks to that next picture instead of holding the clock. A hole from any
cause — including a run entered mid-way after a restart, whose leading delta
frames are skipped on purpose — costs a visible jump of a frame or two rather
than ending playback.

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
