/**
 * Keyed toolview for the `image_generate` tool: renders generated images
 * inline in the conversation. The row shows the call's prompt while running
 * and after settling; a settled result with image blocks renders them through
 * this plugin's own ImageGallery (harness rc.8 stopped exporting the platform
 * one as a package value), whose bytes load through the node half's
 * `/subscriptions-auth` RPC channel (the durable ImageAttachmentRef is never
 * a fetchable URL on its own). A text-only settled result (degraded route)
 * renders its text; an error result renders the first error line.
 *
 * The 'tool.call.toolview' slot contract is owned by ui-tool
 * (packages/client/ui-tool/src/client/contract/slots.ts), which this package
 * does not resolve; the SlotMap merge and ToolCallOwnerProps below mirror it
 * structurally (same discipline as platform-modules.d.ts).
 */
import type { CSSProperties } from 'react'
import type { ConnectionHandle, RpcResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { ImageGallery } from './ImageGallery.js'
import type { ImageAttachmentRef, ImageLoader, MessageImageLabels } from './ImageGallery.js'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

/** Logical RPC channel served by the node half of this plugin. */
const SUBSCRIPTIONS_AUTH_CHANNEL = '/subscriptions-auth'

/** Title prompt truncation budget (characters). */
const PROMPT_MAX_LENGTH = 60

/** Mirror of ui-tool's ToolCallOwnerProps (see the module header). */
interface ToolCallOwnerProps {
  callId: string
  toolName: string
  block: ToolCallBlock
  cwd?: string | undefined
  openFile: (path: string) => void
  inspect?: (() => void) | undefined
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Mirror of ui-tool's keyed atomic Tool view declaration (see the module header). */
    'tool.call.toolview': { kind: 'keyed'; scope: 'session'; owner: ToolCallOwnerProps }
  }
}

/** Injected dependencies of {@link ImageGenerateToolview} (slot `inject`). */
export interface ImageGenerateToolviewInjected {
  /** Session-authorized image URL loader riding the `/subscriptions-auth` channel. */
  load: ImageLoader
}

/**
 * Props delivered by the toolview outlet: the owner share plus the inject
 * face and the framework locale seat, spread flat.
 */
export type ImageGenerateToolviewProps =
  Partial<ToolCallOwnerProps>
  & Partial<ImageGenerateToolviewInjected>
  & { t?: ((key: SubscriptionsKey, params?: Record<string, unknown>) => string) | undefined }

/** `image` endpoint result: the node half owns this shape. */
interface ImageEndpointResult {
  mediaType: string
  dataBase64: string
}

/**
 * Call one `/subscriptions-auth` endpoint and unwrap the business result.
 * @param rpc - Connection RPC caller.
 * @param endpoint - channel-relative endpoint.
 * @param payload - channel-owned request payload.
 * @returns the success value, cast by the caller to the endpoint's shape.
 */
async function callSubscriptionsAuth<T>(rpc: ConnectionHandle['rpc'], endpoint: string, payload: unknown): Promise<T> {
  const result: RpcResult<unknown> = await rpc.call(SUBSCRIPTIONS_AUTH_CHANNEL, endpoint, payload)
  if (!result.ok) throw new Error(result.error.message)
  return result.value as T
}

/**
 * Build the ImageGallery loader over the `image` endpoint.
 * @param rpc - Connection RPC caller.
 * @returns loader resolving an attachment ref to a data URL.
 */
export function createImageLoader(rpc: ConnectionHandle['rpc']): ImageLoader {
  // The host validates a full ImageAttachmentRef payload (readImage takes the
  // whole ref), so forward the attachment verbatim.
  return attachment =>
    callSubscriptionsAuth<ImageEndpointResult>(rpc, 'image', { ...attachment })
      .then(result => `data:${result.mediaType};base64,${result.dataBase64}`)
}

/**
 * English-dictionary fallback for a missing locale seat (standalone renders);
 * the framework always supplies the namespace-bound one.
 * @param key - dictionary key.
 * @param params - `{name}` template params.
 * @returns the template with params substituted.
 */
function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

/** Extract the prompt from the call's raw args JSON; falls back to the first string value, then the raw line. */
function derivePrompt(argsRaw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    // Non-JSON args (mid-stream truncation): fall back to the raw string below.
    parsed = undefined
  }
  let prompt: string | undefined
  if (typeof parsed === 'object' && parsed !== null) {
    const args = parsed as Record<string, unknown>
    if (typeof args.prompt === 'string' && args.prompt !== '') prompt = args.prompt
    else {
      for (const value of Object.values(args)) {
        if (typeof value === 'string' && value !== '') { prompt = value; break }
      }
    }
  }
  const line = (prompt ?? argsRaw).split('\n', 1)[0] ?? ''
  return line.length > PROMPT_MAX_LENGTH ? `${line.slice(0, PROMPT_MAX_LENGTH)}…` : line
}

/** Flatten a settled result's text blocks (the degraded text-only route and the error line). */
function resultText(block: ToolCallBlock): string {
  if (!('kind' in block)) return ''
  const parts: string[] = []
  for (const part of block.content) {
    if (part.type === 'text') parts.push(part.text)
  }
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  return parts.join('\n')
}

/** Image attachments of a settled result; empty while running or on the text-only route. */
function resultImages(block: ToolCallBlock): { attachment: ImageAttachmentRef }[] {
  if (!('kind' in block)) return []
  const images: { attachment: ImageAttachmentRef }[] = []
  for (const part of block.content) {
    if (part.type === 'image') images.push({ attachment: part.attachment as ImageAttachmentRef })
  }
  return images
}

const styles: Record<string, CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' },
  row: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  icon: { display: 'inline-flex', flexShrink: 0, color: 'var(--dsw-alias-label-tertiary)' },
  title: {
    fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  subtle: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  output: {
    margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)',
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
  },
  error: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
}

/**
 * The `image_generate` keyed toolview component.
 * @param props - owner share, inject face, and locale seat (spread flat).
 * @returns the call row plus, once settled, the gallery / text / error body.
 */
export function ImageGenerateToolview(props: ImageGenerateToolviewProps) {
  const { block, load } = props
  const t = props.t ?? fallbackTranslate
  if (block === undefined) return null
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const title = `image_generate: ${derivePrompt(argsRaw)}`
  const images = resultImages(block)
  const text = settled ? resultText(block) : ''
  const labels: MessageImageLabels = {
    image: t('image'),
    open: t('viewImage'),
    openNamed: name => t('viewImageNamed', { name }),
    loading: t('imageLoading'),
    loadFailed: t('imageLoadFailed'),
    lightbox: { dialog: t('imagePreview'), close: t('imageClose') },
  }
  return (
    <div style={styles.container}>
      <div style={styles.row}>
        <span style={styles.icon}><IconSparkle16 size={14} /></span>
        <span style={styles.title}>{title}</span>
      </div>
      {!settled && <p style={styles.subtle}>{t('generating')}</p>}
      {settled && block.isError && text !== '' && (
        <p style={styles.error}>{text.split('\n', 1)[0]}</p>
      )}
      {settled && !block.isError && images.length > 0 && load !== undefined && (
        <ImageGallery images={images} load={load} labels={labels} />
      )}
      {settled && !block.isError && images.length === 0 && text !== '' && (
        <p style={styles.output}>{text}</p>
      )}
    </div>
  )
}
