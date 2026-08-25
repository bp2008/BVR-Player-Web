<template>
  <section
    class="panel"
    :class="{
      'panel--collapsed': collapsed && !popped,
      'panel--popped': popped,
      'panel--dragging': dragging,
      'panel--active': active
    }"
    :style="popped ? null : { order: order }"
    @pointerdown.capture="$emit('activate')"
  >
    <header
      class="panel__head"
      :title="popped ? '' : 'Drag to the other side of the window, or double-click to send it there'"
      @pointerdown="onGrip"
      @dblclick="onHeadDblClick"
    >
      <AppIcon v-if="!popped" class="panel__grip" name="grip" :size="16" />
      <AppIcon class="panel__icon" :name="icon" :size="16" />
      <h2 class="panel__title">{{ title }}</h2>

      <button
        v-if="!popped"
        type="button"
        class="panel__btn"
        :title="collapsed ? 'Expand' : 'Collapse'"
        :aria-label="collapsed ? 'Expand panel' : 'Collapse panel'"
        :aria-expanded="collapsed ? 'false' : 'true'"
        @pointerdown.stop
        @click.stop="$emit('toggle')"
      >
        <AppIcon :name="collapsed ? 'caretDown' : 'caretUp'" :size="16" />
      </button>

      <button
        type="button"
        class="panel__btn"
        :title="popped ? 'Put this panel back in the window' : 'Move this panel to its own window'"
        :aria-label="popped ? 'Dock panel' : 'Pop panel out'"
        @pointerdown.stop
        @click.stop="$emit('popout')"
      >
        <AppIcon :name="popped ? 'dockIn' : 'popOut'" :size="15" />
      </button>

      <button
        type="button"
        class="panel__btn"
        title="Close"
        aria-label="Close panel"
        @pointerdown.stop
        @click.stop="$emit('close')"
      >
        <AppIcon name="close" :size="16" />
      </button>
    </header>

    <div v-if="!collapsed || popped" class="panel__body">
      <slot />
    </div>
  </section>
</template>

<script>
import AppIcon from './AppIcon.vue'

// Past this a press on the title bar is a drag, not a click on the header.
const DRAG_SLOP = 5

/**
 * The chrome every docked panel wears: title bar, collapse, pop-out, close.
 *
 * The drag itself is only *detected* here -- where it may be dropped is a
 * question about the docks, which this component cannot see. It reports raw
 * pointer positions and lets the layout owner decide what they mean.
 */
export default {
  name: 'PanelFrame',
  components: { AppIcon },
  props: {
    title: { type: String, required: true },
    icon: { type: String, default: 'layers' },
    order: { type: Number, default: 0 },
    collapsed: { type: Boolean, default: false },
    popped: { type: Boolean, default: false },
    active: { type: Boolean, default: false }
  },
  emits: ['close', 'toggle', 'popout', 'activate', 'flip', 'drag-start', 'drag-move', 'drag-end'],
  data () {
    return { dragging: false }
  },
  created () {
    // Gesture bookkeeping only; nothing renders from it.
    this.grip = null
  },
  beforeUnmount () {
    this.endGrip(null, true)
  },
  methods: {
    onGrip (event) {
      if (this.popped) return
      if (event.button !== undefined && event.button !== 0) return
      if (event.target.closest && event.target.closest('.panel__btn')) return
      this.grip = { id: event.pointerId, x: event.clientX, y: event.clientY, el: event.currentTarget }
      // Capture is what lets the drag continue once the pointer leaves the title
      // bar -- which it must, since the whole point is to drop it elsewhere. It
      // is not fatal if the browser declines: the listeners below still fire
      // while the pointer is over the header.
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* no capture */ }
      event.currentTarget.addEventListener('pointermove', this.onGripMove)
      event.currentTarget.addEventListener('pointerup', this.onGripUp)
      event.currentTarget.addEventListener('pointercancel', this.onGripUp)
    },
    onGripMove (event) {
      const g = this.grip
      if (!g || event.pointerId !== g.id) return
      if (!this.dragging) {
        if (Math.abs(event.clientX - g.x) < DRAG_SLOP && Math.abs(event.clientY - g.y) < DRAG_SLOP) return
        this.dragging = true
        this.$emit('drag-start')
      }
      event.preventDefault()
      this.$emit('drag-move', { x: event.clientX, y: event.clientY })
    },
    onGripUp (event) {
      const g = this.grip
      if (!g || event.pointerId !== g.id) return
      this.endGrip({ x: event.clientX, y: event.clientY }, false)
    },
    endGrip (at, silent) {
      const g = this.grip
      this.grip = null
      if (g && g.el) {
        g.el.removeEventListener('pointermove', this.onGripMove)
        g.el.removeEventListener('pointerup', this.onGripUp)
        g.el.removeEventListener('pointercancel', this.onGripUp)
        if (g.el.hasPointerCapture && g.el.hasPointerCapture(g.id)) {
          try { g.el.releasePointerCapture(g.id) } catch { /* pointer already gone */ }
        }
      }
      if (!this.dragging) return
      this.dragging = false
      if (!silent) this.$emit('drag-end', at)
    },
    onHeadDblClick (event) {
      if (this.popped) return
      if (event.target.closest && event.target.closest('.panel__btn')) return
      this.$emit('flip')
    }
  }
}
</script>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* Expanded panels share whatever height the dock has; collapsed ones are
     exactly their title bar. */
  flex: 1 1 0;
  border-radius: 10px;
  background: rgba(18, 22, 29, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.09);
  overflow: hidden;
}

.panel--collapsed {
  flex: 0 0 auto;
}

.panel--popped {
  flex: 1 1 auto;
  height: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.panel--dragging {
  opacity: 0.55;
  border-color: var(--accent);
}

.panel--active:not(.panel--popped) {
  border-color: rgba(255, 255, 255, 0.2);
}

.panel__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 38px;
  padding: 0 4px 0 7px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  -webkit-user-select: none;
  user-select: none;
  touch-action: none;
  cursor: grab;
}

.panel--popped .panel__head {
  cursor: default;
}

.panel--dragging .panel__head {
  cursor: grabbing;
}

.panel__grip {
  color: var(--text-dim);
  opacity: 0.6;
}

.panel__icon {
  color: var(--accent);
}

.panel__title {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.panel__btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}

.panel__btn:hover {
  background: rgba(255, 255, 255, 0.13);
  color: var(--text);
}

.panel__btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.panel__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
</style>
