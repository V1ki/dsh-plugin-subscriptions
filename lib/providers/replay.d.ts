import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AccountAwareAdapter } from './accounts.js';
/** Bind opaque provider replay to the concrete account/model behind a public route alias. */
export declare function streamAccountWithReplay(adapter: AccountAwareAdapter, options: GenerateOptions, account: string, model?: string): AsyncIterable<StreamChunk>;
