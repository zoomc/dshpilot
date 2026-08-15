export const pluginName = '@dshpilot/dsh-client-desktop'

export const name = 'dshpilot-client'
export const inject: readonly string[] = []

export interface DesktopClientPluginContext {
  effect?: (callback: () => void | (() => void), label?: string) => unknown
}

/** Minimal client loading seam; official Harness Web UI remains authoritative. */
export function apply(ctx: DesktopClientPluginContext): void {
  ctx.effect?.(() => undefined, 'dshpilot.client')
}

export default { name, inject, apply }
