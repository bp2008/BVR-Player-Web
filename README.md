# BVR-Player-Web

A web-based player for Blue Iris `.bvr` files and MP4 video. Everything runs
locally in the browser.  Your files are never uploaded anywhere.

When opening a folder of files, *the browser may say* it is going to upload files to *this site*, but in reality "this site" is just a static HTML file running in your web browser.  **Your files will not actually be uploaded anywhere.**

## Using it

https://bp2008.github.io/BVR-Player-Web/

Open the player, then drag a `.bvr` or `.mp4` file onto the page or press
**Open**. Press **Browse** to page through a whole folder of recordings with
thumbnails.

Also includes a folder browser with thumbnails.

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
| Browse a folder | Browse button | <kbd>L</kbd>, or <kbd>Esc</kbd> |
| Save a snapshot | camera button | <kbd>S</kbd> |
| Metadata inspector | layers button | <kbd>I</kbd> |
| Export to MP4 | download button | <kbd>E</kbd> |
| Settings | gear button | |
| Close a panel | its &times; | <kbd>Esc</kbd> |

The controls fade out while the pointer sits still; turn on **Always show the
controls** in the settings panel to keep them up.

## More

- [Development.md](Development.md) — building, architecture, and how each
  feature behaves in detail.
- [BVR_File_Format_Spec.md](BVR_File_Format_Spec.md) — the container format,
  provided by the Blue Iris developer.
