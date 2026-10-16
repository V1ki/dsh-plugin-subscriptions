import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client';
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ImageLoader } from './ImageGallery.js';
import type { SubscriptionsKey } from './locales.js';
/** Mirror of ui-tool's ToolCallOwnerProps (see the module header). */
interface ToolCallOwnerProps {
    callId: string;
    toolName: string;
    block: ToolCallBlock;
    cwd?: string | undefined;
    openFile: (path: string) => void;
    inspect?: (() => void) | undefined;
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        /** Mirror of ui-tool's keyed atomic Tool view declaration (see the module header). */
        'tool.call.toolview': {
            kind: 'keyed';
            scope: 'session';
            owner: ToolCallOwnerProps;
        };
    }
}
/** Injected dependencies of {@link ImageGenerateToolview} (slot `inject`). */
export interface ImageGenerateToolviewInjected {
    /** Session-authorized image URL loader riding the `/subscriptions-auth` channel. */
    load: ImageLoader;
}
/**
 * Props delivered by the toolview outlet: the owner share plus the inject
 * face and the framework locale seat, spread flat.
 */
export type ImageGenerateToolviewProps = Partial<ToolCallOwnerProps> & Partial<ImageGenerateToolviewInjected> & {
    t?: ((key: SubscriptionsKey, params?: Record<string, unknown>) => string) | undefined;
};
/**
 * Build the ImageGallery loader over the `image` endpoint.
 * @param rpc - Connection RPC caller.
 * @returns loader resolving an attachment ref to a data URL.
 */
export declare function createImageLoader(rpc: ConnectionHandle['rpc']): ImageLoader;
/**
 * The `image_generate` keyed toolview component.
 * @param props - owner share, inject face, and locale seat (spread flat).
 * @returns the call row plus, once settled, the gallery / text / error body.
 */
export declare function ImageGenerateToolview(props: ImageGenerateToolviewProps): import("react").JSX.Element | null;
export {};
