/**
 * Claude login paths: credential import vs interactive OAuth fallback.
 *
 * Unit tests exercise `readClaudeCodeCredentials` through `CLAUDE_CONFIG_DIR`.
 * Controller tests construct `SubscriptionsAuthController` with a stub
 * credential reader, so both branches of `login('claude')` run without a real
 * credential store — and without the plugin's public config carrying a test
 * hook. One test mounts the whole plugin and drives the RPC endpoints.
 *
 * Every test that can reach the session store runs inside its own temporary
 * `$DSH_HOME`, scoped to the test rather than to the process, so nothing here
 * touches a developer's real harness home or another spec's.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type { RpcResult } from '../src/compat.js'

import * as plugin from '../src/index.js'
import { SubscriptionsAuthController } from '../src/index.js'
import { OAuthFlowManager } from '../src/auth/oauth-flow.js'
import { DeviceFlowManager } from '../src/auth/device-flow.js'
import { readClaudeCodeCredentials } from '../src/auth/claude-code-creds.js'
import {
  CLAUDE_AUTHORIZE_URL, CLAUDE_CALLBACK_PATH, CLAUDE_CLIENT_ID, CLAUDE_SCOPE, CLAUDE_TOKEN_URL,
} from '../src/providers/claude.js'
import { accountKeyOf, authFilePath, listAccounts } from '../src/auth/store.js'
import type { ClaudeSession } from '../src/auth/store.js'

const TEMP_DIRS: string[] = []

/** A temp directory removed when the file finishes, fake tokens and all. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.push(dir)
  return dir
}

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

/** Restore an environment variable, keeping "unset" distinct from "empty". */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function withEnv<T>(name: string, value: string, run: () => Promise<T>): Promise<T> {
  const saved = process.env[name]
  process.env[name] = value
  try {
    return await run()
  } finally {
    restoreEnv(name, saved)
  }
}

/**
 * Run inside a private harness home. The override is scoped to the call, not
 * to the process, because the specs share one process and the aggregate run
 * imports this file after others that set their own home.
 */
async function inIsolatedHome<T>(run: () => Promise<T>): Promise<T> {
  const home = tempDir('login-spec-dsh-')
  return withEnv('DSH_HOME', home, async () => {
    // The guard only works because `dshHomePath()` resolves `$DSH_HOME` per
    // call. Assert it rather than trust it: were the home ever captured at
    // import time, this suite would silently start writing to the real one.
    assert.ok(authFilePath().startsWith(home), 'the session store resolves inside the temp home')
    return run()
  })
}

/**
 * Whether this machine answers credential reads from the macOS Keychain. When
 * it does, no `CLAUDE_CONFIG_DIR` fixture can be observed, so the file-parsing
 * tests are skipped outright — reporting them as passed would be a lie.
 */
const keychainAnswers = ((): boolean => {
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tempDir('claude-probe-')
  try {
    return readClaudeCodeCredentials() !== undefined
  } finally {
    restoreEnv('CLAUDE_CONFIG_DIR', saved)
  }
})()

const needsFileStore: { skip?: string } = keychainAnswers
  ? { skip: 'a Claude Code Keychain entry shadows the credentials file on this machine' }
  : {}

const FAKE_SESSION: ClaudeSession = {
  accessToken: 'test-at',
  refreshToken: 'test-rt',
  expiresAt: Date.now() + 3600_000,
  scopes: 'user:inference',
}

const VALID_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 3600_000,
    scopes: 'user:inference',
  },
})

/** A controller with no LLM/RPC wiring: enough to drive `login` and `status`. */
function makeController(readClaudeCreds: () => ClaudeSession | undefined, flows = new OAuthFlowManager()) {
  return new SubscriptionsAuthController(
    flows,
    new DeviceFlowManager(),
    () => {},
    () => undefined,
    {},
    readClaudeCreds,
  )
}

/** A credentials directory holding one blob, cleaned up with the rest. */
function credentialsDir(prefix: string, blob: string): string {
  const dir = tempDir(prefix)
  writeFileSync(join(dir, '.credentials.json'), blob, { mode: 0o600 })
  return dir
}

// ---------------------------------------------------------------------------
// The constants the authorize request is built from
// ---------------------------------------------------------------------------

test('Claude OAuth parameters match what Claude Code sends', () => {
  // Literals on purpose. Every URL assertion below compares the request
  // against these same constants, so only a literal can catch someone
  // changing one — which is exactly the regression that shipped before.
  // Captured from Claude Code 2.1.235's own authorize request.
  assert.equal(CLAUDE_AUTHORIZE_URL, 'https://claude.ai/oauth/authorize')
  assert.equal(CLAUDE_CLIENT_ID, '9d1c250a-e61b-44d9-88ed-5944d1962f5e')
  assert.equal(CLAUDE_CALLBACK_PATH, '/callback')
  assert.equal(
    CLAUDE_SCOPE,
    'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
  )
})

// ---------------------------------------------------------------------------
// Reading the Claude Code credential store
// ---------------------------------------------------------------------------

test('readClaudeCodeCredentials returns session from .credentials.json', needsFileStore, async () => {
  await withEnv('CLAUDE_CONFIG_DIR', credentialsDir('claude-creds-', VALID_BLOB), () => {
    const session = readClaudeCodeCredentials()
    assert.ok(session !== undefined, 'the credentials file is read')
    assert.equal(session.accessToken, 'test-access-token')
    assert.equal(session.refreshToken, 'test-refresh-token')
    assert.equal(typeof session.expiresAt, 'number')
    return Promise.resolve()
  })
})

test('readClaudeCodeCredentials returns undefined when no credentials file', needsFileStore, async () => {
  await withEnv('CLAUDE_CONFIG_DIR', tempDir('claude-empty-'), () => {
    assert.equal(readClaudeCodeCredentials(), undefined)
    return Promise.resolve()
  })
})

test('readClaudeCodeCredentials returns undefined for malformed JSON', needsFileStore, async () => {
  await withEnv('CLAUDE_CONFIG_DIR', credentialsDir('claude-bad-', '{not valid json!!!'), () => {
    assert.equal(readClaudeCodeCredentials(), undefined)
    return Promise.resolve()
  })
})

test('readClaudeCodeCredentials returns undefined for incomplete credentials', needsFileStore, async () => {
  const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'only-access' } })
  await withEnv('CLAUDE_CONFIG_DIR', credentialsDir('claude-incomplete-', blob), () => {
    assert.equal(readClaudeCodeCredentials(), undefined, 'missing refreshToken/expiresAt = undefined')
    return Promise.resolve()
  })
})

test('readClaudeCodeCredentials returns undefined for EMPTY-string credentials', needsFileStore, async () => {
  // A corrupted Keychain item (observed in the wild after a Claude Code
  // logout) holds the right keys with empty strings — importing it used to
  // poison the auth store and blind every provider's status page.
  const blob = JSON.stringify({
    claudeAiOauth: {
      accessToken: '', refreshToken: '', expiresAt: 0,
      scopes: ['user:profile'], subscriptionType: 'pro',
    },
  })
  await withEnv('CLAUDE_CONFIG_DIR', credentialsDir('claude-empty-str-', blob), () => {
    assert.equal(readClaudeCodeCredentials(), undefined, 'empty tokens = undefined')
    return Promise.resolve()
  })
})

test('readClaudeCodeCredentials reads bare fields (no claudeAiOauth wrapper)', needsFileStore, async () => {
  const blob = JSON.stringify({
    accessToken: 'bare-at', refreshToken: 'bare-rt', expiresAt: Date.now() + 3600_000,
  })
  await withEnv('CLAUDE_CONFIG_DIR', credentialsDir('claude-bare-', blob), () => {
    const session = readClaudeCodeCredentials()
    assert.ok(session !== undefined, 'bare fields are accepted too')
    assert.equal(session.accessToken, 'bare-at')
    return Promise.resolve()
  })
})

// ---------------------------------------------------------------------------
// login('claude'): the two paths
// ---------------------------------------------------------------------------

test('login(claude): credentials found → instant import, session persisted', async () => {
  await inIsolatedHome(async () => {
    const controller = makeController(() => FAKE_SESSION)
    const { authorizeUrl } = await controller.login('claude')
    assert.equal(authorizeUrl, '', 'the import path opens no browser')

    assert.equal((await listAccounts('claude'))[0]?.session.accessToken, FAKE_SESSION.accessToken)
    assert.equal((await controller.status('claude')).accounts.length, 1)
  })
})

test('login(claude): the shipped controller reads the credential store by default', needsFileStore, async () => {
  await inIsolatedHome(async () => {
    const dir = credentialsDir('claude-default-', VALID_BLOB)
    await withEnv('CLAUDE_CONFIG_DIR', dir, async () => {
      // No sixth argument: this is the wiring `apply()` ships. Without it the
      // plugin would never import a Claude Code session in production, and
      // every other test here would still pass.
      const controller = new SubscriptionsAuthController(
        new OAuthFlowManager(),
        new DeviceFlowManager(),
        () => {},
        () => undefined,
      )
      const { authorizeUrl } = await controller.login('claude')
      assert.equal(authorizeUrl, '', 'the default reader found the credentials file')
      assert.equal((await listAccounts('claude'))[0]?.session.accessToken, 'test-access-token')
    })
  })
})

test('login(claude): credentials absent → OAuth fallback with Claude Code parameters', async () => {
  await inIsolatedHome(async () => {
    const controller = makeController(() => undefined)
    try {
      const { authorizeUrl } = await controller.login('claude')
      assert.ok(authorizeUrl.length > 0, 'the fallback returns an authorize URL')

      const url = new URL(authorizeUrl)
      assert.equal(`${url.origin}${url.pathname}`, CLAUDE_AUTHORIZE_URL)

      const params = url.searchParams
      assert.equal(params.get('code'), 'true')
      assert.equal(params.get('client_id'), CLAUDE_CLIENT_ID)
      assert.equal(params.get('response_type'), 'code')
      assert.equal(params.get('scope'), CLAUDE_SCOPE)
      assert.equal(params.get('code_challenge_method'), 'S256')
      assert.ok(params.get('code_challenge'), 'PKCE challenge present')

      // The callback is served locally on an ephemeral port, so the redirect
      // URI must carry that port rather than a fixed hosted endpoint. Claude
      // Code 2.1.235 sends the same shape, `localhost` included.
      const redirectUri = new URL(params.get('redirect_uri') ?? '')
      assert.equal(redirectUri.protocol, 'http:')
      assert.equal(redirectUri.hostname, 'localhost')
      assert.ok(Number(redirectUri.port) > 0, 'the redirect URI carries the listening port')
      assert.equal(redirectUri.pathname, CLAUDE_CALLBACK_PATH)

      // 32 random bytes, base64url. The endpoint answered "Invalid request
      // format" to the 22-char state this flow used to send, with every other
      // parameter held identical.
      assert.ok((params.get('state') ?? '').length >= 43, 'state carries at least 32 bytes of entropy')
    } finally {
      await controller.cancel('claude')
    }
  })
})

test('login(claude): a later import cancels the OAuth attempt left in flight', async () => {
  await inIsolatedHome(async () => {
    // The user clicks Connect with no credentials, then logs in through the
    // CLI and clicks again. Without the cancel, the first attempt's listener
    // stays bound, `busy` never clears, and finishing the flow in the tab
    // that is still open overwrites the session imported here.
    let credentials: ClaudeSession | undefined
    const flows = new OAuthFlowManager()
    const controller = makeController(() => credentials, flows)

    try {
      const { authorizeUrl } = await controller.login('claude')
      assert.ok(authorizeUrl.length > 0)
      assert.equal(flows.isBusy('claude'), true, 'an attempt is in flight')

      credentials = FAKE_SESSION
      const second = await controller.login('claude')

      assert.equal(second.authorizeUrl, '', 'the second click imports')
      assert.equal(flows.isBusy('claude'), false, 'the stale attempt was cancelled')
      assert.equal(flows.pending('claude'), undefined)
      assert.equal((await controller.status('claude')).busy, false, 'the Settings card leaves the busy state')
      assert.equal((await listAccounts('claude'))[0]?.session.accessToken, FAKE_SESSION.accessToken)
    } finally {
      // Without this an assertion failure leaves the callback server bound and
      // the test runner hangs until the flow's own timeout.
      await controller.cancel('claude')
    }
  })
})

// ---------------------------------------------------------------------------
// A token exchange that outlives its attempt
// ---------------------------------------------------------------------------

/** How a held token request ends once it is released. */
type ExchangeOutcome = 'token' | 'network-failure'

/** A Claude token endpoint that answers only when `release()` is called. */
interface HeldTokenEndpoint {
  /** Settles once the token request has been received. */
  readonly requested: Promise<void>
  /** Let the held token response through. */
  release(): void
  /** Put the real `fetch` back. */
  restore(): void
}

/**
 * Hold the Claude token endpoint open. Only that URL is served; the profile
 * lookup that follows a successful exchange is best-effort and tolerates the
 * 404, so no network is touched either way.
 *
 * @param accessToken - the access token the held response finally carries.
 * @param outcome - what the release produces: the token, or the network
 *   failure a token exchange hits when the connection drops mid-flight.
 */
function holdTokenEndpoint(
  accessToken: string,
  outcome: ExchangeOutcome = 'token',
): HeldTokenEndpoint {
  const real = globalThis.fetch
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let requested!: () => void
  const seen = new Promise<void>(resolve => { requested = resolve })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== CLAUDE_TOKEN_URL) return new Response('not found', { status: 404 })
    requested()
    await gate
    if (outcome === 'network-failure') throw new TypeError('fetch failed')
    return Response.json({
      access_token: accessToken,
      refresh_token: `${accessToken}-rt`,
      expires_in: 3600,
      scope: CLAUDE_SCOPE,
    })
  }) as typeof fetch
  return { requested: seen, release, restore: () => { globalThis.fetch = real } }
}

/**
 * Drive one OAuth attempt up to the point where its code has arrived but the
 * token exchange is still running — the window in which the attempt is gone
 * from the flow manager's pending map and nothing can cancel it any more.
 *
 * @param controller - the controller under test, with no Claude credentials yet.
 * @param authorizeUrl - the URL `login('claude')` returned.
 * @param accessToken - the token the delayed exchange will produce.
 * @param outcome - how that exchange ends once the endpoint is released.
 * @returns the held endpoint, to be released once the racing actor has run.
 */
async function deliverCallback(
  authorizeUrl: string,
  accessToken: string,
  outcome: ExchangeOutcome = 'token',
): Promise<HeldTokenEndpoint> {
  const real = globalThis.fetch
  const params = new URL(authorizeUrl).searchParams
  const held = holdTokenEndpoint(accessToken, outcome)
  const callback = new URL(params.get('redirect_uri') ?? '')
  callback.searchParams.set('code', 'callback-code')
  callback.searchParams.set('state', params.get('state') ?? '')
  // The real fetch: the loopback callback server is a live HTTP server.
  const response = await real(callback)
  assert.equal(response.status, 200, 'the callback server accepted the code')
  await response.text()
  await held.requested
  return held
}

test('login(claude): an import beats a token exchange that is still running', async () => {
  await inIsolatedHome(async () => {
    let credentials: ClaudeSession | undefined
    const flows = new OAuthFlowManager()
    const controller = makeController(() => credentials, flows)
    const { authorizeUrl } = await controller.login('claude')
    const held = await deliverCallback(authorizeUrl, 'old-oauth')
    try {
      // The code arrived, so the attempt is no longer pending — `cancel()` on
      // it is a no-op from here on, which is exactly why the guard exists.
      assert.equal(flows.pending('claude'), undefined, 'the attempt left the pending map')
      assert.equal((await controller.status('claude')).busy, false)

      credentials = { ...FAKE_SESSION, accessToken: 'imported-cli' }
      await controller.login('claude')
      assert.equal((await listAccounts('claude'))[0]?.session.accessToken, 'imported-cli')

      held.release()
      await controller.settled('claude')
      assert.equal(
        (await listAccounts('claude'))[0]?.session.accessToken, 'imported-cli',
        'the superseded exchange did not overwrite the imported session',
      )
    } finally {
      held.restore()
    }
  })
})

test('login(claude): an import beats a token exchange that then fails', async () => {
  await inIsolatedHome(async () => {
    // The mirror of the success case: the superseded exchange loses its
    // network instead of returning a token. Its failure belongs to a claim
    // nobody holds any more, so the Settings card must not show an error on a
    // provider that is logged in.
    let credentials: ClaudeSession | undefined
    const flows = new OAuthFlowManager()
    const controller = makeController(() => credentials, flows)
    const { authorizeUrl } = await controller.login('claude')
    const held = await deliverCallback(authorizeUrl, 'old-oauth', 'network-failure')
    try {
      credentials = { ...FAKE_SESSION, accessToken: 'imported-cli' }
      await controller.login('claude')

      held.release()
      await controller.settled('claude')
      const status = await controller.status('claude')
      assert.equal(status.accounts.length, 1, 'the imported session is still the stored one')
      assert.equal((await listAccounts('claude'))[0]?.session.accessToken, 'imported-cli')
      assert.equal(status.detail, undefined, 'the superseded failure stayed off the status')
    } finally {
      held.restore()
    }
  })
})

test('login(claude): a logout beats a token exchange that is still running', async () => {
  await inIsolatedHome(async () => {
    const flows = new OAuthFlowManager()
    const controller = makeController(() => undefined, flows)
    const { authorizeUrl } = await controller.login('claude')
    const held = await deliverCallback(authorizeUrl, 'old-oauth')
    try {
      await controller.logout('claude', accountKeyOf('claude', FAKE_SESSION))
      assert.equal((await listAccounts('claude')).length, 0, 'the logout cleared the store')

      held.release()
      await controller.settled('claude')
      assert.equal(
        (await listAccounts('claude')).length, 0,
        'the superseded exchange did not restore the session',
      )
      assert.equal((await controller.status('claude')).accounts.length, 0)
    } finally {
      held.restore()
    }
  })
})

test('claude: an import and a logout fired together settle in call order', async () => {
  await inIsolatedHome(async () => {
    // Both endpoints read-modify-write the same store file. Fired without an
    // await between them they would race there, so the writes are queued per
    // provider and the later call is the one that survives.
    const controller = makeController(() => ({ ...FAKE_SESSION, accessToken: 'imported-cli' }))
    const importing = controller.login('claude')
    const loggingOut = controller.logout('claude', accountKeyOf('claude', FAKE_SESSION))
    await Promise.all([importing, loggingOut])
    assert.equal((await listAccounts('claude')).length, 0, 'the logout was the later call, so it wins')
  })
})

// ---------------------------------------------------------------------------
// The same endpoints through the plugin's RPC channel
// ---------------------------------------------------------------------------

/** Mount the plugin with a fake llm/connection host; return the RPC handler. */
async function mountPlugin(): Promise<ConnectionRpcHandler> {
  let handler: ConnectionRpcHandler | undefined
  const ctx = new Context()
  ctx.provide('llm', { registerAdapter: () => Object.assign(() => {}, { replace: () => {} }) })
  ctx.provide('connection', {
    rpc: {
      handle: (_channel: string, h: ConnectionRpcHandler) => {
        handler = h
        return () => Promise.resolve()
      },
    },
  })
  ctx.plugin(plugin, { providers: ['codex'] })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(handler !== undefined, 'the /subscriptions-auth channel was registered')
  return handler
}

function signal(): AbortSignal {
  return new AbortController().signal
}

interface StatusValue { providers: Record<string, { accounts: unknown[]; busy: boolean }> }

/** Unwrap a successful RPC result, failing the test with its error otherwise. */
function okValue<T>(result: RpcResult<unknown>, what: string): T {
  assert.ok(result.ok, `${what}: ${result.ok ? '' : result.error.message}`)
  return result.value as T
}

test('auth RPC: status / login / cancel round trip', async () => {
  await inIsolatedHome(async () => {
    // Driven through codex, whose login always takes the OAuth branch: this
    // covers the endpoint routing and the status shape the Settings page
    // consumes, without needing a credential reader injected anywhere.
    const handler = await mountPlugin()

    const before = okValue<StatusValue>(await handler('status', {}, signal()), 'status')
    assert.equal(before.providers.codex.accounts.length, 0)
    assert.equal(before.providers.codex.busy, false)

    try {
      const login = okValue<{ authorizeUrl: string }>(
        await handler('login', { provider: 'codex' }, signal()), 'login',
      )
      assert.ok(login.authorizeUrl.startsWith('https://'), 'login returns an authorize URL')

      const during = okValue<StatusValue>(await handler('status', {}, signal()), 'status while busy')
      assert.equal(during.providers.codex.busy, true)
    } finally {
      okValue(await handler('cancel', { provider: 'codex' }, signal()), 'cancel')
    }

    const after = okValue<StatusValue>(await handler('status', {}, signal()), 'status after cancel')
    assert.equal(after.providers.codex.busy, false)
  })
})

test('auth RPC: an unknown provider is rejected, not dispatched', async () => {
  await inIsolatedHome(async () => {
    const handler = await mountPlugin()
    const result = await handler('login', { provider: 'gemini' }, signal())
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'bad-request')
  })
})
