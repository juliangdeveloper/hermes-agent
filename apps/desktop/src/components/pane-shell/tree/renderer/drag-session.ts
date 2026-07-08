/**
 * Pane drag session — the FancyZones engine (zones-engine.ts, ported
 * verbatim): sensitivity-radius hit testing, HighlightedZones state machine,
 * Shift = select-many (combined zone range), ClosestCenter primary on drop.
 *
 * Dragging is FancyZones-style: the LAYOUT STAYS FIXED and every zone lights
 * up as a whole-region drop target; dropping moves the pane into that zone
 * (joining its tab stack). Tab drags inside their strip REORDER instead
 * (browser-tab feel); tearing away converts the drag into a zone move.
 * Pointer-capture based.
 */

import type { PointerEvent as ReactPointerEvent } from 'react'

import {
  REORDER_DRAG_TRANSITION_CSS,
  REORDER_RAIL_TRANSITION_CSS,
  reorderCommitHaptic,
  reorderStepHaptic
} from '@/lib/reorder'

import type { DropPosition } from '../model'
import { $dropHint, $treeDragging, type DropHint, mergeTreeZones, moveTreePane, reorderTreePane } from '../store'
import { type EngineZone, HighlightedZones, primaryZone } from '../zones-engine'

const DRAG_THRESHOLD_PX = 4

/** Pointer within this normalized band of a zone edge targets a SPLIT drop
 *  (the coarse gesture — fling toward a side). The arrow chips near the badge
 *  are the precise targets and win over the band. */
const EDGE_BAND = 0.2

function snapshotZones(): EngineZone[] {
  return [...document.querySelectorAll<HTMLElement>('[data-tree-group]')].map(el => {
    const r = el.getBoundingClientRect()

    return { id: el.dataset.treeGroup!, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }
  })
}

/** Sub-zone drop position: an arrow chip under the pointer wins (precise),
 *  else the dominant edge band (coarse), else center = stack. */
function subZonePosition(zones: EngineZone[], groupId: string, x: number, y: number): DropPosition {
  const chip = document
    .elementsFromPoint(x, y)
    .find((el): el is HTMLElement => el instanceof HTMLElement && Boolean(el.dataset.dropPos))

  if (chip) {
    return chip.dataset.dropPos as DropPosition
  }

  const rect = zones.find(zone => zone.id === groupId)?.rect

  if (!rect) {
    return 'center'
  }

  const rx = (x - rect.left) / Math.max(1, rect.right - rect.left)
  const ry = (y - rect.top) / Math.max(1, rect.bottom - rect.top)

  const edges: [DropPosition, number][] = [
    ['left', rx],
    ['right', 1 - rx],
    ['top', ry],
    ['bottom', 1 - ry]
  ]

  const [pos, depth] = edges.reduce((a, b) => (b[1] < a[1] ? b : a))

  return depth < EDGE_BAND ? pos : 'center'
}

const sameHint = (a: DropHint | null, b: DropHint | null) =>
  a?.groupId === b?.groupId &&
  a?.pos === b?.pos &&
  (a?.groupIds?.length ?? 0) === (b?.groupIds?.length ?? 0) &&
  (a?.groupIds ?? []).every((id, i) => b?.groupIds?.[i] === id)

interface ReorderContext {
  groupId: string
  /** The tab-strip element; tabs carry `data-tree-tab={paneId}`. */
  strip: HTMLElement
}

/** How far (px) the pointer may stray from the strip before a tab drag stops
 *  being a reorder and becomes a zone move (browser-tab tear-off feel). */
const TEAR_OFF_SLACK_PX = 18

/** Double-tap detection for drag handles. The drag session preventDefaults
 *  pointerdown, which suppresses native `dblclick` — so rapid same-handle
 *  taps are detected here instead. */
const DOUBLE_TAP_MS = 400
let lastTap: { key: string; time: number } | null = null

export interface DoubleTapContext {
  /** Two sub-threshold releases with the same key within DOUBLE_TAP_MS. */
  key: string
  onDoubleTap: () => void
}

/** Live transform state for an in-flight tab reorder (all imperative — the
 *  strip's DOM nodes are stable while the drag holds the order). The feel is
 *  the SHARED reorder primitive (lib/reorder.ts): the dragged chip glides
 *  between snapped slots, neighbors spring aside, haptics tick per slot. */
interface ReorderVisual {
  tabs: { el: HTMLElement; mid: number }[]
  dragIndex: number
  dragEl: HTMLElement
  dragLeft: number
  /** How far a displaced neighbor slides (the dragged chip's cell pitch). */
  shift: number
  /** Resting LEFT for the dragged chip at each insertion slot (0..n-1). */
  slotLefts: number[]
  /** Current insertion index among the OTHER tabs (0..n-1). */
  target: number
}

/**
 * Begin a pane drag from any handle. A sub-threshold release is a click
 * (`onTap`, used to activate tabs; rapid repeat fires `double.onDoubleTap`
 * instead). With a `reorder` context (tab drags), horizontal movement inside
 * the strip REORDERS the tabs (visual slide during the drag, one commit on
 * release); tearing away from the strip converts the drag into a zone move.
 * Zone mode: zones light up, Shift extends the highlight range
 * (HighlightedZones::Update), release drops into the ClosestCenter primary
 * zone.
 */
export function startPaneDrag(
  paneId: string,
  e: ReactPointerEvent<HTMLElement>,
  onTap?: () => void,
  reorder?: ReorderContext,
  double?: DoubleTapContext
) {
  if (e.button !== 0) {
    return
  }

  e.preventDefault()
  e.stopPropagation()

  const handle = e.currentTarget
  const { pointerId } = e
  const sx = e.clientX
  const sy = e.clientY
  const restoreCursor = document.body.style.cursor
  const restoreSelect = document.body.style.userSelect
  const highlighted = new HighlightedZones()
  let zones: EngineZone[] = []
  let lastPoint = { x: sx, y: sy }
  let mode: 'idle' | 'reorder' | 'zone' = 'idle'
  let visual: ReorderVisual | null = null

  try {
    handle.setPointerCapture?.(pointerId)
  } catch {
    // Synthetic events (automation) have no active pointer.
  }

  const clearReorderVisual = () => {
    if (!visual) {
      return
    }

    for (const tab of visual.tabs) {
      tab.el.style.transform = ''
      tab.el.style.transition = ''
      tab.el.style.zIndex = ''
    }

    visual = null
  }

  const enterZoneMode = () => {
    clearReorderVisual()
    mode = 'zone'
    // The layout never restructures mid-drag, so zone rects are stable.
    zones = snapshotZones()
    $treeDragging.set(paneId)
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }

  const enterReorderMode = () => {
    const els = [...reorder!.strip.querySelectorAll<HTMLElement>('[data-tree-tab]')]
    const dragIndex = els.findIndex(el => el.dataset.treeTab === paneId)

    if (dragIndex === -1) {
      enterZoneMode()

      return
    }

    const rects = els.map(el => el.getBoundingClientRect())
    const gap = rects.length > 1 ? Math.max(0, rects[1].left - rects[0].right) : 0
    const others = rects.filter((_, i) => i !== dragIndex)

    // Snapped slot positions (profile-rail semantics): inserting at slot k
    // puts the dragged chip after k others — its resting left is the run of
    // those k widths from the strip start. Chip widths vary (unlike the
    // profile squares' fixed pitch) so slots are cumulative, not a multiple.
    const slotLefts: number[] = []
    let acc = rects[0].left

    for (let k = 0; k < rects.length; k++) {
      slotLefts.push(acc)
      acc += (others[k]?.width ?? 0) + gap
    }

    visual = {
      tabs: els.map((el, i) => ({ el, mid: rects[i].left + rects[i].width / 2 })),
      dragIndex,
      dragEl: els[dragIndex],
      dragLeft: rects[dragIndex].left,
      shift: rects[dragIndex].width + gap,
      slotLefts,
      target: dragIndex
    }

    // Dragged chip GLIDES between snapped slots on the drag transition;
    // neighbors spring aside on the rail transition — the shared feel.
    for (const [i, el] of els.entries()) {
      el.style.transition = i === dragIndex ? REORDER_DRAG_TRANSITION_CSS : REORDER_RAIL_TRANSITION_CSS
    }

    els[dragIndex].style.zIndex = '10'

    mode = 'reorder'
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }

  const withinStrip = (x: number, y: number) => {
    if (!reorder) {
      return false
    }

    const r = reorder.strip.getBoundingClientRect()

    return (
      x >= r.left - TEAR_OFF_SLACK_PX &&
      x <= r.right + TEAR_OFF_SLACK_PX &&
      y >= r.top - TEAR_OFF_SLACK_PX &&
      y <= r.bottom + TEAR_OFF_SLACK_PX
    )
  }

  const applyReorderVisual = (x: number) => {
    if (!visual) {
      return
    }

    // Insertion slot from the pointer against the others' resting midpoints.
    const target = visual.tabs.filter((tab, i) => i !== visual!.dragIndex && tab.mid < x).length

    if (target === visual.target) {
      return
    }

    visual.target = target
    reorderStepHaptic()

    // The dragged chip SNAPS to its slot's resting position and glides there
    // on the drag transition — it steps slot-to-slot (the profile rail's
    // stepThroughCells feel), never floating freely under the pointer.
    const dx = visual.slotLefts[target] - visual.dragLeft
    visual.dragEl.style.transform = dx ? `translateX(${dx}px)` : ''

    // Neighbors between the old and new slot spring aside by the dragged
    // cell's pitch; everyone else rests. (`j` = a tab's index among the
    // OTHERS — the space `target` indexes into.)
    for (const [i, tab] of visual.tabs.entries()) {
      if (i === visual.dragIndex) {
        continue
      }

      const j = i < visual.dragIndex ? i : i - 1

      const tx =
        i > visual.dragIndex && j < target ? -visual.shift : i < visual.dragIndex && j >= target ? visual.shift : 0

      tab.el.style.transform = tx ? `translateX(${tx}px)` : ''
    }
  }

  const onMove = (ev: PointerEvent) => {
    lastPoint = { x: ev.clientX, y: ev.clientY }

    if (mode === 'idle') {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD_PX) {
        return
      }

      if (reorder && withinStrip(ev.clientX, ev.clientY)) {
        enterReorderMode()
      } else {
        enterZoneMode()
      }
    }

    if (mode === 'reorder') {
      if (!withinStrip(ev.clientX, ev.clientY)) {
        // Tear-off: the tab leaves the strip and becomes a zone move.
        enterZoneMode()
      } else {
        applyReorderVisual(ev.clientX)

        return
      }
    }

    // The hint updates on highlight-set changes AND on sub-zone position
    // changes (arrow chips / edge bands within the same primary zone).
    highlighted.update(zones, lastPoint, ev.shiftKey)
    let groupIds = [...highlighted.zones()]

    // Spanning multiple zones is EXPLICIT (Shift). Without it, the seam-
    // proximity capture (sensitivity radius grabs both neighbors near a
    // shared edge) collapses to the primary zone — otherwise a drop near a
    // seam silently merges zones the user never asked to merge.
    if (!ev.shiftKey && groupIds.length > 1) {
      const collapsed = primaryZone(zones, groupIds, lastPoint)
      groupIds = collapsed ? [collapsed] : []
    }

    const groupId = groupIds.length > 0 ? (primaryZone(zones, groupIds, lastPoint) ?? undefined) : undefined

    // Sub-positions only make sense for a single-zone drop; a Shift-span
    // always merges (pos ignored).
    const pos: DropPosition =
      groupIds.length === 1 && groupId ? subZonePosition(zones, groupId, lastPoint.x, lastPoint.y) : 'center'

    const next: DropHint | null = groupIds.length > 0 ? { kind: 'group', groupId, groupIds, pos } : null

    if (!sameHint($dropHint.get(), next)) {
      $dropHint.set(next)
    }
  }

  const finish = (commit: boolean) => {
    document.body.style.cursor = restoreCursor
    document.body.style.userSelect = restoreSelect

    try {
      handle.releasePointerCapture?.(pointerId)
    } catch {
      // Mirror of the capture guard.
    }

    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onCancel, true)

    if (mode === 'reorder' && visual) {
      const { dragIndex, target } = visual
      clearReorderVisual()

      if (commit && reorder && target !== dragIndex) {
        reorderTreePane(reorder.groupId, paneId, target)
        reorderCommitHaptic()
      }
    }

    if (commit && mode === 'zone') {
      // Drop what the hint SHOWS — the overlay and the commit share one truth
      // (the raw highlight set can hold both seam neighbors; the hint already
      // collapsed that to the primary unless Shift made the span explicit).
      const hint = $dropHint.get()
      const targets = hint?.groupIds ?? []

      if (targets.length > 1) {
        // Shift-span: merge the highlighted zones, dropping the pane across them.
        mergeTreeZones([...targets], paneId, hint?.groupId ?? null)
      } else if (hint?.groupId) {
        // center = join the stack; an edge = split the zone and land there.
        moveTreePane(paneId, { groupId: hint.groupId, pos: hint.pos ?? 'center' })
      }
    }

    if (mode === 'idle' && commit) {
      const now = Date.now()

      if (double && lastTap?.key === double.key && now - lastTap.time < DOUBLE_TAP_MS) {
        lastTap = null
        double.onDoubleTap()
      } else {
        lastTap = double ? { key: double.key, time: now } : null
        onTap?.()
      }
    }

    highlighted.reset()
    $dropHint.set(null)
    $treeDragging.set(null)
  }

  const onUp = () => finish(true)
  const onCancel = () => finish(false)

  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onCancel, true)
}
