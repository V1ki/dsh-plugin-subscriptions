import { test } from 'node:test'
import assert from 'node:assert/strict'
import { badgePosition } from '../src/client/use-badge-position.js'

test('badge panel prefers above and clamps to viewport edges', () => {
  assert.deepEqual(badgePosition({ left: 100, top: 400, bottom: 420 }, { width: 300, height: 200 }, { width: 900, height: 600 }, 8, 12), { left: 100, top: 192 })
  assert.deepEqual(badgePosition({ left: 350, top: 30, bottom: 50 }, { width: 300, height: 200 }, { width: 400, height: 300 }, 8, 12), { left: 88, top: 58 })
  assert.deepEqual(badgePosition({ left: 0, top: 20, bottom: 40 }, { width: 450, height: 500 }, { width: 400, height: 300 }, 8, 12), { left: 12, top: 12 })
})
