/**
 * Mirror of ImageAttachmentRef (packages/attachment/attachment/src/types.ts);
 * the brand on attachmentId is compile-time only, so string suffices here.
 */
export interface ImageAttachmentRef {
    attachmentId: string;
    mediaType: string;
    bytes: number;
    width: number;
    height: number;
    name?: string;
}
/** Loads a session-authorized durable image URL (resolves to a data/blob URL). */
export type ImageLoader = (attachment: ImageAttachmentRef) => Promise<string>;
/** Lightbox strings forwarded to the opened preview. */
export interface ImageLightboxLabels {
    dialog: string;
    close: string;
}
/** Message-image strings the owner resolves from its own locale namespace. */
export interface MessageImageLabels {
    /** Fallback display name for an unnamed image. */
    image: string;
    /** Thumbnail tooltip inviting the original-image preview. */
    open: string;
    /** Accessible thumbnail label; receives the image's display name. */
    openNamed: (label: string) => string;
    /** Loading placeholder shown until bytes resolve. */
    loading: string;
    /** Retry-control label shown when the load fails. */
    loadFailed: string;
    /** Lightbox strings forwarded to the opened preview. */
    lightbox: ImageLightboxLabels;
}
/**
 * Compact history renderer with retryable loading and click-to-open original
 * preview. A lone image renders at its `singleFit` size; an image among
 * several renders as a fixed 64px square tile.
 */
export declare function MessageImage({ attachment, load, variant, labels }: {
    attachment: ImageAttachmentRef;
    load: ImageLoader;
    variant: 'single' | 'tile';
    labels: MessageImageLabels;
}): import("react").JSX.Element;
/** Wrapping image group: a lone image renders large, several render as 64px
 * square tiles (same rule as the platform gallery). */
export declare function ImageGallery({ images, load, labels }: {
    images: readonly {
        attachment: ImageAttachmentRef;
    }[];
    load: ImageLoader;
    labels: MessageImageLabels;
}): import("react").JSX.Element | null;
