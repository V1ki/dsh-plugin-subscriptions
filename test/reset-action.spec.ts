import test from 'node:test'
import assert from 'node:assert/strict'
import { resetActionBlock } from '../src/client/reset-action.js'

const now = 1000
function usage(percent: number, id: string | undefined = 'credit') {
  return { windows: [{ kind: 'weekly', usedPercent: percent, resetsAt: 2000 }], resetCredits: [{ ...(id ? { id } : {}), expiresAt: 3000 }] }
}
test('reset action allows 80% and 92%, explains disabled lower usage', () => {
  assert.equal(resetActionBlock(usage(54), now), 'resetUseGuard')
  assert.equal(resetActionBlock(usage(79.99), now), 'resetUseGuard')
  assert.equal(resetActionBlock(usage(80), now), undefined)
  assert.equal(resetActionBlock(usage(92), now), undefined)
})
test('old server without credit IDs has a distinct restart hint at 92%', () => {
  assert.equal(resetActionBlock(usage(92, ''), now), 'resetUseRestart')
})
test('expired or unknown weekly data cannot enable consumption', () => {
  assert.equal(resetActionBlock(usage(92), 4000), 'resetUseRefresh')
  assert.equal(resetActionBlock(usage(NaN), now), 'resetUseRefresh')
  assert.equal(resetActionBlock({}, now), 'resetUseRefresh')
})
