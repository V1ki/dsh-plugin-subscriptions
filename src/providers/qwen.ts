/** Qwen Code subscription protocol (not the legacy Qwen OAuth API). */
import { EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { proxiedFetch } from '../http.js'
import { resolveImages } from '../translate/resolved.js'
import { streamChatCompletions, toChatMessages, toChatTools } from '../translate/chat-completions.js'
import { idleWatchdog, mapFetchFailure, mergeReasoning } from './common.js'

export const QWEN_AUTH_URL = 'https://auth.qwen.ai/api/oauth'
export const QWEN_GATEWAY_URL = 'https://api.qwen.ai/compatible-mode/v1'
export const QWEN_CLIENT_ID = 'qwen-code-cli'
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
type Fetch = typeof fetch
export interface QwenTokens { accessToken: string; refreshToken: string; expiresAt: number; scope: string }
export interface QwenDeviceAuthorization { deviceCode: string; userCode: string; verificationUrl: string; expiresAt: number; intervalMs: number }
export class QwenOAuthError extends Error {
  constructor(readonly code: string, readonly status?: number, readonly retryAfterMs?: number) { super('Qwen OAuth: ' + code); this.name = 'QwenOAuthError' }
}
/** Only invalid_grant from a refresh operation invalidates persisted credentials. */
export function isQwenPermanentRefreshError(error: unknown): boolean { return error instanceof QwenOAuthError && error.code === 'invalid_grant' }
const OAUTH_ERROR_CODES = new Set(['authorization_pending', 'slow_down', 'expired_token', 'access_denied', 'invalid_grant', 'invalid_request', 'invalid_client', 'invalid_scope', 'unauthorized_client', 'unsupported_grant_type', 'temporarily_unavailable', 'server_error'])
function safeOAuthCode(value: unknown): string { return typeof value === 'string' && OAUTH_ERROR_CODES.has(value) ? value : 'oauth_error' }
function str(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QwenOAuthError('invalid_response'); return value as Record<string, unknown> }
function retryAfter(value: string | null): number | undefined { if (!value) return undefined; const seconds = Number(value); const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now(); return Number.isFinite(ms) ? Math.max(0, ms) : undefined }
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
export class QwenOAuthClient {
  constructor(private readonly fetchFn: Fetch = proxiedFetch, private readonly requestTimeoutMs = 30_000) {}
  private async request(path: string, form?: Record<string, string>, token?: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
    combined.throwIfAborted()
    const response = await this.fetchFn(oauthUrl(path), {
      method: form ? 'POST' : 'GET', redirect: 'error', signal: combined,
      headers: { accept: 'application/json', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(token ? { authorization: bearer(token) } : {}) },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    })
    if (response.ok && path === 'revoke') return undefined
    const data = await response.json().catch(() => undefined)
    combined.throwIfAborted()
    if (!response.ok) { const e = data && typeof data === 'object' ? data as Record<string, unknown> : {}; throw new QwenOAuthError(safeOAuthCode(e.error), response.status, retryAfter(response.headers.get('retry-after'))) }
    return data
    } catch (error) {
      signal?.throwIfAborted()
      if (timeout.aborted) throw new QwenOAuthError('request_timeout')
      throw error
    }
  }
  async start(signal?: AbortSignal): Promise<QwenDeviceAuthorization> {
    const issuedAt = Date.now()
    const d = record(await this.request('device/code', { client_id: QWEN_CLIENT_ID, scope: 'model:invoke profile:read' }, undefined, signal))
    if (!str(d.device_code) || !str(d.user_code) || !str(d.verification_uri) || !str(d.verification_uri_complete) || !positive(d.expires_in) || !positive(d.interval)) throw new QwenOAuthError('invalid_response')
    // Use the official browser origin rather than forwarding an untrusted response URL.
    const url = new URL('https://chat.qwen.ai/authorize'); url.searchParams.set('user_code', d.user_code); url.searchParams.set('client', 'desktop'); url.searchParams.set('entry', 'qwen_code'); url.searchParams.set('paywallScene', 'desktop')
    return { deviceCode: d.device_code, userCode: d.user_code, verificationUrl: url.toString(), expiresAt: issuedAt + d.expires_in * 1000, intervalMs: d.interval * 1000 }
  }
  private tokens(data: unknown): QwenTokens {
    const d = record(data)
    if (!str(d.access_token) || !str(d.refresh_token) || d.token_type !== 'Bearer' || !positive(d.expires_in) || typeof d.scope !== 'string') throw new QwenOAuthError('invalid_response')
    return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: Date.now() + d.expires_in * 1000, scope: d.scope }
  }
  async poll(grant: QwenDeviceAuthorization, signal?: AbortSignal): Promise<QwenTokens> {
    let interval = grant.intervalMs, delay = interval
    const timeout = AbortSignal.timeout(Math.max(1, grant.expiresAt - Date.now()))
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      while (Date.now() < grant.expiresAt) {
        await wait(Math.min(delay, Math.max(0, grant.expiresAt - Date.now())), combined)
        if (Date.now() >= grant.expiresAt) break
        try { return this.tokens(await this.request('token', { grant_type: GRANT, client_id: QWEN_CLIENT_ID, device_code: grant.deviceCode }, undefined, combined)) }
        catch (error) {
          combined.throwIfAborted()
          if (!(error instanceof QwenOAuthError)) { if (error instanceof TypeError) { delay = Math.max(interval, delay * 2); continue } throw error }
          if (error.status === 400 && error.code === 'authorization_pending') { delay = interval; continue }
          if (error.status === 400 && error.code === 'slow_down') { interval += 5000; delay = interval; continue }
          if (error.code === 'request_timeout' || error.status === 429 || (error.status !== undefined && error.status >= 500)) { delay = Math.max(interval, delay * 2, error.retryAfterMs ?? 0); continue }
          throw error
        }
      }
    } catch (error) { signal?.throwIfAborted(); if (!timeout.aborted) throw error }
    throw new QwenOAuthError('expired_token')
  }
  async refresh(refreshToken: string, signal?: AbortSignal): Promise<QwenTokens> { return this.tokens(await this.request('token', { grant_type: 'refresh_token', client_id: QWEN_CLIENT_ID, refresh_token: refreshToken }, undefined, signal)) }
  async userInfo(token: string, signal?: AbortSignal): Promise<{ sub: string; name: string; email: string; memberType: string }> {
    const d = record(await this.request('userinfo', undefined, token, signal))
    if (!str(d.sub) || typeof d.name !== 'string' || typeof d.email !== 'string' || !str(d.member_type)) throw new QwenOAuthError('invalid_response')
    return { sub: d.sub, name: d.name, email: d.email, memberType: d.member_type }
  }
  async revoke(token: string, signal?: AbortSignal): Promise<void> { await this.request('revoke', { client_id: QWEN_CLIENT_ID, token, token_type_hint: 'refresh_token' }, undefined, signal) }
}
function oauthUrl(path: string): string { return QWEN_AUTH_URL + '/' + path }
function bearer(token: string): string { return 'Bearer ' + token }

/** Host must atomically persist rotated pairs and serialize refresh; rejectedToken enables compare-and-refresh. */
export interface QwenTokenSource { getAccessToken(signal?: AbortSignal, rejectedToken?: string): Promise<string> }
export interface QwenQuotaExhaustion { observedAt: number; resetsAt?: number }
export interface QwenAdapterOptions { tokens: QwenTokenSource; fetchFn?: Fetch; resolveAttachments?: () => AttachmentStore | undefined; streamIdleTimeoutMs: number; userAgent?: string; defaultEffortOf?: (model: string) => string | undefined; onQuotaExhausted?: (observation: QwenQuotaExhaustion) => void }
/** Never include gateway body or upstream messages, which can echo credentials. */
async function qwenHttpError(response: Response, onQuotaExhausted?: (observation: QwenQuotaExhaustion) => void): Promise<LlmError> {
  const data = await response.json().catch(() => undefined) as { error?: { code?: unknown; quota?: { reset_at?: unknown } } } | undefined
  const quota = response.status === 402 && data?.error?.code === 'insufficient_quota'
  const status = response.status
  const code = status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : quota ? 'QUOTA' : status === 400 && data?.error?.code === 'context_length_exceeded' ? 'CONTEXT_WINDOW_EXCEEDED' : status === 408 || status === 504 ? 'TIMEOUT' : status >= 500 ? 'SERVER' : `HTTP_${status}` as `HTTP_${number}`
  let retry = retryAfter(response.headers.get('retry-after'))
  let message = `Qwen gateway error (HTTP ${status})`
  if (quota) {
    const observedAt = Date.now()
    const reset = data?.error?.quota?.reset_at
    const ms = typeof reset === 'number' && Number.isSafeInteger(reset) ? reset * 1000 : NaN
    const resetsAt = ms > observedAt && Number.isFinite(new Date(ms).getTime()) ? ms : undefined
    // Both hints are lower bounds: never retry before either advertised delay.
    if (resetsAt !== undefined) retry = Math.max(retry ?? 0, resetsAt - observedAt)
    message = `Qwen quota exhausted (HTTP ${status}); ${resetsAt === undefined ? 'reset not provided' : 'reset ' + new Date(resetsAt).toISOString()}`
    try { onQuotaExhausted?.({ observedAt, ...(resetsAt === undefined ? {} : { resetsAt }) }) } catch { /* Observation hooks must never replace the sanitized gateway error. */ }
  }
  return new LlmError(message, code, { status, ...(retry === undefined ? {} : { providerRetryAfterMs: retry }) })
}

class QwenNetworkError extends Error { constructor(cause: unknown) { super('Qwen network request failed', { cause }) } }
interface Model { id: string; inputModalities?: ('text' | 'image')[]; contextWindow?: number }
export class QwenAdapter extends LlmAdapter {
  private models: Model[] = []
  private catalogRevision = 0
  /** Successful chat completion supersedes quota failures from earlier requests. */
  private chatSuccessRevision = 0
  constructor(private readonly options: QwenAdapterOptions) { super() }
  override providerInfo(provider: string) { return { id: provider, name: 'Qwen Subscription' } }
  clearCatalog(): void { this.catalogRevision++; this.models = [] }
  private async gateway(path: '/models' | '/chat/completions', init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const fetchFn = this.options.fetchFn ?? proxiedFetch
    const token = await this.options.tokens.getAccessToken(signal)
    const send = async (access: string): Promise<Response> => {
      try { return await fetchFn(QWEN_GATEWAY_URL + path, { ...init, ...(signal ? { signal } : {}), redirect: 'error', headers: { ...init.headers, authorization: bearer(access), 'user-agent': this.options.userAgent ?? userAgent() } }) }
      catch (error) { signal?.throwIfAborted(); if (error instanceof TypeError) throw new QwenNetworkError(error); throw error }
    }
    let response = await send(token)
    if (response.status === 401) { await response.body?.cancel(); const refreshed = await this.options.tokens.getAccessToken(signal, token); response = await send(refreshed) }
    return response
  }
  /** Cached rows belong to this adapter's account; callers must clear on login changes. */
  private modelRows(provider: string): LlmModelInfo[] {
    return this.models.map(m => ({ provider, id: m.id, name: m.id, ...(m.inputModalities ? { inputModalities: m.inputModalities } : {}) }))
  }
  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    return (await this.listModelsResult(provider, signal)).models
  }
  /** Freshness is request-local so overlapping refreshes cannot overwrite it. */
  async listModelsResult(provider: string, signal?: AbortSignal): Promise<{ models: readonly LlmModelInfo[]; fallback: boolean }> {
    const revision = this.catalogRevision
    const chatRevision = this.chatSuccessRevision
    let response: Response
    try {
      response = await this.gateway('/models', { headers: { accept: 'application/json' } }, signal)
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof QwenNetworkError && revision === this.catalogRevision && this.models.length) return { models: this.modelRows(provider), fallback: true }
      throw error
    }
    signal?.throwIfAborted()
    if (!response.ok) {
      if (response.status >= 500 && revision === this.catalogRevision && this.models.length) { await response.body?.cancel(); signal?.throwIfAborted(); if (revision !== this.catalogRevision) throw new Error('Qwen login changed during model discovery'); return { models: this.modelRows(provider), fallback: true } }
      throw await qwenHttpError(response, observation => { if (revision === this.catalogRevision && chatRevision === this.chatSuccessRevision) this.options.onQuotaExhausted?.(observation) })
    }
    const data = await response.json() as { data?: unknown }
    if (!Array.isArray(data.data) || data.data.length === 0) throw new Error('Qwen model catalog is invalid')
    const models: Model[] = data.data.map((item: unknown) => {
      const m = record(item); if (!str(m.id) || m.id.length > 256 || /[,\p{C}\p{Zl}\p{Zp}]/u.test(m.id)) throw new Error('Qwen model catalog is invalid')
      const modalities = Array.isArray(m.input_modalities) && m.input_modalities.length && m.input_modalities.every((v: unknown) => ['text', 'image', 'video', 'audio', 'pdf'].includes(String(v))) ? (m.input_modalities as string[]).filter((v): v is 'text' | 'image' => v === 'text' || v === 'image') : undefined
      return { id: m.id, ...(modalities !== undefined ? { inputModalities: modalities } : {}), ...(Number.isSafeInteger(m.context_window_tokens) && (m.context_window_tokens as number) > 0 ? { contextWindow: m.context_window_tokens as number } : {}) }
    })
    signal?.throwIfAborted()
    if (revision !== this.catalogRevision) throw new Error('Qwen login changed during model discovery')
    this.models = models
    return { models: this.modelRows(provider), fallback: false }
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const found = this.models.find(m => m.id === model)
    if (this.models.length && !found) throw new Error('Qwen model is not in the account catalog')
    const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), {
      efforts: ['off', 'low', 'medium', 'high'].map(level => ({ id: ReasoningEffortId(level), name: level[0]!.toUpperCase() + level.slice(1) })),
      defaultEffort: ReasoningEffortId('medium'),
    })
    return { provider, id: model, name: model, ...(found?.inputModalities ? { inputModalities: found.inputModalities } : {}), ...(found?.contextWindow ? { context: { contextWindow: found.contextWindow } } : {}), ...(reasoning ? { reasoning } : {}) }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const revision = this.catalogRevision
    const chatRevision = this.chatSuccessRevision
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), watchdog.signal)
      const configuredEffort = this.options.defaultEffortOf?.(options.model)
      const effort = String(options.reasoningEffort ?? (['off', 'low', 'medium', 'high'].includes(configuredEffort ?? '') ? configuredEffort : 'medium'))
      const budget = effort === 'low' ? 4096 : effort === 'high' || effort === 'xhigh' || effort === 'max' ? 32768 : 16384
      const wireMessages = toChatMessages(messages, options.system)
      // The shared translator intentionally discards reasoning. Qwen Code replays it
      // alongside the assistant tool calls that produced it, without changing other providers.
      for (const message of messages) {
        if (message.role !== 'assistant') continue
        const calls = message.content.filter(block => block.type === 'tool-call')
        const reasoning = message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
        if (!reasoning || !calls.length) continue
        const ids = new Set(calls.map(call => String(call.id)))
        const wire = wireMessages.find(entry => entry.role === 'assistant' && Array.isArray(entry.tool_calls) && entry.tool_calls.some((call: { id?: string }) => ids.has(String(call.id))))
        if (wire) wire.reasoning_content = reasoning
      }
      const body = { model: options.model, messages: wireMessages, ...(options.tools?.length ? { tools: toChatTools(options.tools), tool_choice: 'auto' } : {}), ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}), ...(options.temperature !== undefined ? { temperature: options.temperature } : {}), ...(options.stop !== undefined ? { stop: options.stop } : {}), enable_thinking: effort !== 'off', ...(effort === 'off' ? {} : { thinking_budget: budget }), stream: true, stream_options: { include_usage: true } }
      const response = await this.gateway('/chat/completions', { method: 'POST', headers: { accept: 'text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify(body) }, watchdog.signal)
      if (!response.ok) throw await qwenHttpError(response, observation => { if (revision === this.catalogRevision && chatRevision === this.chatSuccessRevision) this.options.onQuotaExhausted?.(observation) })
      if (!response.body) throw new LlmError('qwen API returned no response body', EMPTY_RESPONSE_CODE)
      for await (const chunk of streamChatCompletions(response.body, () => watchdog.pulse())) {
        // Consumers may stop immediately at finish, without requesting another next().
        if (chunk.type === 'finish' && chunk.reason.kind !== 'error' && revision === this.catalogRevision) this.chatSuccessRevision++
        yield chunk
      }
    } catch (error) {
      throw mapFetchFailure('qwen API', error, watchdog, options.signal)
    } finally { watchdog.stop() }
  }
}
function userAgent(): string { return 'QwenCode/unknown (' + process.platform + '; ' + process.arch + ')' }
