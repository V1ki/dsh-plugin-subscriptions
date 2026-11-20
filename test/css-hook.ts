// Host UI primitives import CSS modules, which Node component tests do not render.
import { registerHooks } from 'node:module'
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css')
    ? { format: 'module', source: 'export default {}', shortCircuit: true }
    : nextLoad(url, context)
} })
