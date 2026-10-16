import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
/** Efforts supported by the known Antigravity runtime families. Unknown models keep upstream defaults. */
export declare function antigravityReasoning(model: string): LlmResolvedModelInfo['reasoning'];
/** Build the v1internal thinking config; do not forward arbitrary DSH effort strings. */
export declare function antigravityThinking(model: string, effort: string | undefined, maxTokens?: number): Record<string, unknown> | undefined;
