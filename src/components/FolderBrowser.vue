<template>
  <div class="library" role="dialog" aria-label="Recordings">
    <header class="library__head">
      <AppIcon name="library" :size="20" />
      <h2 class="library__title">{{ dirName || 'Recordings' }}</h2>
      <span v-if="entries.length" class="library__count">{{ filtered.length }} of {{ entries.length }}</span>

      <div class="library__spacer"></div>

      <input
        v-if="entries.length"
        v-model="query"
        class="library__search"
        type="search"
        placeholder="Filter by name or camera"
        aria-label="Filter recordings"
        @keydown.stop
      />

      <select v-if="entries.length" class="settings__select" :value="sort" aria-label="Sort" @change="$emit('patch', { librarySort: $event.target.value })">
        <option v-for="s in sorts" :key="s.value" :value="s.value">{{ s.label }}</option>
      </select>

      <button
        v-if="entries.length"
        type="button"
        class="ctl-btn ctl-btn--small"
        :title="view === 'grid' ? 'Switch to list' : 'Switch to grid'"
        :aria-label="view === 'grid' ? 'Switch to list' : 'Switch to grid'"
        @click="$emit('patch', { libraryView: view === 'grid' ? 'list' : 'grid' })"
      >
        <AppIcon :name="view === 'grid' ? 'list' : 'grid'" :size="18" />
      </button>

      <button v-if="canRefresh" type="button" class="ctl-btn ctl-btn--small" title="Refresh" aria-label="Refresh" @click="refresh">
        <AppIcon name="refresh" :size="18" />
      </button>

      <button type="button" class="btn btn--ghost" @click="choose">
        <AppIcon name="folder" :size="16" />
        <span>{{ entries.length ? 'Change folder' : 'Choose folder' }}</span>
      </button>

      <button type="button" class="ctl-btn ctl-btn--small" aria-label="Close" @click="$emit('close')">
        <AppIcon name="close" :size="18" />
      </button>
    </header>

    <div class="library__body" ref="scroll">
      <div v-if="loading" class="library__center">
        <div class="spinner"></div>
        <p>Reading {{ dirName }}…</p>
      </div>

      <div v-else-if="error" class="library__center">
        <AppIcon name="alert" :size="30" />
        <p class="library__error">{{ error }}</p>
        <button type="button" class="btn" @click="choose">Choose a folder</button>
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

      <div v-else-if="!entries.length" class="library__center">
        <AppIcon name="library" :size="34" />
        <p class="library__lead">Browse a folder of recordings</p>
        <p class="library__hint">
          Every <code>.bvr</code> file in the folder is listed with a thumbnail from its first
          key frame. Nothing is uploaded, and only a few hundred kilobytes of each file is read.
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

      <template v-else>
        <p v-if="!filtered.length" class="library__center">Nothing matches “{{ query }}”.</p>
        <section v-for="day in days" :key="day.key" class="library__day">
          <h3 class="library__dayhead">
            {{ day.label }}
            <span class="library__daycount">{{ day.clips.length }}</span>
          </h3>
          <ul class="library__items" :class="view === 'grid' ? 'library__items--grid' : 'library__items--list'">
            <li v-for="clip in day.clips" :key="clip.key">
              <button
                type="button"
                class="clip"
                :class="{ 'clip--current': clip.name === currentName }"
                :ref="(el) => observe(el, clip)"
                @click="$emit('open', clip)"
              >
                <span class="clip__shot">
                  <img v-if="thumbs[clip.key] && thumbs[clip.key].thumbUrl" :src="thumbs[clip.key].thumbUrl" :alt="''" loading="lazy" />
                  <span v-else-if="thumbs[clip.key]" class="clip__noshot">
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
        </section>
      </template>
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
import { displayCamera, groupByDay, sortClips, SORTS } from '../library/bvrName.js'
import {
  canBrowseDirectories, canPickDirectory, directoryPermission,
  entriesFromFileList, listDirectory, pickDirectory
} from '../library/directory.js'
import { ThumbService } from '../library/thumbService.js'
import { loadDirectoryHandle, saveDirectoryHandle } from '../library/thumbCache.js'

export default {
  name: 'FolderBrowser',
  components: { AppIcon },
  props: {
    view: { type: String, default: 'grid' },
    sort: { type: String, default: 'time-desc' },
    currentName: { type: String, default: '' }
  },
  emits: ['close', 'open', 'patch', 'notice'],
  data () {
    return {
      entries: [],
      thumbs: {},
      dirName: '',
      dirHandle: null,
      loading: false,
      error: '',
      needsPermission: null,
      query: '',
      sorts: SORTS,
      supported: canBrowseDirectories()
    }
  },
  computed: {
    canRefresh () { return !!this.dirHandle },
    filtered () {
      const q = this.query.trim().toLowerCase()
      if (!q) return this.entries
      return this.entries.filter((e) =>
        e.name.toLowerCase().includes(q) || e.camera.toLowerCase().includes(q))
    },
    days () {
      const sorted = sortClips(this.filtered, this.sort)
      // Only the time-ordered views group by day; sorting by name or size is a
      // request to see one flat list in that order.
      if (this.sort !== 'time-desc' && this.sort !== 'time-asc') {
        return [{ key: 'all', label: 'All recordings', clips: sorted }]
      }
      const groups = groupByDay(sorted)
      if (this.sort === 'time-asc') groups.reverse()
      return groups
    }
  },
  created () {
    this.service = new ThumbService()
    // Not reactive: the observer and its element map only ever drive requests.
    this.observer = null
    this.watched = new Map()
  },
  async mounted () {
    this.observer = new IntersectionObserver((records) => this.onVisible(records), {
      root: this.$refs.scroll,
      // Start a row before it arrives, so a thumbnail is usually there already.
      rootMargin: '320px 0px'
    })
    await this.restore()
  },
  beforeUnmount () {
    if (this.observer) this.observer.disconnect()
    this.service.dispose()
  },
  methods: {
    formatBytes,
    formatTime,
    displayCamera,
    info (clip) {
      const t = this.thumbs[clip.key]
      return (t && t.info) || {}
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
      bits.push(formatBytes(clip.size))
      return bits.join(' · ')
    },

    // ------------------------------------------------------------ directories
    async restore () {
      if (!canPickDirectory()) return
      const handle = await loadDirectoryHandle()
      if (!handle) return
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
      try {
        this.loading = true
        const { name, handle, entries } = await pickDirectory()
        this.dirHandle = handle
        this.dirName = name
        this.setEntries(entries)
        saveDirectoryHandle(handle)
      } catch (e) {
        if (e && e.name === 'AbortError') { this.loading = false; return }
        // A browser that has the picker but refuses it here still has the input.
        this.$refs.dirInput.click()
      } finally {
        this.loading = false
      }
    },
    onDirInput (event) {
      const files = event.target.files
      if (files && files.length) {
        const entries = entriesFromFileList(files)
        this.dirName = this.folderNameOf(files)
        this.dirHandle = null
        this.setEntries(entries)
        if (!entries.length) this.error = 'That folder holds no .bvr recordings.'
      }
      event.target.value = ''
    },
    /** webkitRelativePath is "<folder>/<file>", which is the only name on offer. */
    folderNameOf (files) {
      const path = files[0] && files[0].webkitRelativePath
      return path ? path.split('/')[0] : 'Selected folder'
    },
    async refresh () {
      if (!this.dirHandle) return
      this.loading = true
      this.error = ''
      try {
        this.setEntries(await listDirectory(this.dirHandle))
        if (!this.entries.length) this.error = 'That folder holds no .bvr recordings.'
      } catch (e) {
        this.error = `Could not read the folder: ${e.message}`
      } finally {
        this.loading = false
      }
    },
    setEntries (entries) {
      this.watched.clear()
      if (this.observer) this.observer.disconnect()
      this.entries = entries
      this.error = ''
      // Results already gathered stay valid -- the cache is keyed on identity,
      // not on position in a listing.
      this.thumbs = { ...this.thumbs }
    },

    // -------------------------------------------------------------- thumbnails
    observe (el, clip) {
      if (!el || !this.observer) return
      if (this.watched.get(el) === clip.key) return
      this.watched.set(el, clip.key)
      el.dataset.key = clip.key
      this.observer.observe(el)
    },
    onVisible (records) {
      for (const record of records) {
        const key = record.target.dataset.key
        const clip = this.entries.find((e) => e.key === key)
        if (!clip) continue
        if (record.isIntersecting) this.load(clip)
        else if (!this.thumbs[key]) this.service.cancel(key)
      }
    },
    async load (clip) {
      if (this.thumbs[clip.key]) return
      const result = await this.service.request(clip)
      if (!result) return
      // Replacing the object is what tells Vue a key was filled in.
      this.thumbs = { ...this.thumbs, [clip.key]: result }
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

.library__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 32px;
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

.library__day + .library__day {
  margin-top: 20px;
}

.library__dayhead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 9px;
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
  object-fit: cover;
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

.clip__meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.clip__camera {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.clip__time {
  color: var(--text-dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.clip__detail {
  color: var(--text-dim);
  font-size: 11px;
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
  .library__items--grid { grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); }
}
</style>
