/**
 * Google Antigravity subscription provider. This is intentionally separate
 * from Gemini CLI: it uses Antigravity OAuth scopes, project discovery, and
 * the daily-cloudcode-pa v1internal request envelope.
 */
import { errorChain, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { resolveImages } from '../translate/resolved.js';
import { antigravityReasoning } from '../translate/antigravity-thinking.js';
import { parseAntigravityResponse, streamAntigravity, toAntigravityRequest, } from '../translate/antigravity.js';
import { httpLlmError, idleWatchdog, mapFetchFailure, mergeReasoning, ModelCatalogCache, discoverOrRetryAuth, isMissingOrInvalidCredential, oauthEndpointError, OAuthEndpointError, discoverAcrossAccounts, isDiscoveryAborted, } from './common.js';
import { proxiedFetch } from '../http.js';
import { ANTIGRAVITY_DEFAULT_CLIENT_ID, ANTIGRAVITY_DEFAULT_CLIENT_SECRET } from './antigravity-oauth-client.js';
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js';
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, subscriptionRetryPolicy } from './rate-limit.js';
export const ANTIGRAVITY_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const ANTIGRAVITY_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
export const ANTIGRAVITY_DEFAULT_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_PROD_BASE_URL = 'https://cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_DEFAULT_USER_AGENT = 'antigravity/1.104.0 dsh-plugin-subscriptions';
export const ANTIGRAVITY_PREEMPT_MS = 5 * 60_000;
const ANTIGRAVITY_CALLBACK_PATH = '/oauth-callback';
const ANTIGRAVITY_CONTEXT_WINDOW = 1_024_000;
// Fallback only when discovery is unavailable or the model omits its output cap.
const ANTIGRAVITY_DEFAULT_MAX_TOKENS = 32_768;
/** Antigravity, not Gemini CLI, OAuth scopes from the local reference clients. */
export const ANTIGRAVITY_SCOPES = [
    'openid',
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
];
/** Resolve a client pair: plugin config, environment, then the public desktop default. */
export function resolveAntigravityOAuthConfig(config) {
    const configuredId = config?.clientId?.trim();
    const configuredSecret = config?.clientSecret?.trim();
    const environmentId = process.env.ANTIGRAVITY_CLIENT_ID?.trim();
    const environmentSecret = process.env.ANTIGRAVITY_CLIENT_SECRET?.trim();
    if (configuredId) {
        // A custom PKCE-only client must never inherit a different client's secret.
        return { clientId: configuredId, ...configuredSecret ? { clientSecret: configuredSecret } : {} };
    }
    if (configuredSecret)
        throw new Error('config.antigravity.clientSecret requires config.antigravity.clientId');
    if (environmentId) {
        return { clientId: environmentId, ...environmentSecret ? { clientSecret: environmentSecret } : {} };
    }
    if (environmentSecret)
        throw new Error('ANTIGRAVITY_CLIENT_SECRET requires ANTIGRAVITY_CLIENT_ID');
    return { clientId: ANTIGRAVITY_DEFAULT_CLIENT_ID, clientSecret: ANTIGRAVITY_DEFAULT_CLIENT_SECRET };
}
/** Normalize the configured API origin and reject paths/credentials. */
export function antigravityBaseURL(value) {
    const parsed = new URL(value?.trim() || ANTIGRAVITY_DEFAULT_BASE_URL);
    if (parsed.protocol !== 'https:' || parsed.username.length > 0 || parsed.password.length > 0) {
        throw new Error('config.antigravity.baseURL must be an HTTPS origin without credentials');
    }
    if (parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0) {
        throw new Error('config.antigravity.baseURL must not contain a path, query, or fragment');
    }
    return parsed.origin;
}
/** Try the production endpoint only when the default endpoint is unavailable. */
async function fetchAntigravity(method, init, runtime, fetchFn) {
    // Explicit origins stay pinned, and onboarding is not repeated across endpoints.
    const endpoints = runtime.baseURL?.trim() || method === 'onboardUser'
        ? [antigravityBaseURL(runtime.baseURL)]
        : [ANTIGRAVITY_DEFAULT_BASE_URL, ANTIGRAVITY_PROD_BASE_URL];
    for (const [index, endpoint] of endpoints.entries()) {
        init.signal?.throwIfAborted();
        let response;
        try {
            response = await fetchFn(`${endpoint}/v1internal:${method}`, init);
        }
        catch (error) {
            if (init.signal?.aborted || index === endpoints.length - 1)
                throw error;
            continue;
        }
        if (index === endpoints.length - 1 || ![404, 502, 503, 504].includes(response.status))
            return response;
        await response.body?.cancel();
    }
    throw new Error('Antigravity endpoint list is empty');
}
/** Google authorization-code + PKCE flow for Antigravity. */
export function antigravityFlow(oauth) {
    return {
        callbackPath: ANTIGRAVITY_CALLBACK_PATH,
        listen: { host: 'localhost', ports: [51121, 0] },
        timeoutMs: 5 * 60_000,
        buildAuthorizeUrl({ redirectUri, state, pkce }) {
            const params = new URLSearchParams({
                access_type: 'offline',
                client_id: oauth.clientId,
                code_challenge: pkce.challenge,
                code_challenge_method: 'S256',
                include_granted_scopes: 'true',
                prompt: 'consent',
                redirect_uri: redirectUri,
                response_type: 'code',
                scope: ANTIGRAVITY_SCOPES.join(' '),
                state,
            });
            return `${ANTIGRAVITY_AUTHORIZE_URL}?${params.toString()}`;
        },
    };
}
/** Shared Antigravity API headers. */
export function antigravityHeaders(accessToken, userAgent = ANTIGRAVITY_DEFAULT_USER_AGENT) {
    return {
        'authorization': `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'user-agent': userAgent,
    };
}
/** POST a v1internal JSON method and classify non-2xx responses. */
async function callInternal(method, body, accessToken, runtime, fetchFn, signal) {
    const response = await fetchAntigravity(method, {
        method: 'POST',
        headers: antigravityHeaders(accessToken, runtime.userAgent),
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
    }, runtime, fetchFn);
    if (!response.ok)
        throw await httpLlmError(response, `Antigravity ${method}`);
    return response.json();
}
function projectIdOf(value) {
    if (typeof value === 'string' && value.length > 0)
        return value;
    if (typeof value === 'object' && value !== null) {
        const id = value.id;
        if (typeof id === 'string' && id.length > 0)
            return id;
    }
    return undefined;
}
/** Read (and, when enabled, initialize) the Antigravity project/account. */
export async function discoverAntigravityAccount(accessToken, runtime = {}, fetchFn = proxiedFetch) {
    const metadata = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };
    const load = await callInternal('loadCodeAssist', { metadata }, accessToken, runtime, fetchFn);
    let projectId = projectIdOf(load.cloudaicompanionProject);
    if (projectId === undefined && runtime.onboard !== false) {
        const tierId = load.allowedTiers?.find(tier => tier.isDefault)?.id ?? 'LEGACY';
        const onboardBody = { tierId, metadata };
        for (let attempt = 0; attempt < 10; attempt++) {
            const result = await callInternal('onboardUser', onboardBody, accessToken, runtime, fetchFn);
            if (result.done === true) {
                projectId = projectIdOf(result.response?.cloudaicompanionProject);
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 1_000));
        }
    }
    if (projectId === undefined) {
        throw new Error('Antigravity account has no Cloud AI Companion project; open Antigravity and complete onboarding, then log in again');
    }
    let account;
    try {
        const profileResponse = await fetchFn(ANTIGRAVITY_USERINFO_URL, {
            headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        });
        if (profileResponse.ok) {
            const profile = await profileResponse.json();
            if (typeof profile.email === 'string' && profile.email.length > 0)
                account = profile.email;
        }
    }
    catch {
        // Identity is display-only; project discovery is the login boundary.
    }
    const plan = load.paidTier?.name ?? load.paidTier?.id ?? load.currentTier?.name ?? load.currentTier?.id;
    return {
        projectId,
        ...account === undefined ? {} : { account },
        ...typeof plan !== 'string' || plan.length === 0 ? {} : { plan },
    };
}
function sessionFromTokens(tokens, account, fallback) {
    if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
        throw new Error('Antigravity token endpoint returned no access token');
    }
    const refreshToken = tokens.refresh_token ?? fallback?.refreshToken;
    if (refreshToken === undefined || refreshToken.length === 0) {
        throw new Error('Antigravity token endpoint returned no refresh token; revoke the app grant and log in again');
    }
    if (typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0) {
        throw new Error('Antigravity token endpoint returned no usable expiry');
    }
    return {
        accessToken: tokens.access_token,
        refreshToken,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        projectId: account.projectId,
        ...tokens.scope === undefined ? {} : { scopes: tokens.scope },
        ...account.account === undefined ? {} : { account: account.account },
        ...account.plan === undefined ? {} : { plan: account.plan },
    };
}
/** Exchange a Google OAuth authorization code and discover the Antigravity project. */
export async function exchangeAntigravityCode(code, verifier, redirectUri, oauth, runtime = {}, fetchFn = proxiedFetch) {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: oauth.clientId,
        code_verifier: verifier,
        ...oauth.clientSecret === undefined ? {} : { client_secret: oauth.clientSecret },
    });
    const response = await fetchFn(ANTIGRAVITY_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'Antigravity');
    const tokens = await response.json();
    if (typeof tokens.access_token !== 'string')
        throw new Error('Antigravity token endpoint returned no access token');
    const account = await discoverAntigravityAccount(tokens.access_token, runtime, fetchFn);
    return sessionFromTokens(tokens, account);
}
/** Refresh a stored Antigravity Google token, preserving project/account metadata. */
export async function refreshAntigravity(session, oauth, fetchFn = proxiedFetch) {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        client_id: oauth.clientId,
        ...oauth.clientSecret === undefined ? {} : { client_secret: oauth.clientSecret },
    });
    const response = await fetchFn(ANTIGRAVITY_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'Antigravity');
    return sessionFromTokens(await response.json(), {
        projectId: session.projectId,
        ...session.account === undefined ? {} : { account: session.account },
        ...session.plan === undefined ? {} : { plan: session.plan },
    }, session);
}
/** Refresh failures that require a fresh Google consent grant. */
export function isAntigravityPermanentRefreshError(error) {
    return error instanceof OAuthEndpointError
        && (error.status === 400 || error.status === 401 || error.status === 403)
        && (error.oauthCode === 'invalid_grant' || error.status !== 400);
}
/** Fetch the authenticated account's live Antigravity model catalog. */
export async function fetchAntigravityModels(session, runtime = {}, fetchFn = proxiedFetch, signal) {
    const payload = await callInternal('fetchAvailableModels', { project: session.projectId }, session.accessToken, runtime, fetchFn, signal);
    if (typeof payload.models !== 'object' || payload.models === null) {
        throw new Error('Antigravity models endpoint returned no models object');
    }
    const models = Object.entries(payload.models).map(([id, model]) => ({
        id,
        name: model.displayName ?? id.split('-').map(word => word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)).join(' '),
        ...model.description === undefined ? {} : { description: model.description },
        contextWindow: model.inputTokenLimit ?? model.maxInputTokens ?? ANTIGRAVITY_CONTEXT_WINDOW,
        ...typeof model.maxOutputTokens === 'number' && Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens > 0
            ? { maxOutputTokens: model.maxOutputTokens } : {},
        inputModalities: ['text', 'image'],
    }));
    if (models.length === 0)
        throw new Error('Antigravity models endpoint returned an empty catalog');
    return models;
}
function resetTime(value) {
    if (typeof value !== 'string')
        return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function usageWindow(kind, scope, quota) {
    const remaining = quota?.remainingFraction;
    if (typeof remaining !== 'number' || !Number.isFinite(remaining))
        return undefined;
    const resetsAt = resetTime(quota?.resetTime);
    return {
        kind,
        scope,
        usedPercent: Math.max(0, Math.min(100, (1 - remaining) * 100)),
        ...resetsAt === undefined ? {} : { resetsAt },
    };
}
/** Fetch plan and per-model quota windows when the upstream exposes them. */
export async function fetchAntigravityUsage(session, runtime = {}, fetchFn = proxiedFetch, signal) {
    const metadata = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };
    const [models, account] = await Promise.all([
        callInternal('fetchAvailableModels', { project: session.projectId }, session.accessToken, runtime, fetchFn, signal),
        callInternal('loadCodeAssist', { metadata }, session.accessToken, runtime, fetchFn, signal),
    ]);
    const windows = [];
    for (const [modelId, model] of Object.entries(models.models ?? {})) {
        const ordinary = usageWindow('other', modelId, model.quotaInfo);
        const weekly = usageWindow('weekly', modelId, model.weeklyQuotaInfo ?? model.weeklyQuota);
        if (ordinary !== undefined)
            windows.push(ordinary);
        if (weekly !== undefined)
            windows.push(weekly);
    }
    const plan = account.paidTier?.name ?? account.paidTier?.id
        ?? account.currentTier?.name ?? account.currentTier?.id ?? session.plan;
    const credits = account.paidTier?.availableCredits?.[0]?.creditAmount;
    const displayPlan = credits === undefined ? plan : `${plan ?? 'Antigravity'} · ${String(credits)} credits`;
    return {
        supported: true,
        windows,
        ...displayPlan === undefined ? {} : { plan: displayPlan },
    };
}
/** URL for either v1internal generation transport. */
export function antigravityGenerateURL(baseURL, stream) {
    return `${antigravityBaseURL(baseURL)}/v1internal:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
}
/** Forward one already-built payload to generateContent or streamGenerateContent. */
export async function requestAntigravityContent(session, payload, stream, runtime = {}, fetchFn = proxiedFetch, signal) {
    return fetchAntigravity(stream ? 'streamGenerateContent?alt=sse' : 'generateContent', {
        method: 'POST',
        headers: {
            ...antigravityHeaders(session.accessToken, runtime.userAgent),
            accept: stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(payload),
        ...signal === undefined ? {} : { signal },
    }, runtime, fetchFn);
}
/** DSH provider adapter for the `antigravity` route. */
export class AntigravityAdapter extends LlmAdapter {
    options;
    catalog;
    accountCatalogs = new Map();
    accountCatalogsInvalidated = false;
    invalidatedAccounts = new Set();
    catalogOwner;
    constructor(options) {
        super();
        this.options = options;
        this.catalog = new ModelCatalogCache(options.catalogStore, undefined, options.onCatalogChanged);
    }
    providerInfo(provider) {
        return { id: provider, name: 'Google Antigravity' };
    }
    /** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
    clearAccountCatalog(account) {
        if (account === undefined) {
            this.accountCatalogsInvalidated = true;
            this.invalidatedAccounts.clear();
        }
        else
            this.invalidatedAccounts.add(account);
        if (account === undefined) {
            for (const cache of this.accountCatalogs.values())
                cache.invalidate();
            this.accountCatalogs.clear();
        }
        else {
            this.accountCatalogs.get(account)?.invalidate();
            this.accountCatalogs.delete(account);
        }
        if (account === undefined || this.catalogOwner === account || this.catalogOwner === undefined) {
            this.catalogOwner = undefined;
            this.catalog.invalidate();
        }
    }
    /** Default and secondary accounts each seed their own persisted catalog. */
    async catalogFor(account) {
        const defaultKey = await this.options.tokens.defaultAccount();
        const key = account ?? defaultKey;
        if (key === undefined || key === defaultKey) {
            if (this.catalogOwner !== undefined && this.catalogOwner !== defaultKey) {
                this.catalog.invalidate();
            }
            this.catalogOwner = defaultKey;
            return this.catalog;
        }
        let cache = this.accountCatalogs.get(key);
        if (cache === undefined) {
            cache = new ModelCatalogCache(this.options.accountCatalogStore?.(key), undefined, this.options.onCatalogChanged);
            const invalidated = this.invalidatedAccounts.delete(key);
            if (this.accountCatalogsInvalidated || invalidated)
                cache.invalidate();
            this.accountCatalogs.set(key, cache);
        }
        return cache;
    }
    providerRetryPolicy(provider) {
        return subscriptionRetryPolicy(DEFAULT_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `antigravity: provider "${provider}" retryPolicy`);
    }
    staticModels(provider) {
        return this.options.models.map(model => ({
            provider,
            id: model.id,
            name: model.name ?? model.id,
            inputModalities: model.inputModalities ?? ['text', 'image'],
        }));
    }
    fetchCatalog(account, signal) {
        return this.options.tokens.session(account).then(session => fetchAntigravityModels(session, this.options.runtime, this.options.fetchFn, signal));
    }
    async listModels(provider) {
        const own = await this.listOwnModels(provider, undefined, undefined, true);
        const pool = this.options.pool?.();
        if (pool === undefined)
            return own;
        const extra = await pool.modelsForProvider(provider);
        const seen = new Set(own.map(model => model.id));
        // Account pools reuse the catalog row; only configured tiers are extra.
        return [...own, ...extra.filter(model => !seen.has(model.id))];
    }
    /** The provider's own catalog: union of every account, or one account when named. */
    async listOwnModels(provider, account, signal, preferCached = false) {
        if (account === undefined) {
            const accounts = (await this.options.tokens.list()).map(entry => entry.key);
            if (accounts.length === 0)
                return [];
            return unionAccountCatalogs(accounts, (key, accountSignal) => this.listOwnModels(provider, key, accountSignal, preferCached), { timeoutMs: DISCOVERY_TIMEOUT_MS, ...signal === undefined ? {} : { signal } });
        }
        if (await this.options.tokens.peek(account) === undefined)
            return [];
        if (!this.options.discovery)
            return this.staticModels(provider);
        const catalog = await this.catalogFor(account);
        try {
            const models = await catalog.get(() => discoverOrRetryAuth(force => this.options.tokens.session(account, force), catalog, () => this.fetchCatalog(account, signal)), preferCached);
            return models.map(model => ({
                provider,
                id: model.id,
                name: model.name,
                ...model.description === undefined ? {} : { description: model.description },
                inputModalities: model.inputModalities ?? ['text', 'image'],
            }));
        }
        catch (error) {
            if (isDiscoveryAborted(error, signal))
                throw error;
            if (isMissingOrInvalidCredential(error))
                return [];
            this.options.onWarn?.(`Antigravity model discovery failed; using the built-in catalog (${errorChain(error)})`);
            return this.staticModels(provider);
        }
    }
    async discovered(model, account) {
        if (!this.options.discovery)
            return undefined;
        const accounts = account === undefined ? (await this.options.tokens.list()).map(entry => entry.key) : [account];
        return discoverAcrossAccounts(accounts, async (key) => {
            const catalog = await this.catalogFor(key);
            const models = await catalog.resolve(() => this.fetchCatalog(key));
            return models?.find(entry => entry.id === model);
        });
    }
    async resolveModel(provider, model) {
        const pool = this.options.pool?.();
        if (pool !== undefined && await pool.owns(provider, model)) {
            return pool.resolveModel(provider, model);
        }
        return this.resolveOwnModel(provider, model);
    }
    /** Capability resolution of the provider's own models (the pool resolves members here). */
    async resolveOwnModel(provider, model, account) {
        const discovered = await this.discovered(model, account);
        const configured = this.options.models.find(entry => entry.id === model);
        const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), antigravityReasoning(model));
        const outputLimit = discovered?.maxOutputTokens;
        const preferredMaxTokens = configured?.maxTokens ?? outputLimit ?? ANTIGRAVITY_DEFAULT_MAX_TOKENS;
        // Configuration may lower the default, but must not exceed a known server cap.
        const defaultMaxTokens = outputLimit === undefined ? preferredMaxTokens : Math.min(preferredMaxTokens, outputLimit);
        return {
            provider,
            id: model,
            name: discovered?.name ?? configured?.name ?? model,
            ...discovered?.description === undefined ? {} : { description: discovered.description },
            inputModalities: discovered?.inputModalities ?? configured?.inputModalities ?? ['text', 'image'],
            context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? ANTIGRAVITY_CONTEXT_WINDOW },
            defaultMaxTokens,
            ...reasoning === undefined ? {} : { reasoning },
        };
    }
    async *stream(options) {
        const pool = this.options.pool?.();
        if (pool !== undefined && await pool.owns(options.provider, options.model)) {
            yield* pool.stream(options);
            return;
        }
        yield* this.streamCore(options);
    }
    /** Pool seam: stream through one specific account instead of the default. */
    streamAccount(options, account) {
        return this.streamCore(options, account);
    }
    async *streamCore(options, account) {
        const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
        try {
            let session = await this.options.tokens.session(account);
            const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), watchdog.signal);
            let payload = toAntigravityRequest(options, messages, session.projectId, true);
            let response = await requestAntigravityContent(session, payload, true, this.options.runtime, this.options.fetchFn, watchdog.signal);
            if (response.status === 401) {
                this.clearAccountCatalog(account);
                session = await this.options.tokens.session(account, true);
                payload = toAntigravityRequest(options, messages, session.projectId, true);
                response = await requestAntigravityContent(session, payload, true, this.options.runtime, this.options.fetchFn, watchdog.signal);
            }
            if (!response.ok)
                throw await httpLlmError(response, 'Antigravity API');
            if (response.body === null) {
                throw new LlmError('Antigravity API returned no response body', EMPTY_RESPONSE_CODE);
            }
            yield* streamAntigravity(response.body, () => { watchdog.pulse(); });
        }
        catch (error) {
            throw mapFetchFailure('Antigravity API', error, watchdog, options.signal);
        }
        finally {
            watchdog.stop();
        }
    }
    /** Non-stream forwarding seam used by tests and future DSH complete calls. */
    async generate(options) {
        const session = await this.options.tokens.session();
        const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), options.signal);
        const response = await requestAntigravityContent(session, toAntigravityRequest(options, messages, session.projectId), false, this.options.runtime, this.options.fetchFn, options.signal);
        if (!response.ok)
            throw await httpLlmError(response, 'Antigravity API');
        return parseAntigravityResponse(await response.json());
    }
}
