/** Synthetic roster shaped after issue #180 and fetchAvailableModels metadata.
 * agentModelSorts/tieredModelIds: opencode-antigravity-auth src/plugin/quota.ts.
 * thinkingLevel/thinkingBudget: oh-my-pi packages/catalog/src/discovery/antigravity.ts.
 * No authenticated response or account identifiers are included.
 */
export function antigravityCatalog() {
  return {
    agentModelSorts: [{ groups: [{ modelIds: [
      'gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low',
      'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
      'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high',
      'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high',
      'gpt-oss-120b-medium',
    ] }] }],
    // Categories outside the native roster must not manufacture picker entries.
    tieredModelIds: {
      pro: ['gemini-3.8-flash-tiered'], flashLite: ['gemini-3.5-flash-lite'],
    },
    models: {
      ...Object.fromEntries([
        ['gemini-4-argon', 'Gemini 4 Argon'], ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
        ['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
      ].flatMap(([id, name]) => ['low', 'medium', 'high'].map((effort, index) => [
        `${id}-${effort}`, { displayName: `${name} (${effort[0].toUpperCase() + effort.slice(1)})`, thinkingLevel: index + 1, inputTokenLimit: 200000, maxOutputTokens: 16000 },
      ]))),
      'gemini-3.8-flash-tiered': { displayName: 'Gemini 3.8 Flash Tiered', inputTokenLimit: 200000 },
      'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', thinkingLevel: 2 },
      'gemini-3.5-flash-lite': { displayName: 'Gemini 3.5 Flash Lite' },
      'gemini-3-flash': { displayName: 'Gemini 3 Flash' },
      'chat_23310': { displayName: 'Chat_23310', isInternal: true },
      'gemini-4-argon-disabled': { displayName: 'Argon unavailable', disabled: true },
    },
  }
}
