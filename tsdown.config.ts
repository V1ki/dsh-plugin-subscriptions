/**
 * Standalone tsdown config for the browser client bundle, replicating the
 * deepseek-harness closure-factory recipe (packages/client/tsdown.client.ts,
 * function clientConfig) for this out-of-tree plugin: the bundle calls
 * window.__ModuleLoader__.load({id, factory}) and resolves externals through
 * the injected require (the shell's loader module table). The node half
 * (lib/index.js) is emitted by tsc, not here — `clean` stays off so this
 * bundle never wipes it.
 */
import { defineConfig } from 'tsdown'

/**
 * Externals answered by the shell's module table — imported normally and left
 * as require() calls in the bundle. Anything else must inline.
 */
const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

/**
 * Wire/type layers a client bundle may inline: browser-safe contracts
 * with no runtime identity to share (no Symbol/instanceof/singleton state).
 */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(session|llm|tools|brand)(\/|$)/

/** Vendored framework libraries: ordinary libraries a browser bundle inlines. */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

/** Generated descriptor/codec contribution with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

export default defineConfig({
  name: 'dsh-plugin-subscriptions/client',
  entry: { client: 'src/client/index.ts' },
  // Single lib/ artifact dir shared with the tsc-emitted node half;
  // entryFileNames pins the bundle at exactly lib/client.js.
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  // Types ship from tsc (lib/client/index.d.ts); dts here would wrap the
  // banner/footer into .d.cts and break parsing.
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  // tsdown auto-externalizes package dependencies; anything NOT in the
  // loader module table must inline instead. A require() the table cannot
  // answer is a guaranteed runtime throw.
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  plugins: [{
    // Bundle purity gate: platform module-table entries stay external,
    // inline-safe wire layers and vendored libraries inline, and every other
    // @deepseek-ai value import is a build error — it would either inline a
    // duplicate runtime instance or require a specifier the frozen module
    // table cannot answer. Type-only imports are erased and never reach here.
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null // platform module: external wins
      if (VENDORED_LIBRARY.test(source)) return null // vendored library: inline, no shared identity
      if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null // wire contribution: inline is the point
      throw new Error(
        `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS), an inline-safe wire layer, or a generated /remote contribution — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
      )
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-plugin-subscriptions", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
