export type TokenSource = 'official' | 'estimate'

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  totalTokens?: number
  contextWindow?: number
  source: TokenSource
  estimate: boolean
}

export interface TokenEstimateInput {
  messages?: readonly string[]
  toolSchemas?: readonly unknown[]
  attachmentManifests?: readonly unknown[]
  contextWindow?: number
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function firstNumber(value: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const found = finite(value[key])
    if (found !== undefined) return found
  }
  return undefined
}

/** Parse provider/Harness usage without changing the Agent Loop or composer. */
export function parseOfficialUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const root = value as Record<string, unknown>
  const usage = typeof root.usage === 'object' && root.usage !== null ? root.usage as Record<string, unknown> : root
  const inputTokens = firstNumber(usage, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'])
  const outputTokens = firstNumber(usage, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'])
  const cachedTokens = firstNumber(usage, ['cachedTokens', 'cached_tokens', 'cacheReadInputTokens', 'cache_read_input_tokens'])
  const contextWindow = firstNumber(root, ['contextWindow', 'context_window', 'maxContextTokens', 'max_context_tokens'])
    ?? firstNumber(usage, ['contextWindow', 'context_window'])
  if (inputTokens === undefined && outputTokens === undefined && cachedTokens === undefined && contextWindow === undefined) return undefined
  const totalTokens = firstNumber(usage, ['totalTokens', 'total_tokens']) ?? (inputTokens === undefined && outputTokens === undefined ? undefined : (inputTokens ?? 0) + (outputTokens ?? 0))
  return { inputTokens, outputTokens, cachedTokens, totalTokens, contextWindow, source: 'official', estimate: false }
}

/** Conservative, clearly-labelled token estimate for inspection UI only. */
export function estimateTokens(input: TokenEstimateInput): TokenUsage {
  const messages = input.messages ?? []
  const messageChars = messages.reduce((sum, message) => sum + message.length, 0)
  const schemaChars = (input.toolSchemas ?? []).reduce((sum: number, schema) => sum + (JSON.stringify(schema)?.length ?? 0), 0)
  const manifestChars = (input.attachmentManifests ?? []).reduce((sum: number, manifest) => sum + (JSON.stringify(manifest)?.length ?? 0), 0)
  const inputTokens = Math.ceil((messageChars + schemaChars + manifestChars) / 4)
  return {
    inputTokens,
    totalTokens: inputTokens,
    contextWindow: input.contextWindow,
    source: 'estimate',
    estimate: true,
  }
}

export function inspectTokenUsage(value: unknown, fallback: TokenEstimateInput): TokenUsage {
  return parseOfficialUsage(value) ?? estimateTokens(fallback)
}

export function contextUtilization(usage: TokenUsage): number | undefined {
  if (usage.contextWindow === undefined || usage.contextWindow <= 0 || usage.totalTokens === undefined) return undefined
  return Math.min(1, usage.totalTokens / usage.contextWindow)
}
