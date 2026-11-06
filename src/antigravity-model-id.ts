/** Only concrete, explicit effort suffixes establish an Antigravity model family. */
export function antigravityModelId(id: string): string {
  return id.replace(/^((?:gemini|claude|gpt-oss)-.+)-(?:low|medium|high)$/, '$1')
}

/** Quota scopes retain concrete upstream ids; selectors use the family id. */
export function sameAntigravityModel(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && antigravityModelId(left) === antigravityModelId(right)
}

export const ANTIGRAVITY_QUOTA_SCOPES = ['Gemini Models', 'Claude and GPT models', 'Gemini 4 Argon'] as const
export type AntigravityQuotaScope = typeof ANTIGRAVITY_QUOTA_SCOPES[number]

/** Summary labels are account-wide quota families, not model IDs. */
export function antigravityQuotaScope(value: string | undefined): AntigravityQuotaScope | undefined {
  return ANTIGRAVITY_QUOTA_SCOPES.find(scope => scope.toLowerCase() === value?.trim().toLowerCase())
}

export function antigravityQuotaApplies(scope: string | undefined, model: string | undefined): boolean {
  if (model === undefined) return false
  switch (antigravityQuotaScope(scope)) {
    case 'Gemini Models': return /^gemini-/.test(model)
    case 'Claude and GPT models': return /^(?:claude-|gpt-oss-)/.test(model)
    case 'Gemini 4 Argon': return /^gemini-4-argon(?:-|$)/.test(model)
    default: return sameAntigravityModel(scope, model)
  }
}
