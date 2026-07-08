/**
 * MULTI-SESSION VIEW STATE — the reactive face of the per-runtime session
 * cache (`sessionStateByRuntimeIdRef` in use-session-state-cache).
 *
 * The cache already ingests EVERY session's gateway events; only the view
 * was single-session ($messages + the active-id gate). This store mirrors
 * the cache per runtime id so any number of surfaces (session tiles, future
 * pane windows) can each subscribe to one session's state without touching
 * the main chat's `$messages` pipeline — same pattern as `useSessionSlice`
 * over `$todosBySession`, applied to whole `ClientSessionState`s.
 *
 * TILES are the first consumer: sessions opened side-by-side with the main
 * thread, each in its own layout-tree pane. `$sessionTiles` holds the
 * stored-session ids (persisted — tiles survive restarts); the wiring layer
 * owns resume/submit (it has the gateway + cache internals) and registers
 * itself here as the delegate so tile UI stays dependency-light.
 */

import { atom } from 'nanostores'

import type { ClientSessionState } from '@/app/types'

// ---------------------------------------------------------------------------
// Reactive per-runtime session state (view mirror of the wiring cache).
// ---------------------------------------------------------------------------

export const $sessionStates = atom<Record<string, ClientSessionState>>({})

/** Publish one session's state (immutable per-key — slices stay stable). */
export function publishSessionState(runtimeId: string, state: ClientSessionState) {
  $sessionStates.set({ ...$sessionStates.get(), [runtimeId]: state })
}

export function dropSessionState(runtimeId: string) {
  const current = $sessionStates.get()

  if (!(runtimeId in current)) {
    return
  }

  const { [runtimeId]: _dropped, ...rest } = current
  $sessionStates.set(rest)
}

// ---------------------------------------------------------------------------
// Session tiles.
// ---------------------------------------------------------------------------

export interface SessionTile {
  /** Stored session id — the durable identity (runtime ids are ephemeral). */
  storedSessionId: string
  /** Live runtime id once the tile's resume has bound one. */
  runtimeId?: string
  /** Resume failed terminally (shown in the tile; retryable). */
  error?: string
}

const TILES_KEY = 'hermes.desktop.sessionTiles.v1'

function loadTiles(): SessionTile[] {
  try {
    const raw = window.localStorage.getItem(TILES_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []

    // Runtime ids are process-scoped — never trust a persisted one.
    return Array.isArray(parsed)
      ? parsed
          .filter((t): t is SessionTile => Boolean(t && typeof (t as SessionTile).storedSessionId === 'string'))
          .map(t => ({ storedSessionId: t.storedSessionId }))
      : []
  } catch {
    return []
  }
}

export const $sessionTiles = atom<SessionTile[]>(loadTiles())

function saveTiles(tiles: SessionTile[]) {
  $sessionTiles.set(tiles)

  try {
    if (tiles.length === 0) {
      window.localStorage.removeItem(TILES_KEY)
    } else {
      window.localStorage.setItem(TILES_KEY, JSON.stringify(tiles.map(t => ({ storedSessionId: t.storedSessionId }))))
    }
  } catch {
    // Nonfatal.
  }
}

export function patchSessionTile(storedSessionId: string, patch: Partial<SessionTile>) {
  saveTiles($sessionTiles.get().map(t => (t.storedSessionId === storedSessionId ? { ...t, ...patch } : t)))
}

// ---------------------------------------------------------------------------
// Delegate — the wiring layer (which owns the gateway + session cache) plugs
// its actions in; tile UI calls through here. Same inversion as the tree
// store's pane closers.
// ---------------------------------------------------------------------------

export interface SessionTileDelegate {
  /** Run a slash command against a tile's session (app-level effects — e.g.
   *  branch/handoff — act on the main surface, as they should). */
  executeSlash(rawCommand: string, sessionId: string): Promise<void>
  /** Interrupt a tile's running turn. */
  interruptSession(runtimeId: string): Promise<void>
  /** Bind a live runtime id for a stored session (resume without touching
   *  the main view). Returns the runtime id, or throws. */
  resumeTile(storedSessionId: string): Promise<string>
  /** Submit a prompt to a tile's live session. */
  submitToSession(runtimeId: string, text: string): Promise<void>
  /** THE session-state write path — routes through the wiring cache so the
   *  cache, the primary view (when active), and every tile mirror agree. */
  updateSession(runtimeId: string, updater: (state: ClientSessionState) => ClientSessionState): ClientSessionState
}

let delegate: SessionTileDelegate | null = null

export function setSessionTileDelegate(next: SessionTileDelegate) {
  delegate = next
}

export function sessionTileDelegate(): SessionTileDelegate | null {
  return delegate
}

/** Open (or front) a tile for a stored session. Idempotent. */
export function openSessionTile(storedSessionId: string) {
  const tiles = $sessionTiles.get()

  if (!tiles.some(t => t.storedSessionId === storedSessionId)) {
    saveTiles([...tiles, { storedSessionId }])
  }
}

export function closeSessionTile(storedSessionId: string) {
  saveTiles($sessionTiles.get().filter(t => t.storedSessionId !== storedSessionId))
}

// Dev hook for automation (mirrors __HERMES_LAYOUT_TREE__).
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__HERMES_SESSION_TILES__ = {
    close: closeSessionTile,
    open: openSessionTile,
    patch: patchSessionTile,
    publish: publishSessionState,
    states: () => $sessionStates.get(),
    tiles: () => $sessionTiles.get()
  }
}
