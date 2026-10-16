/** Cloud Code Assist thinking budgets, matched to the runtime model family. */
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
/** Efforts supported by the known Antigravity runtime families. Unknown models keep upstream defaults. */
export function antigravityReasoning(model) {
    const ids = model.startsWith('claude-') ? ['high']
        : model.startsWith('gpt-oss-') ? ['medium']
            : model.startsWith('gemini-3.1-pro') || model === 'gemini-pro-agent' ? ['low', 'high']
                : /^gemini-(?:2\.5|3)/.test(model) ? ['low', 'medium', 'high'] : [];
    const fixedEffort = /^gemini-.*-(low|medium|high)$/.exec(model)?.[1];
    const efforts = fixedEffort !== undefined && ids.includes(fixedEffort) ? [fixedEffort] : ids;
    return efforts.length === 0 ? undefined : {
        efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id[0].toUpperCase() + id.slice(1) })),
    };
}
/** Build the v1internal thinking config; do not forward arbitrary DSH effort strings. */
export function antigravityThinking(model, effort, maxTokens) {
    if (effort === undefined)
        return undefined;
    const supported = antigravityReasoning(model);
    if (supported === undefined || effort !== 'off' && !supported.efforts.some(entry => entry.id === effort)) {
        throw new LlmError(`Antigravity model ${model} does not support reasoning effort ${effort}`, 'UNSUPPORTED_REASONING_EFFORT');
    }
    if (effort === 'off')
        return { includeThoughts: false, thinkingBudget: 0 };
    // Reference: pi-antigravity src/models/models.ts at 697858c (v1internal wire).
    let budget;
    if (model.startsWith('claude-'))
        budget = 1024;
    else if (model.startsWith('gpt-oss-'))
        budget = 8192;
    else if (model.startsWith('gemini-3.1-pro') || model === 'gemini-pro-agent') {
        budget = effort === 'high' ? 10001 : 1001;
    }
    else if (model.startsWith('gemini-3.5-flash') || model === 'gemini-3-flash-agent') {
        budget = effort === 'high' ? 10000 : effort === 'medium' ? 4000 : 1000;
    }
    else {
        budget = effort === 'high' ? -1 : effort === 'medium' ? 4000 : 1000;
    }
    if (maxTokens !== undefined && budget > 0 && maxTokens <= budget) {
        throw new LlmError(`Antigravity maxTokens must exceed the thinking budget (${budget}) for ${model}/${effort}`, 'INVALID_REQUEST');
    }
    return { includeThoughts: true, thinkingBudget: budget };
}
