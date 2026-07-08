/**
 * Group node renderer — a ZONE: header strip (tabs when stacked, minimize
 * chevron) + the active pane's content, resolved from the contribution
 * registry (`area: 'panes'`). Empty zones exist only in editor-authored
 * trees (drop targets until the first structural op prunes them).
 *
 * Dragging is FancyZones-style (drag-session.ts): the layout stays fixed and
 * every zone lights up as a whole-region drop target. Right-click opens the
 * contextual zone menu (split/move + header/minimize toggles).
 */

import { useStore } from '@nanostores/react'
import { type MouseEvent as ReactMouseEvent, type ReactNode, useRef } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DecodeText } from '@/components/ui/decode-text'
import { useContributions } from '@/contrib/react/use-contributions'
import { cn } from '@/lib/utils'

import { $layoutEditMode } from '../../edit-mode'
import { useWindowControlsOverlap } from '../../geometry'
import type { DropPosition, GroupNode, RootEdge } from '../model'
import { adjacentGroup } from '../model'
import {
  $dropHint,
  $hiddenTreePanes,
  $layoutTree,
  $narrowViewport,
  $treeDragging,
  activateTreePane,
  moveTreePane,
  setTreeGroupHeaderHidden,
  splitTreeZone,
  toggleTreeGroupMinimized
} from '../store'
import { FADE_IN_DURATION_MILLIS } from '../zones-engine'

import { type DoubleTapContext, startPaneDrag } from './drag-session'
import { paneChrome } from './track-model'

/** A directional action in the zone menu (computed per group state). */
interface ZoneMenuDirection {
  side: RootEdge
  label: string
  run: () => void
}

const DIRECTION_ORDER: readonly RootEdge[] = ['right', 'bottom', 'left', 'top']
const DIRECTION_WORD: Record<RootEdge, string> = { bottom: 'down', left: 'left', right: 'right', top: 'up' }
const DIRECTION_ARROW: Record<RootEdge, string> = { bottom: '↓', left: '←', right: '→', top: '↑' }

/** Right-click zone menu: directional actions + header toggle + minimize.
 *  The directions are CONTEXTUAL (computed by TreeGroup): a stacked group
 *  offers "Split <dir>" (carve a new zone with the clicked pane — VS Code
 *  split-and-move in one gesture); a single-pane group offers "Move <dir>"
 *  into the zone actually sitting on that side — directions with no visible
 *  neighbor aren't offered, so no action ever appears to do nothing. */
function ZoneMenu({
  children,
  directions,
  headerHidden,
  minimized,
  nodeId
}: {
  children: ReactNode
  directions: ZoneMenuDirection[]
  headerHidden?: boolean
  minimized?: boolean
  nodeId: string
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {directions.map(direction => (
          <ContextMenuItem key={direction.side} onSelect={direction.run}>
            {direction.label}
          </ContextMenuItem>
        ))}
        <ContextMenuItem onSelect={() => setTreeGroupHeaderHidden(nodeId, !headerHidden)}>
          {headerHidden ? 'Show header' : 'Hide header'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => toggleTreeGroupMinimized(nodeId, !minimized)}>
          {minimized ? 'Restore' : 'Minimize'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function TreeGroup({ node }: { node: GroupNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  // The chip under the last right-click — the pane the zone menu's Split
  // actions carry into the new zone (header background = the active pane).
  const menuPaneRef = useRef<string | undefined>(undefined)
  const panes = useContributions('panes')
  const dragging = useStore($treeDragging)
  const hint = useStore($dropHint)
  const editMode = useStore($layoutEditMode)
  const wcOverlap = useWindowControlsOverlap(ref, true)

  const hiddenPanes = useStore($hiddenTreePanes)
  const narrow = useStore($narrowViewport)

  const paneFor = (id: string) => panes.find(p => p.id === id)
  // Chrome-toggled-off panes (and narrow-collapsed ones) drop out of the
  // header; the active pane falls back to the first shown one (render-side —
  // the tree keeps `active`).
  const paneShown = (id: string) => !hiddenPanes.has(id) && !(narrow && paneChrome(paneFor(id)).collapsible)
  const shown = node.panes.filter(paneShown)
  const activeId = shown.includes(node.active) ? node.active : (shown[0] ?? node.active)
  const active = paneFor(activeId)
  const isEmpty = node.panes.length === 0

  // ONE header style: the app's compact pane-header. DEFAULT is contextual —
  // a single pane isn't a "tab", so its header auto-hides; a stack shows its
  // chips. Double-click the zone toggles it either way (explicit choice wins
  // over the default — that's how you summon a lone pane's chip to drag it).
  // A minimized group always shows its header — the group IS the header.
  const headerHidden = node.headerHidden ?? shown.length <= 1
  const headerVisible = !isEmpty && (Boolean(node.minimized) || !headerHidden)

  // Drag handles preventDefault pointerdown (no native dblclick), so the
  // header + chips share a synthesized double-tap: restore if collapsed
  // (undoing the first tap's minimize toggle) and hide the chrome.
  const hideHeaderDoubleTap: DoubleTapContext = {
    key: `hide-header-${node.id}`,
    onDoubleTap: () => {
      toggleTreeGroupMinimized(node.id, false)
      setTreeGroupHeaderHidden(node.id, true)
    }
  }

  // Zone-menu directions, contextual to this group's state:
  //  - stacked panes -> "Split <dir>": carve a new zone on that side with the
  //    right-clicked chip's pane in it (split + move, one gesture);
  //  - a single pane -> "Move <dir>": join the zone visually adjacent on that
  //    side (splitting here would only make an invisible empty zone). Sides
  //    with no visible neighbor are omitted entirely.
  const tree = useStore($layoutTree)

  const menuDirections: ZoneMenuDirection[] =
    shown.length > 1
      ? DIRECTION_ORDER.map(side => ({
          side,
          label: `Split ${DIRECTION_WORD[side]} ${DIRECTION_ARROW[side]}`,
          run: () => splitTreeZone(node.id, side, menuPaneRef.current ?? activeId)
        }))
      : DIRECTION_ORDER.flatMap(side => {
          const neighbor = tree ? adjacentGroup(tree, node.id, side, g => g.panes.some(paneShown)) : null

          if (!neighbor || neighbor.id === node.id) {
            return []
          }

          return [
            {
              side,
              label: `Move ${DIRECTION_WORD[side]} ${DIRECTION_ARROW[side]}`,
              run: () => moveTreePane(activeId, { groupId: neighbor.id, pos: 'center' })
            }
          ]
        })

  // Same menu on the header strip and the edit veil — one prop bag.
  const zoneMenu = { directions: menuDirections, headerHidden, minimized: node.minimized, nodeId: node.id }

  // FancyZones semantics: the highlight SET (multi-zone with Shift) lights up
  // strongly; the primary zone (ClosestCenter) carries the action badge.
  const highlightedZone = dragging !== null && (hint?.groupIds?.includes(node.id) ?? false)
  const primary = dragging !== null && hint?.groupId === node.id
  const isDragSource = dragging !== null && node.panes.includes(dragging)
  const showZoneOverlay = dragging !== null && !(isDragSource && node.panes.length === 1)

  // Double-click ANYWHERE in the zone toggles the header (the header itself
  // handles its own double-tap, so this covers the body — crucially the only
  // clickable surface once the header is hidden). Interactive targets and
  // real text selections (double-click selects a word) never toggle.
  const onZoneDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (isEmpty || node.minimized) {
      return
    }

    const target = e.target as HTMLElement

    if (target.closest('button, a, input, textarea, select, [contenteditable], [role="tab"], .xterm')) {
      return
    }

    if (window.getSelection()?.toString()) {
      return
    }

    setTreeGroupHeaderHidden(node.id, !headerHidden)
  }

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-(--ui-bg-editor)"
      data-tree-group={node.id}
      onDoubleClick={onZoneDoubleClick}
      ref={ref}
      style={wcOverlap ? { paddingTop: wcOverlap.y + wcOverlap.height } : undefined}
    >
      {wcOverlap && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 [-webkit-app-region:drag]"
          style={{ height: wcOverlap.height, left: wcOverlap.x, top: wcOverlap.y, width: wcOverlap.width }}
        />
      )}

      {/* Header: ONE style — the small round chips (terminal-rail tab style),
          whether the group holds one pane or a stack. Double-click hides the
          header entirely. */}
      {headerVisible && (
        <ZoneMenu {...zoneMenu}>
          <div
            className="group/pane-header flex h-7 shrink-0 select-none items-center gap-1 border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) px-2 [-webkit-app-region:no-drag]"
            onContextMenu={e => {
              menuPaneRef.current =
                (e.target as HTMLElement).closest('[data-tree-tab]')?.getAttribute('data-tree-tab') ?? undefined
            }}
            onPointerDown={e =>
              // Tap the header to collapse to it / expand back — the DetailPane
              // / sidebar-section gesture. Double-tap hides the header entirely.
              // Drag still moves the pane.
              startPaneDrag(
                activeId,
                e,
                () => toggleTreeGroupMinimized(node.id, !node.minimized),
                undefined,
                hideHeaderDoubleTap
              )
            }
            ref={stripRef}
            style={{ cursor: 'grab' }}
          >
            <div
              className="flex min-w-0 items-center gap-0.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              role="tablist"
            >
              {shown.map(paneId => {
                const isActive = paneId === activeId && !node.minimized

                return (
                  <span
                    aria-selected={isActive}
                    className={cn(
                      'flex h-[1.375rem] shrink-0 cursor-grab items-center rounded-md px-2 text-[0.6875rem] font-medium transition-colors',
                      isActive
                        ? 'bg-(--chrome-action-hover) text-foreground'
                        : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
                    )}
                    data-tree-tab={paneId}
                    key={paneId}
                    onPointerDown={e =>
                      startPaneDrag(
                        paneId,
                        e,
                        () => {
                          // Chips ACTIVATE (restoring a collapsed group).
                          // Minimize lives on the chevron / single-pane label
                          // — overloading the active chip made double-click a
                          // minimize/restore/hide lottery.
                          if (node.minimized) {
                            toggleTreeGroupMinimized(node.id, false)
                          }

                          activateTreePane(node.id, paneId)
                        },
                        stripRef.current ? { groupId: node.id, strip: stripRef.current } : undefined,
                        hideHeaderDoubleTap
                      )
                    }
                    role="tab"
                  >
                    <span className="max-w-32 truncate">{paneFor(paneId)?.title ?? paneId}</span>
                  </span>
                )
              })}
            </div>
            <span className="ml-auto" />
            <button
              aria-label={node.minimized ? 'Restore' : 'Minimize'}
              className="grid size-5 shrink-0 place-items-center rounded-md text-(--ui-text-tertiary) opacity-0 transition-opacity hover:bg-(--ui-control-hover-background) hover:text-foreground focus-visible:opacity-100 group-hover/pane-header:opacity-100"
              onClick={() => toggleTreeGroupMinimized(node.id, !node.minimized)}
              onPointerDown={e => e.stopPropagation()}
              type="button"
            >
              <Codicon name={node.minimized ? 'chevron-down' : 'chevron-up'} size="0.75rem" />
            </button>
          </div>
        </ZoneMenu>
      )}

      {/* Body: the active pane's contributed content, or the empty zone. */}
      {!node.minimized && (
        <div className="relative min-h-0 min-w-0 flex-1 overflow-auto">
          {isEmpty ? (
            <div className="grid h-full place-items-center">
              {/* Same decode primitive as the CONNECTING boot overlay. */}
              <DecodeText className="text-(--ui-text-quaternary)" cursor prefix={1} text="HERMES" />
            </div>
          ) : active?.render ? (
            active.render()
          ) : (
            <div className="p-3 font-mono text-[11px] text-(--ui-text-quaternary)">missing pane: {activeId}</div>
          )}
        </div>
      )}

      {/* Edit-mode veil: the BODY is a drag handle for the active pane. It
          starts below the header so tabs/headers stay directly interactive
          (drag any tab, right-click for the zone menu). */}
      {editMode && !dragging && !isEmpty && !node.minimized && (
        <ZoneMenu {...zoneMenu}>
          <div
            // z-50: pane CONTENT may carry its own stacked chrome (the
            // terminal rail is z-40) — the edit veil must cover all of it.
            // The scrim mixes the accent over the CHROME BG (not transparent)
            // so it properly dims content in dark themes instead of leaving a
            // barely-tinted wash; the light blur reads as "edit mode" the same
            // way the zone editor's backdrop does.
            className="absolute inset-x-0 bottom-0 z-50 flex cursor-grab items-center justify-center outline-1 -outline-offset-2 outline-dashed backdrop-blur-[2px]"
            onPointerDown={e => startPaneDrag(activeId, e)}
            style={{
              top: headerVisible ? 28 : 0,
              background:
                'color-mix(in srgb, var(--ui-accent) 6%, color-mix(in srgb, var(--ui-bg-chrome) 55%, transparent))',
              outlineColor: 'color-mix(in srgb, var(--ui-accent) 55%, transparent)'
            }}
          >
            <span className="flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md border border-(--ui-stroke-secondary) bg-popover px-2 py-1 text-[0.64rem] font-semibold uppercase tracking-[0.16em] text-(--ui-text-secondary)">
              <Codicon className="shrink-0" name="gripper" size="0.8125rem" />
              <span className="min-w-0 truncate">{active?.title ?? activeId}</span>
            </span>
          </div>
        </ZoneMenu>
      )}

      {/* FancyZones drop overlay: ZonesOverlay semantics — every zone shows
          the inactive fill, the highlighted set gets the highlight fill at
          highlightOpacity (50%), all fading in on the 200ms alpha ramp. The
          PRIMARY zone also offers directional targets (VS Code editor-drop
          style): hover/drop an arrow chip — or fling into an edge band — to
          SPLIT that side instead of stacking. */}
      {showZoneOverlay && (
        <div
          className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-[3px] border transition-colors duration-75"
          style={{
            animation: `hermes-zone-fade ${FADE_IN_DURATION_MILLIS}ms linear both`,
            // Grounded on the chrome bg so the inactive fill actually dims
            // content on dark themes (a bare 10% accent wash disappears there).
            background: highlightedZone
              ? 'color-mix(in srgb, var(--ui-accent) 50%, transparent)'
              : 'color-mix(in srgb, var(--ui-accent) 10%, color-mix(in srgb, var(--ui-bg-chrome) 45%, transparent))',
            borderColor: `color-mix(in srgb, var(--ui-accent) ${highlightedZone ? 100 : 35}%, transparent)`,
            margin: highlightedZone ? 2 : 4
          }}
        >
          {primary && <DropTargets multi={(hint?.groupIds?.length ?? 0) > 1} pos={hint?.pos ?? 'center'} source={isDragSource} stackLabel={isEmpty ? 'move here' : 'stack here'} />}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Directional drop targets (primary zone only)
// ---------------------------------------------------------------------------

const DROP_CHIPS: { arrow: string; pos: Exclude<DropPosition, 'center'> }[] = [
  { arrow: 'arrow-up', pos: 'top' },
  { arrow: 'arrow-right', pos: 'right' },
  { arrow: 'arrow-down', pos: 'bottom' },
  { arrow: 'arrow-left', pos: 'left' }
]

const CHIP_SPOT: Record<Exclude<DropPosition, 'center'>, string> = {
  bottom: 'left-1/2 top-full mt-1.5 -translate-x-1/2',
  left: 'right-full top-1/2 mr-1.5 -translate-y-1/2',
  right: 'left-full top-1/2 ml-1.5 -translate-y-1/2',
  top: 'bottom-full left-1/2 mb-1.5 -translate-x-1/2'
}

const DROP_BADGE_ACTIVE = 'border-(--ui-accent) bg-(--ui-accent) text-(--ui-accent-foreground,white)'
const DROP_BADGE_IDLE = 'border-(--ui-stroke-secondary) bg-popover text-(--ui-text-secondary)'

/**
 * The badge cluster: "stack here" in the middle, arrow chips on each side.
 * Chips are `data-drop-pos` hit targets for the drag's elementsFromPoint
 * probe (pointer-events back ON — pointer capture keeps the events flowing
 * to the drag handle, this only makes them hit-testable). The active target
 * — chip under the pointer, or the coarse edge band — lights up.
 */
function DropTargets({
  multi,
  pos,
  source,
  stackLabel
}: {
  multi: boolean
  pos: DropPosition
  source: boolean
  stackLabel: string
}) {
  const label = multi ? 'span here' : source ? 'stays here' : stackLabel

  return (
    <span className="relative inline-flex">
      <span
        className={cn(
          'rounded-md border px-2 py-1 text-[0.64rem] font-semibold uppercase tracking-[0.16em] transition-colors duration-75',
          multi || pos === 'center' ? DROP_BADGE_ACTIVE : DROP_BADGE_IDLE
        )}
      >
        {label}
      </span>
      {!multi && <DropChips pos={pos} />}
    </span>
  )
}

function DropChips({ pos }: { pos: DropPosition }) {
  return (
    <>
      {DROP_CHIPS.map(chip => (
          <span
          className={cn(
            'pointer-events-auto absolute grid size-6 place-items-center rounded-md border transition-colors duration-75',
            CHIP_SPOT[chip.pos],
            pos === chip.pos ? DROP_BADGE_ACTIVE : DROP_BADGE_IDLE
          )}
          data-drop-pos={chip.pos}
          key={chip.pos}
        >
          <Codicon name={chip.arrow} size="0.75rem" />
        </span>
      ))}
    </>
  )
}
