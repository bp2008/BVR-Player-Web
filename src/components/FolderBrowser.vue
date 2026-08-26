<template>
  <div class="library" role="dialog" aria-label="Recordings">
    <header class="library__head">
      <AppIcon name="library" :size="20" />
      <h2 class="library__title">{{ dirName || 'Recordings' }}</h2>
      <span v-if="total" class="library__count">{{ countLabel }}</span>
      <span v-if="listedAge" class="library__count library__count--age" :title="'Listed ' + listedAge + '. Refresh to look again.'">
        · {{ listedAge }}
      </span>

      <div class="library__spacer"></div>

      <input
        v-if="total"
        v-model="query"
        class="library__search"
        type="search"
        placeholder="Filter by name or camera"
        aria-label="Filter recordings"
        @keydown.stop
      />

      <select v-if="total" class="settings__select" :value="sort" aria-label="Sort" @change="$emit('patch', { librarySort: $event.target.value })">
        <option v-for="s in sorts" :key="s.value" :value="s.value">{{ s.label }}</option>
      </select>

      <button
        v-if="total"
        type="button"
        class="ctl-btn ctl-btn--small"
        :title="view === 'grid' ? 'Switch to list' : 'Switch to grid'"
        :aria-label="view === 'grid' ? 'Switch to list' : 'Switch to grid'"
        @click="$emit('patch', { libraryView: view === 'grid' ? 'list' : 'grid' })"
      >
        <AppIcon :name="view === 'grid' ? 'list' : 'grid'" :size="18" />
      </button>

      <button v-if="canRefresh" type="button" class="ctl-btn ctl-btn--small" title="Refresh" aria-label="Refresh" @click="refresh(true)">
        <AppIcon name="refresh" :size="18" />
      </button>

      <button type="button" class="btn btn--ghost" @click="choose">
        <AppIcon name="folder" :size="16" />
        <span>{{ total ? 'Change folder' : 'Choose folder' }}</span>
      </button>

      <button type="button" class="ctl-btn ctl-btn--small" aria-label="Close" @click="$emit('close')">
        <AppIcon name="close" :size="18" />
      </button>
    </header>

    <div v-if="task && (!loading || total)" class="library__task">
      <span>{{ task.label }}</span>
      <span class="library__bar"><span class="library__barfill" :style="{ width: taskPercent + '%' }"></span></span>
      <span v-if="task.total" class="library__count">{{ count(task.done) }} of {{ count(task.total) }}</span>
      <span v-else class="library__count">
        {{ count(task.done) }} so far<span v-if="task.rate"> · {{ count(task.rate) }}/sec</span>
      </span>
      <!--
        Stop, while the folder itself is being read, is commented out rather than
        removed, because it could not do what its label said. Aborting the
        `for await` stops this page reading the results; it does not stop Chrome,
        which finishes enumerating the directory in the browser process whatever
        the page does — after the tab is closed, and for the hour a large folder
        on a network share takes. A button that stops nothing is worse than no
        button. The metadata pass is a loop of this page's own and does stop, so
        it keeps its Cancel.

        <button type="button" class="btn btn--ghost" @click="cancelScan">
          {{ loading ? 'Stop' : 'Cancel' }}
        </button>
      -->
      <button v-if="task.cancellable" type="button" class="btn btn--ghost" @click="cancelSizes">
        Cancel
      </button>
    </div>

    <div class="library__body" ref="scroll" @scroll.passive="onScroll">
      <div v-if="loading && !total" class="library__center">
        <div class="spinner"></div>
        <p>Reading {{ dirName }}…</p>
        <p v-if="task" class="library__hint">
          {{ count(task.done) }} recordings
          <span v-if="task.scanned"> · {{ count(task.scanned) }} entries scanned</span>
          <span v-if="task.rate"> · {{ count(task.rate) }}/sec</span>
        </p>

        <div v-if="scanIsSlow" class="library__stall">
          <p class="library__hint library__hint--warn">
            This folder is coming back at {{ count(task.rate) }} entries a second.
          </p>
          <p class="library__hint">
            Chrome checks every entry against a safety list as it lists a folder, and over a
            network share that check costs a round trip each time. On a folder with hundreds of
            thousands of files that turns a one-second listing into an hour-long one, and it
            happens inside the browser rather than in this page — which is also why the rest of
            Chrome goes unresponsive while it runs.
          </p>
          <p class="library__hint">
            There is nothing to press: Chrome finishes the folder whether this page waits for it
            or not, and closing the tab does not call it back. The rest of the browser stays slow
            until it ends. This folder will not be listed again without being asked for.
          </p>
        </div>

        <!--
          Same reason as the button on the progress row above: this one offered to
          stop a directory walk that no page can stop. See `cancelScan`.

          <button type="button" class="btn" @click="cancelScan">
            {{ scanIsSlow ? 'Stop' : 'Cancel' }}
          </button>
        -->
      </div>

      <div v-else-if="error" class="library__center">
        <AppIcon name="alert" :size="30" />
        <p class="library__error">{{ error }}</p>
        <button type="button" class="btn" @click="choose">Choose a folder</button>
      </div>

      <div v-else-if="unfinishedScan" class="library__center">
        <AppIcon name="alert" :size="30" />
        <p class="library__lead">{{ dirName }} was still being read when this page last closed</p>
        <div class="library__stall">
          <p v-if="unfinishedScan.scanned" class="library__hint">
            It had reached <strong>{{ count(unfinishedScan.scanned) }} entries</strong><span
              v-if="unfinishedScan.elapsed"> after {{ duration(unfinishedScan.elapsed) }}</span>,
            and the end never arrived.
          </p>
          <p class="library__hint">
            So it is not opened again on its own. A folder that takes an hour to list cannot be
            called off once it starts, and it holds up every tab in the browser while it runs —
            a page that reopened it on each launch would spend that hour again on the way to
            recovering from it.
          </p>
          <p class="library__hint library__hint--warn">
            Choose the folder again to have another go, ideally when the drive it lives on is
            not busy. Nothing else on this page will start it.
          </p>
        </div>
        <div class="library__actions">
          <button type="button" class="btn btn--accent" @click="choose">
            <AppIcon name="folder" :size="17" />
            <span>Choose folder</span>
          </button>
        </div>
      </div>

      <div v-else-if="slowFolder" class="library__center">
        <AppIcon name="alert" :size="30" />
        <p class="library__lead">{{ dirName }} listed slowly last time</p>
        <div class="library__stall">
          <p class="library__hint">
            It came back at <strong>{{ count(slowFolder.rate) }} entries a second</strong>, which
            for a folder this size means minutes rather than seconds.
          </p>
          <p class="library__hint">
            That is usually the disk being busy at that moment rather than anything about the
            folder — a camera writing a clip to the same drive is enough to do it, and the same
            folder often lists twenty times faster a minute later. Worth another go.
          </p>
          <p class="library__hint library__hint--warn">
            If it is slow again, note that it cannot be called off once started: the work happens
            inside Chrome rather than in this page, so closing the tab does not stop it. Quitting
            Chrome does.
          </p>
        </div>
        <div class="library__actions">
          <button type="button" class="btn btn--accent" @click="refresh(true)">Try again</button>
          <button type="button" class="btn" @click="choose">Choose another folder</button>
        </div>
      </div>

      <div v-else-if="needsPermission" class="library__center">
        <AppIcon name="folder" :size="30" />
        <p>Reopen <strong>{{ needsPermission.name }}</strong>?</p>
        <p class="library__hint">Browsers ask again for folder access after a reload.</p>
        <div class="library__actions">
          <button type="button" class="btn btn--accent" @click="regrant">Reopen</button>
          <button type="button" class="btn" @click="choose">Choose another</button>
        </div>
      </div>

      <div v-else-if="!total" class="library__center">
          <AppIcon name="library" :size="34" />
          <p class="library__lead">Browse a folder of recordings</p>
          <p class="library__hint">
              Every <code>.bvr</code> and <code>.mp4</code> file in the folder is listed with a thumbnail from its first
              key frame.
          </p>
          <p class="library__hint">
              NOTE 1: Your web browser might ask for permission to upload files to the "site",
              but that is just the standard warning for granting folder browser permission.  This app
              does not upload anything anywhere.
          </p>
          <p class="library__hint">
              NOTE 2: It is recommended to not open very large folders over network shares; that is very slow and may cause the browser to become unresponsive, requiring you to end the browser processes to recover.
          </p>
          <button type="button" class="btn btn--accent" @click="choose">
              <AppIcon name="folder" :size="17" />
              <span>Choose folder</span>
          </button>
          <p v-if="!supported" class="library__hint library__hint--warn">
              Folder browsing needs the page to be served over http(s). Opened straight off disk,
              the player can still open one file at a time.
          </p>
      </div>

      <p v-else-if="!matched" class="library__center">Nothing matches “{{ query }}”.</p>

      <div v-else class="library__virt" :style="{ height: totalHeight + 'px' }">
        <div
          v-for="row in window"
          :key="row.i"
          class="library__row"
          :class="row.head ? 'library__row--head' : (view === 'grid' ? 'library__row--items' : 'library__row--rows')"
          :style="{ transform: `translateY(${row.top}px)` }"
        >
          <h3 v-if="row.head" class="library__dayhead">
            {{ row.head }}
            <span class="library__daycount">{{ count(row.count) }}</span>
          </h3>
          <ul
            v-else
            class="library__items"
            :class="view === 'grid' ? 'library__items--grid' : 'library__items--list'"
            :style="gridStyle"
          >
            <li v-for="clip in row.clips" :key="clip.name">
              <button
                type="button"
                class="clip"
                :class="{ 'clip--current': clip.name === currentName }"
                @click="$emit('open', clip)"
              >
                <span class="clip__shot">
                  <img v-if="thumbOf(clip) && thumbOf(clip).thumbUrl" :src="thumbOf(clip).thumbUrl" :alt="''" />
                  <span v-else-if="thumbOf(clip)" class="clip__noshot">
                    <AppIcon name="film" :size="22" />
                  </span>
                  <span v-else class="clip__pending"></span>
                  <span v-if="info(clip).durationMs" class="clip__badge">{{ formatTime(info(clip).durationMs, false) }}</span>
                </span>
                <span class="clip__meta">
                  <span class="clip__camera">{{ displayCamera(clip.camera) }}</span>
                  <span class="clip__time">{{ clipTime(clip) }}</span>
                  <span class="clip__detail">{{ detail(clip) }}</span>
                </span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <input
      ref="dirInput"
      class="hidden-input"
      type="file"
      webkitdirectory
      directory
      multiple
      @change="onDirInput"
    />
  </div>
</template>

<script>
import AppIcon from './AppIcon.vue'
import { formatBytes, formatTime, formatUtc } from '../util/format.js'
import { displayCamera, isTimeSort, needsFileSize, sortClips, SORTS } from '../library/bvrName.js'
import { buildRows, columnsFor, measureRows, rowAt } from '../library/clipRows.js'
import {
  canBrowseDirectories, canPickDirectory, directoryPermission, entriesFromFileList,
  entriesFromNames, hydrate, hydrateAll, isHydrated, listDirectory, releaseEntry
} from '../library/directory.js'
import { ThumbService } from '../library/thumbService.js'
import {
  clearListing, clearScanMark, clearSlowFolder, getSlowFolder, getUnfinishedScan,
  loadDirectoryHandle, loadListing, markScanStarted, markSlowFolder, saveDirectoryHandle,
  saveListing
} from '../library/thumbCache.js'

// Rows kept rendered beyond each edge of the viewport. Enough that a flick of
// the wheel lands on something already in the document, few enough that a fast
// scroll is not building rows nobody will see.
const OVERSCAN = 3

// Rows beyond the viewport that are worth a *thumbnail*, which is a much smaller
// number than the rows worth rendering. A rendered row costs a few elements; a
// thumbnail costs a file read and a key-frame decode, and every one of those
// spent on a row nobody can see is one the row being looked at is waiting for.
// One row either side is enough that a scroll of a single line lands on pictures
// that are already there.
const THUMB_OVERSCAN = 1

/**
 * Past this many directory entries, a cached listing is used instead of reading
 * the folder again.
 *
 * The cache exists for the folder that takes two minutes to enumerate, not the
 * one that takes half a second, and its price is a listing that does not show a
 * recording made since. Chrome's floor is about half a millisecond per entry
 * whatever the folder, so three thousand of them is under two seconds on a busy
 * network share and imperceptible on a local disk -- at that size the trade is
 * simply not worth making, and the disk is asked every time. It is also the same
 * size the listing already calls small enough to read whole up front
 * (`EAGER_STAT_LIMIT`), counted in entries rather than recordings.
 */
const RELIST_LIMIT = 3000

// Concurrent `getFile()` calls for clips that have just scrolled into view.
// These are latency, not throughput -- over SMB a single one costs about as much
// as a dozen overlapped.
const STAT_WIDTH = 12

// Typing quiet before the filter is applied. Long enough that a word typed at
// speed is filtered once, short enough to feel like it happens as you type.
const FILTER_DELAY = 120

// `.library__body` side padding, which the grid has to fit inside.
const BODY_PAD = 16

// When to stop pretending a folder scan is nearly done. Below this many entries
// a second, after this long, it is not slow -- it is not going to finish.
// How often the growing listing is redrawn mid-scan. Each redraw re-sorts
// everything arrived so far, so this trades a little of the scan's throughput
// for a list that visibly fills rather than sitting behind a spinner.
const PROGRESS_RENDER_MS = 1000

const SLOW_AFTER_MS = 12000
const SLOW_RATE = 400

// How often the "this walk has not finished" record is brought up to date while
// a folder is being read. It is not shown to anyone until the next page load, so
// it is written rarely -- often enough to say roughly how far the walk got, and
// no more.
const SCAN_MARK_MS = 5000

export default {
  name: 'FolderBrowser',
  components: { AppIcon },
  props: {
    view: { type: String, default: 'grid' },
    sort: { type: String, default: 'time-desc' },
    currentName: { type: String, default: '' }
  },
  emits: ['close', 'open', 'patch', 'notice', 'folder'],
  data () {
    return {
      dirName: '',
      dirHandle: null,
      loading: false,
      error: '',
      needsPermission: null,
      // Set when this folder has already been found ruinous to list, which is
      // the one thing worth remembering about a folder.
      slowFolder: null,
      // Set when the last walk of this folder was never seen to finish, and so
      // must not be started again by anything but a deliberate choice.
      unfinishedScan: null,
      // When the listing on screen came out of the cache rather than the disk.
      listedAt: 0,
      // A directory walk is in progress. Names keep arriving; nothing else about
      // the folder can be read until it ends.
      scanning: false,
      query: '',
      // A long-running read, either of the folder itself or of the metadata a
      // sort needs. Null when nothing is going on.
      task: null,
      total: 0,
      matched: 0,
      // Only these three describe what is on screen. The listing itself is not
      // reactive -- see `created`.
      columns: 1,
      totalHeight: 0,
      window: [],
      // Bumped when a thumbnail or a file size arrives, which is what makes the
      // rendered window pick them up without the listing being reactive.
      tick: 0,
      sorts: SORTS,
      supported: canBrowseDirectories()
    }
  },
  computed: {
    canRefresh () { return !!this.dirHandle },
    countLabel () {
      if (this.query.trim() && this.matched !== this.total) {
        return `${this.count(this.matched)} of ${this.count(this.total)}`
      }
      return this.count(this.total)
    },
    /** How old the listing on screen is, when it came from the cache. */
    listedAge () {
      if (!this.listedAt || !this.total) return ''
      const mins = Math.floor((Date.now() - this.listedAt) / 60000)
      if (mins < 2) return ''
      if (mins < 60) return `listed ${mins} min ago`
      const hours = Math.round(mins / 60)
      if (hours < 24) return `listed ${hours} h ago`
      return `listed ${Math.round(hours / 24)} d ago`
    },
    taskPercent () {
      if (!this.task || !this.task.total) return 0
      return Math.round((this.task.done / this.task.total) * 100)
    },
    /**
     * Whether this folder is listing so slowly that saying so is kinder than
     * leaving a spinner up.
     *
     * Chrome checks every directory entry against a safety list as it iterates,
     * and on a network share that check is a round trip each time -- tens of
     * milliseconds per entry, against a fraction of one locally. A folder with
     * six figures of files in it then takes not minutes but hours, and no amount
     * of care on this side of the API changes that.
     */
    scanIsSlow () {
      const t = this.task
      return !!(this.loading && t && t.rate && t.elapsed > SLOW_AFTER_MS && t.rate < SLOW_RATE)
    },
    gridStyle () {
      if (this.view !== 'grid') return null
      return { gridTemplateColumns: `repeat(${this.columns}, minmax(0, 1fr))` }
    }
  },
  watch: {
    // The app writes snapshots into whichever folder is open, so it has to be
    // told when that changes -- including on the first restore, before anyone
    // has clicked anything.
    dirHandle (handle) {
      this.$emit('folder', handle || null)
    },
    sort () { this.applySort() },
    // Remembered the moment it is known, rather than at the end: the end of a
    // scan like this one may be an hour away, and the page may be long gone.
    scanIsSlow (slow) {
      if (slow && this.task) {
        markSlowFolder(this.dirName, { rate: this.task.rate, scanned: this.task.scanned })
      }
    },
    view () { this.relayout() },
    query () {
      clearTimeout(this.filterTimer)
      this.filterTimer = setTimeout(() => this.applyFilter(), FILTER_DELAY)
    }
  },
  created () {
    this.service = new ThumbService()

    // None of this is reactive, deliberately. A folder can hold a hundred
    // thousand recordings, and handing that array to Vue would mean a proxy per
    // entry and a dependency per field read -- paid on every scroll, for rows
    // that are not even in the document. What the template renders is `window`,
    // which is a couple of dozen rows; everything else is plain data that the
    // component recomputes itself and republishes through `window` and `tick`.
    this.all = []          // every recording in the folder, in sorted order
    this.clips = []        // the ones the filter box lets through, same order
    this.rows = []         // headings and grid lines, flat
    this.offsets = null    // where each row sits, cumulative
    this.range = { first: -1, last: -1 }
    // The rows the viewport actually covers, as opposed to the rows rendered
    // around it. Thumbnail priority is decided from this and nothing else.
    this.visible = { first: -1, last: -1 }
    this.lastTop = 0
    this.scrollingDown = true
    this.metrics = { head: 46, item: 220 }
    this.metricSig = ''
    this.wanted = new Map() // name -> clip, for everything currently on screen
    this.statActive = 0
    this.hydratedAll = false
    // Two scans, two scopes. Reading the folder and reading every file's size
    // are both cancellable and both long, but one must never cancel the other:
    // changing the sort while a folder is still listing would otherwise abandon
    // the listing.
    this.scanCtl = null
    this.sizeCtl = null
    this.filterTimer = 0
    this.scrollPending = false
    this.tickPending = false
  },
  async mounted () {
    // A resize that only changed the height leaves every row where it was;
    // only a change of width can move anything.
    this.resizeObserver = new ResizeObserver(() => this.relayout(false))
    this.resizeObserver.observe(this.$refs.scroll)
    await this.restore()
  },
  beforeUnmount () {
    clearTimeout(this.filterTimer)
    if (this.resizeObserver) this.resizeObserver.disconnect()
    this.cancelScan()
    this.service.dispose()
  },
  methods: {
    formatBytes,
    formatTime,
    displayCamera,
    count (n) { return Number(n || 0).toLocaleString() },
    /** A rough length in words, for a sentence rather than for a clock. */
    duration (ms) {
      const secs = Math.round((ms || 0) / 1000)
      if (secs < 90) return `${secs} seconds`
      const mins = Math.round(secs / 60)
      return mins < 90 ? `${mins} minutes` : `${Math.round(mins / 60)} hours`
    },
    /** What has been learned by opening the clip, as opposed to reading its name. */
    info (clip) {
      const t = this.thumbOf(clip)
      return (t && t.info) || {}
    },
    thumbOf (clip) {
      // Reading `tick` is what subscribes this render to results arriving; the
      // service's own store is a plain Map.
      void this.tick
      return clip.key ? this.service.get(clip.key) : null
    },
    clipTime (clip) {
      const known = this.info(clip).startUtc || clip.startUtc
      if (!known) return clip.name
      return formatUtc(known, false)
    },
    detail (clip) {
      const i = this.info(clip)
      const bits = []
      if (i.width) bits.push(`${i.width}×${i.height}`)
      if (i.fourcc) bits.push(i.fourcc)
      if (i.hasAudio) bits.push('audio')
      if (isHydrated(clip)) bits.push(formatBytes(clip.size))
      return bits.join(' · ')
    },

    // ------------------------------------------------------------ directories
    async restore () {
      if (!canPickDirectory()) return
      const handle = await loadDirectoryHandle()
      if (!handle) return
      // Asked before the permission check, and long before anything is read: a
      // walk this page never saw the end of is the one case where reopening the
      // last folder is worse than not opening anything. Restoring it would start
      // an enumeration that cannot be called off, on the folder already known to
      // take an hour of it -- every launch, for as long as it kept failing. The
      // handle is deliberately left unset, so the only way on is the picker.
      this.unfinishedScan = await getUnfinishedScan(handle.name)
      if (this.unfinishedScan) {
        this.dirName = handle.name
        return
      }
      const state = await directoryPermission(handle, false)
      if (state === 'granted') {
        this.dirHandle = handle
        this.dirName = handle.name
        await this.refresh()
      } else if (state === 'prompt') {
        // Re-granting needs a gesture, so this becomes a button rather than a
        // prompt nobody asked for.
        this.needsPermission = handle
      }
    },
    async regrant () {
      const handle = this.needsPermission
      if (!handle) return
      const state = await directoryPermission(handle, true)
      if (state !== 'granted') {
        this.$emit('notice', 'Folder access was not granted.')
        return
      }
      this.needsPermission = null
      this.dirHandle = handle
      this.dirName = handle.name
      await this.refresh()
    },
    async choose () {
      this.needsPermission = null
      if (!canPickDirectory()) {
        this.$refs.dirInput.click()
        return
      }
      let picked = null
      try {
        picked = await window.showDirectoryPicker({ id: 'bvr-clips', mode: 'read' })
      } catch (e) {
        if (e && e.name === 'AbortError') return
        // A browser that has the picker but refuses it here still has the input.
        this.$refs.dirInput.click()
        return
      }
      this.dirHandle = picked
      this.dirName = picked.name
      // Picking a folder by hand is the deliberate choice a refusal was waiting
      // for, whatever the last walk of it did.
      this.unfinishedScan = null
      await clearScanMark(picked.name)
      saveDirectoryHandle(picked)
      await this.refresh()
    },
    onDirInput (event) {
      const files = event.target.files
      if (files && files.length) {
        const entries = entriesFromFileList(files)
        this.unfinishedScan = null
        this.dirName = this.folderNameOf(files)
        this.dirHandle = null
        this.setEntries(entries)
        if (!entries.length) this.error = 'That folder holds no recordings.'
      }
      event.target.value = ''
    },
    /** webkitRelativePath is "<folder>/<file>", which is the only name on offer. */
    folderNameOf (files) {
      const path = files[0] && files[0].webkitRelativePath
      return path ? path.split('/')[0] : 'Selected folder'
    },
    /**
     * Puts a listing on screen, from the cache when there is one.
     *
     * `force` is Refresh, and the way past both the cache and the note about
     * this folder having been slow.
     */
    async refresh (force = false) {
      if (!this.dirHandle) return
      if (!force) {
        const cached = await loadListing(this.dirName)
        if (cached && cached.names.length) {
          if (!this.worthRelisting(cached)) {
            // Enumerating is the expensive part and it has already been paid for.
            this.slowFolder = null
            this.listedAt = cached.savedAt || 0
            this.setEntries(entriesFromNames(cached.names, this.dirHandle))
            return
          }
          // Small enough to simply read again -- and the slow-folder question
          // does not arise, because the listing being replaced is itself the
          // record of what this folder costs to enumerate.
        } else {
          // Asked before anything is started, because once an enumeration is
          // under way there is no calling it back.
          this.slowFolder = await getSlowFolder(this.dirName)
          if (this.slowFolder) return
        }
      }
      this.slowFolder = null
      this.unfinishedScan = null
      this.listedAt = 0
      await clearSlowFolder(this.dirName)
      // Written before the walk begins rather than when it goes wrong, because
      // the ways it goes wrong -- the tab closed, the browser killed to get it
      // back -- are exactly the ones that leave no chance to write anything. The
      // record is removed below only if the walk returns; one left behind is
      // what stops this folder being opened again on its own.
      await markScanStarted(this.dirName)
      const signal = this.newScan()
      this.loading = true
      this.scanning = true
      this.lastScanMark = Date.now()
      this.lastProgressRender = 0
      this.error = ''
      this.task = { label: 'Reading folder…', done: 0, total: 0 }
      // Entries walked, not recordings kept: it is what listing this folder
      // again would cost, and so what decides whether it is worth caching.
      let scanned = 0
      try {
        const entries = await listDirectory(this.dirHandle, {
          signal,
          onProgress: (p) => {
            scanned = p.scanned
            this.task = {
              label: 'Reading folder…',
              done: p.kept,
              total: 0,
              scanned: p.scanned,
              elapsed: p.elapsed,
              rate: p.elapsed > 400 ? Math.round(p.scanned / (p.elapsed / 1000)) : 0
            }
            this.noteScanProgress(p)
            this.showProgress(p.entries)
          }
        })
        // Only here: the walk reached the end, and this folder is safe to open
        // by itself again.
        await clearScanMark(this.dirName)
        this.setEntries(entries)
        if (entries.length) {
          this.listedAt = Date.now()
          saveListing(this.dirName, entries.map((e) => e.name), scanned)
        } else {
          this.error = 'That folder holds no recordings.'
          clearListing(this.dirName)
        }
      } catch (e) {
        // A cancelled scan is a choice, not a failure; it just leaves nothing.
        if (e && e.name === 'AbortError') this.setEntries([])
        else this.error = `Could not read the folder: ${(e && e.message) || e}`
      } finally {
        this.loading = false
        this.scanning = false
        this.task = null
        // Reading anything about a clip was pointless until now; this is the
        // moment it becomes possible.
        this.pump()
      }
    },
    /**
     * Whether a cached listing is small enough that reading the folder again
     * beats trusting it.
     *
     * A folder of a few hundred recordings comes back in well under a second,
     * and the whole cost of the cache is falling behind: a clip recorded since
     * is simply missing until someone thinks to press Refresh. There is no
     * reason to make a small folder pay that -- the optimisation exists for the
     * six-figure folder that takes two minutes, and nothing else.
     *
     * Judged on entries scanned rather than recordings kept, because that is
     * where the cost actually lands and Blue Iris writes a `.dat` beside every
     * clip. A listing saved before that number was recorded falls back to the
     * count of names, which under-counts and so errs towards keeping the cache.
     */
    worthRelisting (cached) {
      return (cached.scanned || cached.names.length) <= RELIST_LIMIT
    },
    /**
     * Keeps the record of the walk in progress roughly current, so that a page
     * that never sees the end of it still leaves something to say about how far
     * it got. Throttled hard: this is a note for the next page load, not a
     * display, and the walk it describes has no throughput to spare.
     */
    noteScanProgress (p) {
      const now = Date.now()
      if (now - (this.lastScanMark || 0) < SCAN_MARK_MS) return
      this.lastScanMark = now
      markScanStarted(this.dirName, { scanned: p.scanned, elapsed: p.elapsed })
    },
    /**
     * Puts what has arrived so far on screen, while the rest is still coming.
     *
     * Only the names are available during a scan -- sizes, durations and
     * thumbnails all need `getFileHandle`, and that blocks until the walk ends
     * (measured: 48 s on a 223,000-entry folder, exactly one full pass). So this
     * is a list to read and search, not yet one to play from, and re-sorting a
     * six-figure array is not something to do on every batch either.
     */
    showProgress (entries) {
      if (!entries || !entries.length) return
      const now = Date.now()
      if (now - (this.lastProgressRender || 0) < PROGRESS_RENDER_MS) return
      this.lastProgressRender = now
      this.all = entries
      this.total = entries.length
      sortClips(this.all, this.sort)
      // Never yanks the view back to the top: someone may be reading it.
      this.applyFilter(false)
    },
    /** Replaces any listing in flight, and hands back the signal for the new one. */
    newScan () {
      if (this.scanCtl) this.scanCtl.abort()
      this.scanCtl = new AbortController()
      return this.scanCtl.signal
    },
    /** The same, for the bulk metadata pass. Only ever one of the two is live. */
    newSizeScan () {
      if (this.sizeCtl) this.sizeCtl.abort()
      this.sizeCtl = new AbortController()
      return this.sizeCtl.signal
    },
    cancelScan () {
      if (this.scanCtl) this.scanCtl.abort()
      if (this.sizeCtl) this.sizeCtl.abort()
    },
    /**
     * The metadata pass only, which is the only one of the two a button can
     * honestly offer to stop -- see the commented-out Stop in the template.
     * Aborting the directory walk as well would abandon a listing that is still
     * arriving and still cost the browser the rest of the enumeration anyway.
     */
    cancelSizes () {
      if (this.sizeCtl) this.sizeCtl.abort()
    },
    setEntries (entries) {
      // Whatever a metadata pass was filling in, it was filling in the listing
      // that is being replaced.
      if (this.sizeCtl) this.sizeCtl.abort()
      this.all = entries
      this.total = entries.length
      // Whether anything is left to fill in later, asked of the listing rather
      // than assumed from where it came: a small folder is read whole up front,
      // and the `webkitdirectory` route has every size in hand whatever its
      // size. `every` stops at the first unread entry, which in a lazy listing
      // is the first one.
      this.hydratedAll = entries.every(isHydrated)
      this.wanted.clear()
      this.error = ''
      this.applySort()
    },

    // -------------------------------------------------------------- the listing
    /**
     * Orders the whole listing, once.
     *
     * Doing it here rather than per keystroke is the point: the filter is a
     * subset of an array that is already in order, so typing never re-sorts.
     */
    async applySort () {
      if (needsFileSize(this.sort)) await this.readAllSizes()
      sortClips(this.all, this.sort)
      this.applyFilter()
    },
    /**
     * Sorting by size is the one view that wants something no file name can
     * say, for clips nobody has looked at. It is the only thing that brings back
     * the per-file round trip the listing exists to avoid, so it is done once,
     * on request, with a progress bar and a way out.
     */
    async readAllSizes () {
      if (this.hydratedAll || !this.all.length) return
      const signal = this.newSizeScan()
      const label = 'Reading file sizes…'
      // `cancellable` because this one is: it is a loop of this page's own, and
      // unlike the directory walk it stops when it is told to.
      this.task = { label, done: 0, total: this.all.length, cancellable: true }
      try {
        await hydrateAll(this.all, {
          signal,
          onProgress: (done, total) => {
            this.task = { label, done, total, cancellable: true }
            this.bump()
          }
        })
        this.hydratedAll = true
      } catch {
        // Cancelled: sort on whatever was read, which is the honest answer.
      } finally {
        this.task = null
      }
    },
    applyFilter (resetScroll = true) {
      const q = this.query.trim().toLowerCase()
      // `search` is the name pre-lowered at listing time, and the camera is a
      // slice of the name, so one `includes` covers both.
      this.clips = q ? this.all.filter((e) => e.search.includes(q)) : this.all
      this.matched = this.clips.length
      // A different set of results is a different list, and the top of it is
      // what was asked for. Left alone, the browser only clamps the scroll
      // position to the new bottom, which lands on the oldest match.
      if (resetScroll && this.$refs.scroll) this.$refs.scroll.scrollTop = 0
      this.relayout()
    },

    // ------------------------------------------------------------ the geometry
    /**
     * Rebuilds the row model and everything downstream of it.
     *
     * Called whenever what is being shown changes shape: a new listing, a new
     * filter, a different sort or view, or the window being resized.
     */
    relayout (force = true) {
      const el = this.$refs.scroll
      if (!el) return
      const width = Math.max(0, el.clientWidth - BODY_PAD * 2)
      if (!width) return
      const columns = columnsFor(width, this.view)
      const sig = `${this.view}:${columns}:${Math.round(width)}`
      // Nothing about the shape of a row changed and the listing is the one the
      // rows were built from, so there is nothing to rebuild.
      if (sig === this.metricSig && !force) { this.updateWindow(); return }

      this.columns = columns
      // Row heights come out of the stylesheet, not out of here, so this is only
      // a first guess -- `calibrate` replaces it with what was actually laid out.
      if (sig !== this.metricSig) {
        this.metricSig = sig
        this.metrics = { head: 46, item: this.estimateRow(width) }
      }

      this.rows = buildRows(this.clips, { grouped: isTimeSort(this.sort), columns: this.columns })
      this.applyMetrics()
      this.$nextTick(() => this.calibrate(0))
    },
    estimateRow (width) {
      if (this.view !== 'grid') return 96
      const gap = 12
      const col = (width - gap * (this.columns - 1)) / this.columns
      // A 4:3 still, the gap under it, and three lines of caption.
      return Math.round(col * 0.75) + 8 + 50 + gap
    },
    applyMetrics () {
      this.offsets = measureRows(this.rows, this.metrics.head, this.metrics.item)
      this.totalHeight = this.offsets[this.rows.length]
      this.range.first = -1
      this.visible.first = this.visible.last = -1
      this.updateWindow()
    },
    /**
     * Replaces the guessed row heights with the real ones.
     *
     * Nothing here knows what a caption line or a heading actually measures --
     * that is the stylesheet's business, and it changes with the font the
     * viewer's browser picked. So the first rows to be laid out are measured and
     * the scroll height corrected, keeping whatever was at the top at the top.
     */
    calibrate (attempt) {
      const el = this.$refs.scroll
      if (!el || !this.rows.length) return
      const item = el.querySelector('.library__row--items, .library__row--rows')
      const head = el.querySelector('.library__row--head')
      let changed = false
      if (item && Math.abs(item.offsetHeight - this.metrics.item) > 0.5) {
        this.metrics.item = item.offsetHeight
        changed = true
      }
      if (head && Math.abs(head.offsetHeight - this.metrics.head) > 0.5) {
        this.metrics.head = head.offsetHeight
        changed = true
      }
      if (!changed) return
      const anchor = Math.max(0, this.range.first)
      this.applyMetrics()
      this.$nextTick(() => {
        if (anchor > 0 && this.offsets) el.scrollTop = this.offsets[anchor]
        this.updateWindow()
        // A corrected height can bring a differently-sized row into view; two
        // more passes settle it, and it converges long before that in practice.
        if (attempt < 2) this.$nextTick(() => this.calibrate(attempt + 1))
      })
    },
    onScroll () {
      // One recompute per frame however many scroll events the browser sends.
      if (this.scrollPending) return
      this.scrollPending = true
      requestAnimationFrame(() => {
        this.scrollPending = false
        this.updateWindow()
      })
    },
    /** Works out which rows the viewport covers, and renders exactly those. */
    updateWindow () {
      const el = this.$refs.scroll
      if (!el || !this.offsets || !this.rows.length) {
        this.window = []
        this.range.first = this.range.last = -1
        return
      }
      const top = Math.max(0, el.scrollTop)
      // The rows the viewport covers, before the rendering overscan is added.
      // Which rows are *visible* is the whole of what thumbnail priority is
      // decided from, so it is kept apart from which rows are in the document.
      const vFirst = rowAt(this.offsets, top)
      const vLast = rowAt(this.offsets, top + el.clientHeight)
      const first = Math.max(0, vFirst - OVERSCAN)
      const last = Math.min(this.rows.length - 1, vLast + OVERSCAN)
      const sameRows = first === this.range.first && last === this.range.last
      const sameVisible = vFirst === this.visible.first && vLast === this.visible.last
      // A scroll that moved the viewport without changing which rows are in the
      // document still changed what is on screen, and so what to fetch first.
      if (sameRows && sameVisible) return
      // Which way the list is going decides which side of it is worth reading
      // ahead into.
      if (top !== this.lastTop) this.scrollingDown = top > this.lastTop
      this.lastTop = top
      this.visible.first = vFirst
      this.visible.last = vLast
      this.range.first = first
      this.range.last = last

      if (!sameRows) {
        const out = []
        for (let i = first; i <= last; i++) {
          const row = this.rows[i]
          if (row.head) out.push({ i, head: row.head, count: row.count, top: this.offsets[i] })
          else out.push({ i, head: '', top: this.offsets[i], clips: this.clips.slice(row.start, row.end) })
        }
        this.window = out
      }
      this.pump()
    },

    // -------------------------------------------------------------- thumbnails
    /**
     * Points the thumbnail machinery at what is on screen and away from what is
     * not.
     *
     * With only the visible rows in the document there is no need to ask the
     * layout engine what is visible -- the window *is* the answer, and it is
     * already computed.
     */
    pump () {
      const next = new Map()
      // Insertion order is priority order from here on: `fill` walks the map and
      // hands each clip its rank, and the service serves the best rank first.
      for (const clip of this.thumbOrder()) next.set(clip.name, clip)
      for (const [name, clip] of this.wanted) {
        if (next.has(name)) continue
        if (clip.key) this.service.cancel(clip.key)
        // Whatever this clip made the browser process hold, it no longer needs
        // to hold. The picture itself is kept -- that is the service's cache,
        // and it lives in this process.
        releaseEntry(clip)
      }
      this.wanted = next
      this.fill()
    },
    /**
     * The clips worth a thumbnail, most urgent first.
     *
     * What is on screen comes first, in reading order, and then a row either
     * side of it so a scroll of one line lands on pictures that are already
     * there. Rows further out are still *rendered* -- the document keeps a few
     * beyond the fold so a flick has something to land on -- but they are not
     * asked for at all: a file read and a key-frame decode spent three rows off
     * screen is one the row being looked at is waiting for.
     *
     * Order alone is not enough, because a thumbnail can take a second or more
     * and only two or three run at a time. So the rank each clip gets here is
     * handed to the service, which serves the best rank in its queue rather than
     * the most recent request. Without that, a clip queued a frame later from
     * below the fold outranks one in the middle of the screen -- which is
     * exactly the arbitrary-looking order this replaces.
     */
    thumbOrder () {
      const rows = []
      for (const row of this.window) {
        if (!row.clips) continue
        const distance = Math.max(0, this.visible.first - row.i, row.i - this.visible.last)
        if (distance > THUMB_OVERSCAN) continue
        rows.push({ row, distance, above: row.i < this.visible.first })
      }
      rows.sort((a, b) =>
        a.distance - b.distance ||
        // Off screen, the way the list is moving decides which side goes first.
        (this.scrollingDown ? Number(a.above) - Number(b.above) : Number(b.above) - Number(a.above)) ||
        a.row.i - b.row.i)
      const out = []
      for (const r of rows) for (const clip of r.row.clips) out.push(clip)
      return out
    },
    /**
     * Starts work for the wanted clips, in rank order, up to the concurrency
     * bounds.
     *
     * Each pass reads the *current* window, so scrolling past a screenful
     * abandons it rather than queueing it: whatever has not been started yet is
     * simply never picked.
     */
    fill () {
      // Every one of these would queue behind the directory walk and land in a
      // heap when it finished. Nothing is gained by asking early.
      if (this.scanning) return
      let rank = 0
      for (const clip of this.wanted.values()) {
        const priority = rank++
        if (isHydrated(clip)) { this.want(clip, priority); continue }
        if (clip.statPromise) continue
        // Out of stat slots. Carrying on rather than stopping matters: the
        // clips further down this list may already be hydrated, and a picture
        // they could have had should not wait on a round trip for a clip that
        // happened to come first.
        if (this.statActive >= STAT_WIDTH) continue
        this.statActive++
        hydrate(clip)
          .then(() => {
            // The size now shows in the caption, and there is finally a cache
            // key to ask for a picture with.
            this.bump()
            // A stat that lands after its clip has scrolled away arrives too
            // late for `pump` to have released it -- there was nothing to
            // release when it looked. It has to be done here or not at all.
            if (this.wanted.has(clip.name)) this.want(clip, priority)
            else releaseEntry(clip)
          })
          .finally(() => { this.statActive--; this.fill() })
      }
    },
    want (clip, priority) {
      if (!clip.key || this.service.get(clip.key)) return
      this.service.request(clip, priority).then((result) => {
        if (result) this.bump()
        if (!this.wanted.has(clip.name)) releaseEntry(clip)
      })
    },
    /** One re-render a frame, however many results land in it. */
    bump () {
      if (this.tickPending) return
      this.tickPending = true
      requestAnimationFrame(() => { this.tickPending = false; this.tick++ })
    }
  }
}
</script>

<style scoped>
.library {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.library__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
  background: rgba(13, 16, 22, 0.96);
}

.library__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 34vw;
}

.library__count {
  color: var(--text-dim);
  font-size: 12px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.library__spacer {
  flex: 1 1 auto;
}

.library__search {
  width: min(230px, 40vw);
  padding: 5px 9px;
  border-radius: 7px;
  border: 1px solid var(--field-border);
  background: var(--field);
  color: var(--text);
  font: inherit;
  font-size: 13px;
}

.library__search:focus-visible,
.library__body :deep(.settings__select):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.library__task {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
  font-size: 12.5px;
  color: var(--text-dim);
}

.library__bar {
  flex: 1 1 auto;
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
}

.library__barfill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.2s linear;
}

.library__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 16px 28px;
}

.library__center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  max-width: 460px;
  margin: 8vh auto 0;
  text-align: center;
  color: var(--text-dim);
}

.library__center > .icon {
  color: var(--accent);
}

.library__lead {
  margin: 0;
  color: var(--text);
  font-size: 18px;
  font-weight: 600;
}

.library__hint {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
}

.library__hint--warn {
  color: var(--warn);
}

.library__hint code {
  padding: 1px 5px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.09);
}

.library__error {
  margin: 0;
  color: var(--danger);
  overflow-wrap: anywhere;
}

.library__actions {
  display: flex;
  gap: 8px;
}

.library__count--age {
  opacity: 0.72;
}

.library__stall {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px 14px;
  border-radius: 9px;
  border: 1px solid rgba(227, 179, 65, 0.35);
  background: rgba(227, 179, 65, 0.07);
  text-align: left;
}

/*
 * The full height of the listing, with only the rows on screen inside it. Each
 * row carries the space below it in its own padding, so a row's offset is the
 * plain sum of the heights before it and nothing has to account for gaps.
 */
.library__virt {
  position: relative;
}

.library__row {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
}

.library__row--head { padding: 16px 0 9px; }
.library__row--items { padding-bottom: 12px; }
.library__row--rows { padding-bottom: 5px; }

.library__dayhead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-dim);
}

.library__daycount {
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.09);
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}

.library__items {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.library__items--grid {
  grid-template-columns: repeat(auto-fill, minmax(212px, 1fr));
}

.library__items--list {
  grid-template-columns: 1fr;
  gap: 5px;
}

.clip {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.library__items--list .clip {
  flex-direction: row;
  align-items: center;
  gap: 11px;
  padding: 5px;
  border-radius: 9px;
}

.library__items--list .clip:hover {
  background: rgba(255, 255, 255, 0.07);
}

.clip__shot {
  position: relative;
  display: block;
  aspect-ratio: 4 / 3;
  border-radius: 9px;
  overflow: hidden;
  background: #0e1117;
  border: 1px solid rgba(255, 255, 255, 0.09);
  transition: border-color 0.14s ease, transform 0.14s ease;
}

.library__items--list .clip__shot {
  flex: 0 0 108px;
  width: 108px;
}

.clip:hover .clip__shot {
  border-color: rgba(88, 166, 255, 0.7);
}

.library__items--grid .clip:hover .clip__shot {
  transform: translateY(-2px);
}

.clip--current .clip__shot {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.clip__shot img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.clip__noshot,
.clip__pending {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--text-dim);
}

.clip__pending {
  background: linear-gradient(100deg, #0e1117 30%, #171c26 50%, #0e1117 70%);
  background-size: 220% 100%;
  animation: clip-shimmer 1.4s linear infinite;
}

@keyframes clip-shimmer {
  to { background-position: -220% 0; }
}

.clip__badge {
  position: absolute;
  right: 5px;
  bottom: 5px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.76);
  font: 500 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #e8eaed;
}

/*
 * A fixed height, not a natural one. The virtual list works out where every row
 * it is not rendering sits from the height of one it is, so a caption that grew
 * a line because a camera name wrapped would put every offset below it out.
 */
.clip__meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  height: 50px;
  overflow: hidden;
}

.clip__camera {
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.clip__time {
  color: var(--text-dim);
  font-size: 12px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.clip__detail {
  color: var(--text-dim);
  font-size: 11px;
  line-height: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.clip:focus-visible {
  outline: none;
}

.clip:focus-visible .clip__shot {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (max-width: 620px) {
  .library__title { max-width: 46vw; }
  .library__search { width: 100%; order: 5; }
}
</style>
