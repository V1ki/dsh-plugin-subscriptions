/**
 * Subscription OAuth login page, browser half. Registers the Subscriptions
 * settings section; every login state fact arrives through the node half's
 * `/subscriptions-auth` RPC channel — this plugin holds no credential state of its
 * own. Section copy rides the client locale service: one 'settings.subscriptions'
 * namespace with zh/en dictionaries, rebound per read so the nav label and
 * page text follow the active locale.
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ui-conversation's SlotMap merge (the 'conversation.input.right' entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the slash-command registry contract (the /fast contribution).
import type { CommandUiContract } from '@deepseek-ai/dsh-client-ui-commands/client'
// `.js` extension: this package's tsconfig lacks the reference repo's
// allowImportingTsExtensions/rewriteRelativeImportExtensions pair; under
// nodenext the .js specifier resolves to the .tsx source (see README note).
import { SubscriptionsSection } from './SubscriptionsSection.js'
import type { SubscriptionsSectionInjected } from './SubscriptionsSection.js'
import { ImageGenerateToolview, createImageLoader } from './ImageGenerateToolview.js'
import type { ImageGenerateToolviewInjected } from './ImageGenerateToolview.js'
import { VideoGenerateToolview, createVideoLoader } from './VideoGenerateToolview.js'
import type { VideoGenerateToolviewInjected } from './VideoGenerateToolview.js'
import { SpeedSelect, createSpeedLoader, createSpeedSetter } from './SpeedSelect.js'
import type { SpeedSelectInjected } from './SpeedSelect.js'
import { en, zh } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

export type { SubscriptionsSectionInjected, SubscriptionsSectionProps } from './SubscriptionsSection.js'
export type { ImageGenerateToolviewInjected, ImageGenerateToolviewProps } from './ImageGenerateToolview.js'
export type { VideoGenerateToolviewInjected, VideoGenerateToolviewProps } from './VideoGenerateToolview.js'
export type { SpeedSelectInjected, SpeedSelectProps, SpeedState, SpeedTier } from './SpeedSelect.js'
export type { SubscriptionsKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Subscriptions settings page copy. */
    'settings.subscriptions': SubscriptionsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.subscriptions'

/**
 * Required services (cordis fiber inject): `slots` carries the registration
 * seat, `connection` the `/subscriptions-auth` RPC caller, and `locale` the copy
 * dictionaries.
 */
export const inject = ['slots', 'connection', 'locale']

/**
 * Register the Subscriptions section once the `settings.section` declaration
 * is on the ledger (the shell's apply order relative to this one is NOT
 * constrained; registration depends on the slot through `slots.inject()`).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-subscriptions: copy dictionaries')
  // Settings-shell nudge: the panel (nav title + header row + section body)
  // sits flush against the panel's top edge; push it down a little to leave
  // breathing room. Scoped by the settings panel's own dialog role + nav child
  // so other aria-modal dialogs (e.g. the attachment lightbox) are untouched.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'dsh-plugin-subscriptions')
    style.textContent = 'div[role="dialog"][aria-modal="true"]:has(> nav) { padding-top: 14px; }'
    document.head.appendChild(style)
    return () => style.remove()
  }, 'dsh-plugin-subscriptions: settings panel breathing room')
  // The client-runtime Context merge types `connection` as the host handle;
  // in the browser shell the same key holds the full client ConnectionHandle.
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const t = ctx.locale.bind(NS) as SubscriptionsSectionInjected['t']
  const injected = (): SubscriptionsSectionInjected => ({ rpc: connection.rpc, t })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'subscriptions',
    order: 90,
    // A thunk re-evaluated per read, so the nav label follows the active locale.
    label: () => t('nav'),
    inject: injected,
  }, SubscriptionsSection))

  // The image_generate keyed toolview owns how image calls render inline; its
  // gallery bytes ride the same channel through the injected loader. The
  // framework synthesizes the toolview's own `t` seat from `locale: NS`.
  const toolviewInjected = (): ImageGenerateToolviewInjected => ({ load: createImageLoader(connection.rpc) })
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'image_generate',
    locale: NS,
    inject: toolviewInjected,
  }, ImageGenerateToolview))

  // The video_generate keyed toolview plays the saved MP4 inline; its bytes
  // ride the same channel's `video` endpoint through the injected loader.
  const videoToolviewInjected = (): VideoGenerateToolviewInjected => ({ loadVideo: createVideoLoader(connection.rpc) })
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'video_generate',
    locale: NS,
    inject: videoToolviewInjected,
  }, VideoGenerateToolview))

  // The composer Speed toggle (codex fast tier) sits in the right tool row,
  // just left of the model selector; the framework synthesizes its `t` seat
  // from `locale: NS`, and the inject face binds each session's RPC calls.
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'codex-speed',
    order: 0,
    locale: NS,
    inject: (sessionId: SessionId): SpeedSelectInjected => ({
      loadSpeed: createSpeedLoader(connection, sessionId),
      setSpeed: createSpeedSetter(connection, sessionId),
    }),
  }, SpeedSelect))

  // The /fast slash command offers the same Standard/Fast choice as a popup.
  // `available` is synchronous and sees only the session id, so the command
  // stays listed everywhere; `options` throws the friendly gate when the
  // session's current model is not a fast-capable codex model (the same
  // in-popup error posture the /model contribution uses for its guards).
  ctx.inject(['commandUi'], (scope: ClientContext) => {
    const command = scope.get('commandUi') as CommandUiContract
    scope.effect(() => command.register({
      name: 'fast',
      description: t('commandFast'),
      available: () => true,
      ui: {
        kind: 'popupSelect',
        options: async (session) => {
          const state = await createSpeedLoader(connection, session.sessionId)()
          if (!state.visible) throw new Error(t('commandFastUnavailable'))
          return ([
            { id: 'standard', label: t('speedStandard'), detail: t('speedStandardDescription') },
            { id: 'fast', label: t('speedFast'), detail: t('speedFastDescription') },
          ] as const).map(option => ({ ...option, active: option.id === state.tier }))
        },
        onSelect: async (option, session) => {
          await createSpeedSetter(connection, session.sessionId)(option.id as 'standard' | 'fast')
        },
      },
    }), 'dsh-plugin-subscriptions: /fast contribution')
  })
}
