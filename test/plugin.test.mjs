/**
 * End-to-end checks for the plugin wiring: run the real `apply()` against a fake
 * cordis context, drive one request through the gate and both tools, and assert
 * the ledger written to disk.
 *
 * `index.js` intentionally imports only node builtins and its siblings, so this
 * runs from plain `node` without the harness.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const FIXTURES = [
  {
    name: 'dsh-doc',
    description: 'Facts about DeepSeek Harness (DSH): how a feature, setting, plugin, agent preset, or tool works. Use when building, installing, or debugging a DSH plugin or bundle.',
    invocation: { modelInvocable: true, userInvocable: true },
  },
  {
    name: 'frontend-craft',
    description: '把前端做得好看、不像 AI 模板货。用于「页面太丑」「优化 UI」「美化前端」「去 AI 味」时。',
    whenToUse: '用户嫌页面难看时用。DO NOT TRIGGER when：只调一个颜色值。',
    invocation: { modelInvocable: true, userInvocable: true },
  },
  {
    name: 'embed',
    description: '嵌入式开发：STM32 单片机、HAL、FreeRTOS、串口、PWM、ADC 采样。',
    invocation: { modelInvocable: true, userInvocable: true },
  },
]

/** Minimal cordis-shaped context: listeners, one tool registry, one skill provider. */
function fakeContext(skills = FIXTURES) {
  const listeners = new Map()
  const tools = new Map()
  return {
    listeners,
    tools,
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    toolsService: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    skills: {
      async list() {
        return skills
      },
    },
    workingDirectory: {
      async ensure() {
        return 'C:\\workspace'
      },
    },
  }
}

/** Run one waterfall event through every listener registered for it. */
async function emit(context, event, ...args) {
  const list = context.listeners.get(event) ?? []
  // The real registry's terminal `next()` yields the default decision.
  const terminal = () => (event === 'tools/pre-execute'
    ? { kind: 'allow' }
    : { kind: 'continue', messages: [] })
  let index = 0
  const next = async () => {
    const handler = list[index]
    index += 1
    if (handler === undefined) return terminal()
    return handler(...args, next)
  }
  return next()
}

let failed = 0
let total = 0

async function test(label, run) {
  total += 1
  try {
    await run()
    console.log(`ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${label}`)
    console.log(`     ${error.message}`)
  }
}

const root = await mkdtemp(join(tmpdir(), 'skill-manager-'))
let ledgerSeq = 0
const agent = { name: 'lead' }

/** Fresh plugin instance with its own ledger file. */
async function boot(config) {
  ledgerSeq += 1
  const usagePath = join(root, `usage-${ledgerSeq}.json`)
  const context = fakeContext()
  const ctx = {
    on: context.on,
    tools: context.toolsService,
    skills: context.skills,
    workingDirectory: context.workingDirectory,
  }
  const handle = apply(ctx, { usagePath, ...config })
  await handle.ready
  return { context, handle, config }
}

/** Claim one user request for the gated agent. */
async function claim(context, text) {
  return emit(context, 'agent/pre-step', {
    agent,
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
  })
}

/** Ask the gate about one skill load. */
async function loadSkill(context, name, args = {}) {
  return emit(context, 'tools/pre-execute', { name: 'skill', arguments: { name, ...args }, agent })
}

await test('an irrelevant load is denied with ranked alternatives', async () => {
  const { context } = await boot({})
  await claim(context, '这个插件要给 skills 标上使用率，写个管理 skill 的插件')
  const decision = await loadSkill(context, 'frontend-craft')
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /frontend-craft/)
  assert.match(decision.reason, /更贴合的候选/)
  assert.match(decision.reason, /dsh-doc/)
  assert.match(decision.reason, /force/)
})

await test('the relevant load passes and is counted', async () => {
  const { context, handle } = await boot({})
  await claim(context, '这个插件要给 skills 标上使用率，写个管理 skill 的插件')
  const decision = await loadSkill(context, 'dsh-doc')
  assert.equal(decision.kind, 'allow')
  await new Promise(resolve => setTimeout(resolve, 60))
  const ledger = JSON.parse(await readFile(handle.ledgerPath, 'utf8'))
  assert.equal(ledger.skills['dsh-doc'].loads, 1)
  assert.ok(ledger.skills['dsh-doc'].coverageSum > 0)
})

await test('force skips the gate but still counts as a load', async () => {
  const { context, handle } = await boot({})
  await claim(context, '这个插件要给 skills 标上使用率')
  const decision = await loadSkill(context, 'frontend-craft', { force: true })
  assert.equal(decision.kind, 'allow')
  await new Promise(resolve => setTimeout(resolve, 60))
  const ledger = JSON.parse(await readFile(handle.ledgerPath, 'utf8'))
  assert.equal(ledger.skills['frontend-craft'].loads, 1)
})

await test('a repeated denial inside one request turns into a load', async () => {
  const { context, handle } = await boot({})
  await claim(context, '这个插件要给 skills 标上使用率')
  const first = await loadSkill(context, 'frontend-craft')
  const second = await loadSkill(context, 'frontend-craft')
  assert.equal(first.kind, 'deny')
  assert.equal(second.kind, 'allow')
  await new Promise(resolve => setTimeout(resolve, 60))
  const ledger = JSON.parse(await readFile(handle.ledgerPath, 'utf8'))
  assert.equal(ledger.skills['frontend-craft'].blocks, 1)
  assert.equal(ledger.skills['frontend-craft'].loads, 1)
})

await test('mode off never denies', async () => {
  const { context, handle } = await boot({ mode: 'off' })
  await claim(context, '这个插件要给 skills 标上使用率')
  const decision = await loadSkill(context, 'frontend-craft')
  assert.equal(decision.kind, 'allow')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(JSON.parse(await readFile(handle.ledgerPath, 'utf8')).skills['frontend-craft'].loads, 1)
})

await test('the disabled list denies outright', async () => {
  const { context } = await boot({ disabled: ['embed'] })
  await claim(context, '随便什么请求')
  const decision = await loadSkill(context, 'embed')
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /已被配置禁用/)
})

await test('skill_search ranks the right skill first and records a pick', async () => {
  const { context, handle } = await boot({})
  const tool = context.tools.get('skill_search')
  const result = await tool.execute({ query: '页面太丑了，帮我优化一下 UI' }, { agent, signal: undefined })
  assert.equal(result.matches[0].name, 'frontend-craft')
  assert.equal(result.total, 3)
  assert.ok(result.matches[0].score > 0)
  assert.equal(result.matches[0].loads, 0)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(JSON.parse(await readFile(handle.ledgerPath, 'utf8')).skills['frontend-craft'].picks, 1)
})

await test('skill_usage reports the ledger as a table', async () => {
  const { context } = await boot({})
  await claim(context, '这个插件要给 skills 标上使用率')
  await loadSkill(context, 'dsh-doc')
  const tool = context.tools.get('skill_usage')
  const result = await tool.execute({}, { agent, signal: undefined })
  assert.equal(result.total, 1)
  assert.equal(result.rows[0].name, 'dsh-doc')
  assert.equal(result.rows[0].share, 1)
  assert.match(tool.output.render({}, result)[0].text, /1 loads/)
})

await test('the step is annotated with usage once it has history', async () => {
  const { context } = await boot({})
  await claim(context, '这个插件要给 skills 标上使用率')
  await loadSkill(context, 'dsh-doc')
  const decision = await claim(context, '继续')
  const injected = (decision.messages ?? []).filter(message => message.source?.kind === 'skill-manager-usage')
  assert.equal(injected.length, 1)
  assert.match(injected[0].content[0].text, /skill_usage/)
  assert.ok(Object.isFrozen(injected[0]))
  // Unchanged numbers stay quiet on the next step.
  const again = await claim(context, '再来')
  assert.equal((again.messages ?? []).filter(message => message.source?.kind === 'skill-manager-usage').length, 0)
})

await test('usageHint false suppresses the annotation', async () => {
  const { context } = await boot({ usageHint: false })
  await claim(context, '这个插件要给 skills 标上使用率')
  await loadSkill(context, 'dsh-doc')
  const decision = await claim(context, '继续')
  assert.equal((decision.messages ?? []).filter(message => message.source?.kind === 'skill-manager-usage').length, 0)
})

await test('a broken context never breaks the tool call', async () => {
  const context = fakeContext()
  const ctx = {
    on: context.on,
    tools: context.toolsService,
    skills: { async list() { throw new Error('provider down') } },
    workingDirectory: { async ensure() { return 'C:\\workspace' } },
  }
  apply(ctx, { usagePath: join(root, 'broken.json') })
  await claim(context, '这个插件要给 skills 标上使用率')
  const decision = await loadSkill(context, 'frontend-craft')
  assert.equal(decision.kind, 'allow')
})

await rm(root, { recursive: true, force: true })

console.log(`\nplugin checks: ${total}, failed: ${failed}`)
if (failed > 0) process.exitCode = 1