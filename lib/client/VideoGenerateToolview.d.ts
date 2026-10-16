import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client';
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SubscriptionsKey } from './locales.js';
/** Mirror of ui-tool's ToolCallOwnerProps (see ImageGenerateToolview). */
interface ToolCallOwnerProps {
    callId: string;
    toolName: string;
    block: ToolCallBlock;
    cwd?: string | undefined;
    openFile: (path: string) => void;
    inspect?: (() => void) | undefined;
}
/** Decoded video bytes as the node half's `video` endpoint answers them. */
export interface VideoBytes {
    mediaType: string;
    dataBase64: string;
}
/** Injected dependencies of {@link VideoGenerateToolview} (slot `inject`). */
export interface VideoGenerateToolviewInjected {
    /** Loads one generated video's bytes by bare file name. */
    loadVideo: (name: string) => Promise<VideoBytes>;
}
/**
 * Props delivered by the toolview outlet: the owner share plus the inject
 * face and the framework locale seat, spread flat.
 */
export type VideoGenerateToolviewProps = Partial<ToolCallOwnerProps> & Partial<VideoGenerateToolviewInjected> & {
    t?: ((key: SubscriptionsKey, params?: Record<string, unknown>) => string) | undefined;
};
/**
 * Build the video loader over the `/subscriptions-auth` `video` endpoint.
 * @param rpc - Connection RPC caller.
 * @returns loader resolving a bare file name to the decoded bytes.
 */
export declare function createVideoLoader(rpc: ConnectionHandle['rpc']): (name: string) => Promise<VideoBytes>;
/**
 * The `video_generate` keyed toolview component.
 * @param props - owner share, inject face, and locale seat (spread flat).
 * @returns the call row plus, once settled, the player / text / error body.
 */
export declare function VideoGenerateToolview(props: VideoGenerateToolviewProps): import("react").JSX.Element | null;
export {};
