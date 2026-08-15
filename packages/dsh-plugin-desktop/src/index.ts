export const pluginName = '@dshpilot/dsh-plugin-desktop'

export const name = 'dshpilot-desktop'
export const inject: readonly string[] = []

export interface DesktopHostPluginContext {
  effect?: (callback: () => void | (() => void), label?: string) => unknown
}

/**
 * Host-side loading sentinel. OS integration remains in Tauri; this plugin is
 * intentionally a small Cordis seam that can be loaded by a Harness profile
 * without introducing a second session or MCP implementation.
 */
export function apply(ctx: DesktopHostPluginContext): void {
  ctx.effect?.(() => undefined, 'dshpilot.desktop')
}

export default { name, inject, apply }
