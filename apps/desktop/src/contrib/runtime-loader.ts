/**
 * Runtime plugin loader — plugins as CODE, not registry edits, loaded after
 * build time. The pipeline every non-bundled plugin takes:
 *
 *   source (plain ESM js) -> [integrity check] -> bare-specifier rewrite
 *   (`@hermes/plugin-sdk` / `react*` -> live shim blobs, see sdk/runtime.ts)
 *   -> blob `import()` -> validate default HermesPlugin -> register(ctx)
 *
 * Loading the same plugin id again disposes the previous registrations first
 * (agent rewrites a plugin file -> clean reload). Failures toast + log; a
 * broken plugin can never take the app down.
 *
 * Sources today: the in-repo runtime example (`?raw`, proves the pipeline)
 * and `<hermes home>/desktop-plugins/<name>/plugin.js` on disk — the door the
 * agent writes through. Remote (https + allowlist) rides the same
 * `loadRuntimePlugin(source, { integrity })` seam when it lands.
 */

import { getStatus } from '@/hermes'
import { installPluginSdk, sdkImportMap } from '@/sdk/runtime'
import { notifyError } from '@/store/notifications'

import { createPluginContext, type HermesPlugin } from './plugin'

interface LoadOptions {
  /** `sha256-<base64>` — verified against the source before evaluation. */
  integrity?: string
}

/** Live runtime plugins: id -> disposers (unload/reload support). */
const loaded = new Map<string, (() => void)[]>()

const rewriteSpecifiers = (source: string): string =>
  Object.entries(sdkImportMap()).reduce(
    (out, [specifier, url]) => out.replaceAll(`"${specifier}"`, `"${url}"`).replaceAll(`'${specifier}'`, `'${url}'`),
    source
  )

async function verifyIntegrity(source: string, integrity: string): Promise<boolean> {
  const [algo, expected] = integrity.split('-', 2)

  if (algo !== 'sha256' || !expected) {
    return false
  }

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  const actual = btoa(String.fromCharCode(...new Uint8Array(digest)))

  return actual === expected
}

export function unloadRuntimePlugin(id: string): void {
  loaded.get(id)?.forEach(dispose => dispose())
  loaded.delete(id)
}

/** Evaluate + register one runtime plugin. Returns its id, or null on failure. */
export async function loadRuntimePlugin(source: string, origin: string, options: LoadOptions = {}): Promise<null | string> {
  installPluginSdk()

  try {
    if (options.integrity && !(await verifyIntegrity(source, options.integrity))) {
      throw new Error(`integrity check failed for ${origin}`)
    }

    const url = URL.createObjectURL(new Blob([rewriteSpecifiers(source)], { type: 'text/javascript' }))

    let mod: { default?: HermesPlugin }

    try {
      mod = await import(/* @vite-ignore */ url)
    } finally {
      URL.revokeObjectURL(url)
    }

    const plugin = mod.default

    if (!plugin?.id || typeof plugin.register !== 'function') {
      throw new Error(`${origin} has no valid default HermesPlugin export`)
    }

    // Reload = dispose the previous incarnation, then register fresh.
    unloadRuntimePlugin(plugin.id)
    const disposers: (() => void)[] = []
    plugin.register(createPluginContext(plugin.id, dispose => disposers.push(dispose)))
    loaded.set(plugin.id, disposers)

    return plugin.id
  } catch (error) {
    console.error(`[plugins] runtime load failed (${origin})`, error)
    notifyError(error, `Plugin "${origin}" failed to load`)

    return null
  }
}

/**
 * Load every `<hermes home>/desktop-plugins/<name>/plugin.js` — the on-disk
 * plugin door (agent- or user-written). Quietly a no-op outside Electron or
 * before the gateway can report its home.
 */
export async function discoverRuntimePlugins(): Promise<void> {
  const desktop = window.hermesDesktop

  if (!desktop) {
    return
  }

  try {
    const { hermes_home } = await getStatus()
    const dir = `${hermes_home}/desktop-plugins`
    const { entries } = await desktop.readDir(dir)

    for (const entry of entries.filter(e => e.isDirectory)) {
      const file = `${entry.path}/plugin.js`

      try {
        const { text } = await desktop.readFileText(file)
        await loadRuntimePlugin(text, entry.name)
      } catch {
        // No plugin.js in this folder — skip.
      }
    }
  } catch {
    // No desktop-plugins dir (or no gateway yet) — nothing to load.
  }
}
