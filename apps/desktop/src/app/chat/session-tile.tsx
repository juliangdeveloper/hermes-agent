/**
 * SESSION TILES — a stored session rendered as a layout-tree pane BESIDE the
 * main thread (multi-session tiling). A tile IS the real chat surface: the
 * same ChatView/ChatBar/Thread tree the primary session renders, mounted
 * under a tile `SessionView` (its session's slice of `$sessionStates`) and a
 * tile `ComposerScope` (own attachment chips, own focus-bus key). Actions
 * (submit/slash/steer/edit/reload/restore/stop) come from
 * `useSessionTileActions`, all writing through the wiring cache.
 *
 * Lifecycle: `openSessionTile(storedId)` -> `watchSessionTiles` registers a
 * pane contribution docked right of the main zone -> tree adoption lands it
 * -> the pane mounts and asks the delegate for a live runtime id. Closing
 * the pane (tab Close) removes the tile + its zone; tiles persist across
 * restarts and re-resume on boot.
 */

import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'
import { useEffect, useMemo, useRef } from 'react'

import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { blobToDataUrl } from '@/app/session/hooks/use-prompt-actions/utils'
import { formatRefValue } from '@/components/assistant-ui/directive-text'
import { registerPaneCloser, removeTreePane } from '@/components/pane-shell/tree/store'
import { Button } from '@/components/ui/button'
import { registry } from '@/contrib/registry'
import { transcribeAudio } from '@/hermes'
import type { ChatMessage } from '@/lib/chat-messages'
import { sessionTitle } from '@/lib/chat-runtime'
import { createComposerAttachmentScope } from '@/store/composer'
import { sessionAwaitingInput } from '@/store/prompts'
import { $sessions } from '@/store/session'
import {
  $sessionStates,
  $sessionTiles,
  closeSessionTile,
  patchSessionTile,
  sessionTileDelegate
} from '@/store/session-states'

import { sessionMatchesStoredId } from '../session/hooks/use-session-actions/utils'

import { type ComposerScope, ComposerScopeProvider } from './composer/scope'
import { useComposerActions } from './hooks/use-composer-actions'
import { useSessionTileActions } from './session-tile-actions'
import { type SessionView, SessionViewProvider } from './session-view'
import { lastVisibleMessageIsUser } from './thread-loading'

import { ChatView } from '.'

const tilePaneId = (storedSessionId: string) => `session-tile:${storedSessionId}`

const NO_MESSAGES: ChatMessage[] = []

/** The tile's SessionView: the same atom shape the primary chat renders
 *  from, computed from this session's slice of `$sessionStates`. */
function buildTileView(storedSessionId: string): SessionView {
  const $runtimeId = computed($sessionTiles, tiles => tiles.find(t => t.storedSessionId === storedSessionId)?.runtimeId ?? null)
  const $state = computed([$runtimeId, $sessionStates], (runtimeId, states) => (runtimeId ? states[runtimeId] : undefined))
  const $messages = computed($state, state => state?.messages ?? NO_MESSAGES)

  return {
    kind: 'tile',
    $awaitingResponse: computed($state, state => Boolean(state?.awaitingResponse)),
    $busy: computed($state, state => Boolean(state?.busy)),
    $cwd: computed($state, state => state?.cwd ?? ''),
    $lastVisibleIsUser: computed($messages, lastVisibleMessageIsUser),
    $messages,
    $messagesEmpty: computed($messages, messages => messages.length === 0),
    $model: computed($state, state => state?.model ?? ''),
    $provider: computed($state, state => state?.provider ?? ''),
    $runtimeId,
    $storedId: computed($sessionTiles, () => storedSessionId)
  }
}

function TileChat({ runtimeId, storedSessionId, view }: { runtimeId: string; storedSessionId: string; view: SessionView }) {
  const { gatewayRef, requestGateway } = useGatewayRequest()
  const cwd = useStore(view.$cwd)

  // One attachment set + focus key per tile, stable for the tile's lifetime.
  const attachments = useRef(createComposerAttachmentScope()).current

  const scope = useMemo<ComposerScope>(
    () => ({
      $awaitingInput: sessionAwaitingInput(runtimeId),
      attachments,
      popoutAllowed: false,
      readMessages: () => view.$messages.get(),
      target: `tile:${storedSessionId}`
    }),
    [attachments, runtimeId, storedSessionId, view.$messages]
  )

  const actions = useSessionTileActions({ runtimeId, scope, storedSessionId })

  // The same attach/pick/paste/drop pipeline the primary composer uses,
  // pointed at this tile's chips + session.
  const composer = useComposerActions({
    activeSessionId: runtimeId,
    currentCwd: cwd,
    requestGateway,
    scope: { add: attachments.add, remove: attachments.remove, target: scope.target }
  })

  return (
    <SessionViewProvider value={view}>
      <ComposerScopeProvider value={scope}>
        <ChatView
          gateway={gatewayRef.current}
          onAddContextRef={composer.addContextRefAttachment}
          onAddUrl={url => composer.addContextRefAttachment(`@url:${formatRefValue(url)}`, url)}
          onAttachDroppedItems={composer.attachDroppedItems}
          onAttachImageBlob={composer.attachImageBlob}
          onBranchInNewChat={() => undefined}
          onCancel={actions.cancelRun}
          onDeleteSelectedSession={() => undefined}
          onDismissError={actions.dismissError}
          onEdit={actions.editMessage}
          onPasteClipboardImage={opts => composer.pasteClipboardImage(opts)}
          onPickFiles={() => void composer.pickContextPaths('file')}
          onPickFolders={() => void composer.pickContextPaths('folder')}
          onPickImages={() => void composer.pickImages()}
          onReload={actions.reloadFromMessage}
          onRemoveAttachment={id => void composer.removeAttachment(id)}
          onRestoreToMessage={actions.restoreToMessage}
          onRetryResume={() => patchSessionTile(storedSessionId, { error: undefined })}
          onSteer={actions.steerPrompt}
          onSubmit={actions.submitText}
          onThreadMessagesChange={actions.handleThreadMessagesChange}
          onToggleSelectedPin={() => undefined}
          onTranscribeAudio={async audio => (await transcribeAudio(await blobToDataUrl(audio), audio.type)).transcript}
        />
      </ComposerScopeProvider>
    </SessionViewProvider>
  )
}

export function SessionTilePane({ storedSessionId }: { storedSessionId: string }) {
  const tiles = useStore($sessionTiles)
  const tile = tiles.find(t => t.storedSessionId === storedSessionId)
  const runtimeId = tile?.runtimeId ?? null
  const resumingRef = useRef(false)
  const view = useMemo(() => buildTileView(storedSessionId), [storedSessionId])

  // Bind a live runtime id once (and again after a tile Retry clears error).
  useEffect(() => {
    if (runtimeId || tile?.error || resumingRef.current) {
      return
    }

    const delegate = sessionTileDelegate()

    if (!delegate) {
      return
    }

    resumingRef.current = true

    delegate
      .resumeTile(storedSessionId)
      .then(id => patchSessionTile(storedSessionId, { error: undefined, runtimeId: id }))
      .catch((err: unknown) => {
        patchSessionTile(storedSessionId, { error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        resumingRef.current = false
      })
  }, [runtimeId, storedSessionId, tile?.error])

  if (tile?.error) {
    return (
      <div className="grid h-full place-items-center p-4">
        <div className="max-w-[24rem] space-y-2 text-center font-mono text-[11px]">
          <div className="text-(--ui-danger,#f87171)">Couldn't open this session</div>
          <div className="break-words text-(--ui-text-quaternary)">{tile.error}</div>
          <Button onClick={() => patchSessionTile(storedSessionId, { error: undefined })} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      </div>
    )
  }

  if (!runtimeId) {
    return (
      <div className="grid h-full place-items-center font-mono text-[11px] text-(--ui-text-quaternary)">
        opening session…
      </div>
    )
  }

  return <TileChat runtimeId={runtimeId} storedSessionId={storedSessionId} view={view} />
}

// ---------------------------------------------------------------------------
// Tile -> pane contribution sync (call once from the app root).
// ---------------------------------------------------------------------------

/** Registered tile panes: stored id -> { dispose, title used at register }. */
const registered = new Map<string, { dispose: () => void; title: string }>()

function tileTitle(storedSessionId: string): string {
  const stored = $sessions.get().find(s => sessionMatchesStoredId(s, storedSessionId))

  return stored ? sessionTitle(stored) : 'Session'
}

function syncTilePanes(): void {
  const tiles = $sessionTiles.get()
  const wanted = new Set(tiles.map(t => t.storedSessionId))

  for (const { storedSessionId } of tiles) {
    const title = tileTitle(storedSessionId)
    const current = registered.get(storedSessionId)

    // register() replaces same-id in place — safe for live title refreshes.
    if (!current || current.title !== title) {
      const dispose = registry.register({
        id: tilePaneId(storedSessionId),
        area: 'panes',
        title,
        // Tiles live beside the thread: dock right of main, flex width.
        data: { dock: { pane: 'workspace', pos: 'right' }, minWidth: '20rem', placement: 'main' },
        render: () => <SessionTilePane storedSessionId={storedSessionId} />
      })

      registered.set(storedSessionId, { dispose, title })

      if (!current) {
        registerPaneCloser(tilePaneId(storedSessionId), () => closeSessionTile(storedSessionId))
      }
    }
  }

  for (const [storedSessionId, entry] of registered) {
    if (!wanted.has(storedSessionId)) {
      entry.dispose()
      registered.delete(storedSessionId)
      removeTreePane(tilePaneId(storedSessionId))
    }
  }
}

/** Keep pane contributions mirroring `$sessionTiles` (+ titles from
 *  `$sessions`). Idempotent-ish: module-level maps dedupe across HMR. */
export function watchSessionTiles(): void {
  syncTilePanes()
  $sessionTiles.listen(syncTilePanes)
  $sessions.listen(syncTilePanes)
}
