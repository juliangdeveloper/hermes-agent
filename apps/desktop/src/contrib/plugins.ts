/**
 * Plugin discovery — both delivery modes:
 *
 *  - BUNDLED: every `src/plugins/<name>/plugin.{ts,tsx}` default-exporting a
 *    `HermesPlugin` registers automatically (vite glob — drop a folder in).
 *  - RUNTIME: the in-repo example ships as raw text through the REAL loader
 *    pipeline (rewrite -> shim blobs -> blob import), then the on-disk door
 *    (`<hermes home>/desktop-plugins/<name>/plugin.js`) — the agent's door.
 */

 
import helloRuntimeSource from '../plugins/hello-runtime/plugin.runtime.js?raw'

import { createPluginContext, type HermesPlugin } from './plugin'
import { discoverRuntimePlugins, loadRuntimePlugin } from './runtime-loader'

const modules = import.meta.glob<{ default: HermesPlugin }>('../plugins/*/plugin.{ts,tsx}', { eager: true })

// Registry.register replaces by id, so re-running (HMR) is naturally idempotent.
let loaded = false

export function discoverBundledPlugins(): void {
  if (loaded) {
    return
  }

  loaded = true

  for (const [path, mod] of Object.entries(modules)) {
    const plugin = mod.default

    if (!plugin?.id || typeof plugin.register !== 'function') {
      console.warn(`[plugins] ${path} has no valid default HermesPlugin export — skipped`)

      continue
    }

    try {
      plugin.register(createPluginContext(plugin.id))
    } catch (error) {
      console.error(`[plugins] ${plugin.id} failed to register`, error)
    }
  }

  // The runtime pipeline, dogfooded on every boot + the on-disk plugin door.
  void loadRuntimePlugin(helloRuntimeSource, 'hello-runtime')
  void discoverRuntimePlugins()
}
