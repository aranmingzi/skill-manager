/**
 * Usage-ledger checks. Plain `node test/usage.test.mjs` — the ledger module is
 * import-free so it can be exercised without the harness.
 */

import assert from 'node:assert/strict'

import {
  digest,
  emptyUsage,
  formatHint,
  harvest,
  percent,
  prune,
  ranking,
  record,
  serializeUsage,
  stats,
} from '../usage.js'

let failed = 0
let total = 0

/** Run one named check and report it. */
function test(label, run) {
  total += 1
  try {
    run()
    console.log(`ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${label}`)
    console.log(`     ${error.message}`)
  }
}

test('empty usage has no entries and no loads', () => {
  const usage = emptyUsage()
  assert.deepEqual(Object.keys(usage.skills), [])
  assert.equal(usage.total, 0)
  assert.deepEqual(stats(usage, 'dsh-doc'), { loads: 0, blocks: 0, picks: 0, share: 0, average: 0, lastAt: 0 })
})

test('loads accumulate and drive the share', () => {
  let usage = emptyUsage()
  usage = record(usage, 'dsh-doc', 'load', { coverage: 0.8, at: 1 })
  usage = record(usage, 'dsh-doc', 'load', { coverage: 0.4, at: 2 })
  usage = record(usage, 'embed', 'load', { coverage: 0.9, at: 3 })
  assert.equal(usage.total, 3)
  const doc = stats(usage, 'dsh-doc')
  assert.equal(doc.loads, 2)
  assert.equal(doc.lastAt, 2)
  assert.ok(Math.abs(doc.share - 2 / 3) < 1e-9)
  assert.ok(Math.abs(doc.average - 0.6) < 1e-9)
  assert.ok(Math.abs(stats(usage, 'embed').share - 1 / 3) < 1e-9)
})

test('blocks and picks are counted separately from loads', () => {
  let usage = emptyUsage()
  usage = record(usage, 'frontend-craft', 'block', { at: 5 })
  usage = record(usage, 'dsh-doc', 'load', { at: 6 })
  usage = record(usage, 'dsh-doc', 'pick', { at: 7 })
  assert.equal(usage.total, 1)
  assert.equal(usage.blocks, 1)
  assert.equal(stats(usage, 'frontend-craft').blocks, 1)
  assert.equal(stats(usage, 'frontend-craft').loads, 0)
  assert.equal(stats(usage, 'dsh-doc').picks, 1)
})

test('coverage is ignored when a load carries none', () => {
  let usage = emptyUsage()
  usage = record(usage, 'office', 'load')
  const row = stats(usage, 'office')
  assert.equal(row.loads, 1)
  assert.equal(row.average, 0)
})

test('unknown events and names are no-ops', () => {
  const usage = emptyUsage()
  assert.equal(record(usage, '', 'load'), usage)
  assert.equal(record(usage, 'dsh-doc', 'explode'), usage)
  assert.equal(record(null, 'dsh-doc', 'load').total, 1)
})

test('harvest survives garbage and recomputes totals', () => {
  assert.equal(harvest(null).total, 0)
  assert.equal(harvest({ skills: { 'dsh-doc': 'nonsense' } }).skills['dsh-doc'].loads, 0)
  const usage = harvest({ skills: { 'dsh-doc': { loads: 4, blocks: 2, coverageSum: 2, scored: 4 } } })
  assert.equal(usage.total, 4)
  assert.equal(usage.blocks, 2)
  assert.ok(Math.abs(stats(usage, 'dsh-doc').average - 0.5) < 1e-9)
})

test('round trip through the file shape keeps the numbers', () => {
  let usage = emptyUsage()
  usage = record(usage, 'dsh-doc', 'load', { coverage: 0.75, at: 9 })
  const back = harvest(JSON.parse(serializeUsage(usage)))
  assert.equal(back.total, 1)
  assert.equal(back.skills['dsh-doc'].lastAt, 9)
  assert.ok(serializeUsage(usage).endsWith('\n'))
})

test('ranking puts the most used skill first and hides the unused', () => {
  let usage = emptyUsage()
  usage = record(usage, 'embed', 'load')
  usage = record(usage, 'dsh-doc', 'load')
  usage = record(usage, 'dsh-doc', 'load')
  usage = record(usage, 'frontend-craft', 'block')
  const rows = ranking(usage, { limit: 10 })
  assert.deepEqual(rows.map(row => row.name), ['dsh-doc', 'embed', 'frontend-craft'])
  assert.deepEqual(ranking(emptyUsage(), { limit: 10 }), [])
})

test('percent keeps small non-zero shares visible', () => {
  assert.equal(percent(0), '0%')
  assert.equal(percent(0.5), '50%')
  assert.equal(percent(0.0033), '0.3%')
  assert.equal(percent(0.0001), '<0.1%')
})

test('the annotation names the skills and warns that usage is not relevance', () => {
  let usage = emptyUsage()
  usage = record(usage, 'dsh-doc', 'load', { coverage: 0.9 })
  usage = record(usage, 'dsh-doc', 'block')
  const hint = formatHint(usage)
  assert.match(hint, /<skill_usage>技能使用率/)
  assert.match(hint, /dsh-doc：加载 1 次 · 100% · 被拦 1 · 相关度均值 0\.90/)
  assert.match(hint, /相关度仍是选技能的唯一依据/)
  assert.equal(formatHint(emptyUsage()), '')
})

test('digest only changes when a counter changes', () => {
  let usage = emptyUsage()
  usage = record(usage, 'dsh-doc', 'load', { at: 1 })
  const first = digest(usage)
  assert.equal(digest(record(usage, 'dsh-doc', 'load', { at: 99 })), digest(record(usage, 'dsh-doc', 'load', { at: 1 })))
  assert.notEqual(digest(record(usage, 'embed', 'load')), first)
})

test('prune keeps the freshest entries under the cap', () => {
  let usage = emptyUsage()
  for (let index = 0; index < 10; index += 1) usage = record(usage, `skill-${index}`, 'load', { at: index + 1 })
  const pruned = prune(usage, { keep: 3 })
  assert.equal(Object.keys(pruned.skills).length, 3)
  assert.ok('skill-9' in pruned.skills)
  assert.ok(!('skill-0' in pruned.skills))
  assert.equal(pruned.total, 3)
  assert.equal(prune(usage, { keep: 99 }).total, usage.total)
})

console.log(`\nusage checks: ${total}, failed: ${failed}`)
if (failed > 0) process.exitCode = 1