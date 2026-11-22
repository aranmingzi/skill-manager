/**
 * skill-manager — route skill loading by relevance, and keep score of how the
 * skills are actually used.
 *
 * Three halves:
 *  - a gate on the built-in `skill` tool: a load whose skill matches far worse
 *    than some other available skill is denied, and the denial names the better
 *    candidates plus a `force: true` escape hatch;
 *  - a `skill_search` tool: ranked, scored search over the live skill catalog for
 *    when the model does not know which skill it wants;
 *  - a usage ledger: every real load, block, and search win is counted per skill
 *    and written to one JSON file, so the catalog annotation and the tools can
 *    show a usage rate instead of a guess.
 *
 * The plugin deliberately imports nothing but its own sibling modules and node
 * builtins: Host rows are loaded from wherever the profile resolved the package,
 * so a self-contained module resolves identically no matter how it was installed.
 * The tool definitions are written as the raw `ToolDefinition` shape (`defineTool`
 * only compiles author schemas and validates arguments, both done here by hand).
 *
 * @module skill-manager
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { ALIASES } from './aliases.js'
import { buildIndex, decide, rank, summarize } from './router.js'
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
} from './usage.js'

export const name = 'skill-manager'

/** Services that must exist before routing can run. */
export const inject = ['tools', 'skills', 'workingDirectory']

const DEFAULTS = {
  /** `block` denies irrelevant loads; `off` only serves `skill_search`. */
  mode: 'block',
  /** Requested skill must reach this fraction of the best alternative's score. */
  gapRatio: 0.45,
  /** Best alternative needs at least this absolute score to justify a denial. */
  minTopScore: 1.2,
  /** A candidate needs this many distinct matched tokens to count. */
  minTopHits: 2,
  /** Skill names that are never gated. */
  alwaysAllow: [],
  /** Skill names that are denied outright. */
  disabled: [],
  /** Default candidate count for `skill_search`. */
  searchLimit: 5,
  /** Append the usage ledger to the step as a compact annotation. */
  usageHint: true,
  /** Ledger file; empty means `<profile>/skill-manager/usage.json`. */
  usagePath: '',
  /** Entries retained in the ledger. */
  usageKeep: 200,
}

/** The current user request per agent, captured at step preparation. */
const lastRequest = new WeakMap()

/**
 * One denial per skill per request. A model that repeats the same load is not
 * arguing with the router, it is stuck on it; the second attempt is allowed so a
 * denial loop can never cost more than a single round trip.
 */
const deniedOnce = new WeakMap()

/** Last usage digest annotated for one agent, so unchanged numbers stay quiet. */
const annotated = new WeakMap()

/** Coerce raw config into a complete settings object. */
function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
  const number = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return {
    mode: source.mode === 'off' ? 'off' : 'block',
    gapRatio: number(source.gapRatio, DEFAULTS.gapRatio),
    minTopScore: number(source.minTopScore, DEFAULTS.minTopScore),
    minTopHits: number(source.minTopHits, DEFAULTS.minTopHits),
    alwaysAllow: strings(source.alwaysAllow),
    disabled: strings(source.disabled),
    searchLimit: Math.max(1, number(source.searchLimit, DEFAULTS.searchLimit)),
    usageHint: source.usageHint === false ? false : true,
    usagePath: typeof source.usagePath === 'string' ? source.usagePath : '',
    usageKeep: Math.max(1, number(source.usageKeep, DEFAULTS.usageKeep)),
  }
}

/** Default ledger location: the profile's own state, never the workspace. */
function defaultUsagePath() {
  const root = typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== ''
    ? process.env.DSH_PROFILE_DIR
    : join(homedir(), '.dsh')
  return join(root, 'skill-manager', 'usage.json')
}

/** Deep freeze a freshly built message so nothing downstream can edit it in place. */
function frozen(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) frozen(item)
    Object.freeze(value)
  }
  return value
}

/** A user-role context message carrying the ledger, same shape `createUserMessage` builds. */
function usageMessage(text, summary) {
  const bounded = summary.length <= 120 ? summary : `${summary.slice(0, 119)}…`
  return frozen({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'skill-manager-usage', form: 'notice', summary: bounded },
  })
}

/** Direct user prose from one step's claimed messages, latest first. */
function requestText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.source?.kind !== 'user') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return ''
}

/** Skill summaries that the model is allowed to load, as routing inputs. */
function routableSkills(summaries) {
  if (!Array.isArray(summaries)) return []
  return summaries
    .filter(summary => summary && typeof summary.name === 'string')
    .filter(summary => summary.invocation?.modelInvocable !== false)
}

/** Denial prose: what was asked, what scores better, how to override. */
function denyReason(verdict, requestedName, maxAlternatives = 3) {
  const lines = []
  const requested = verdict.requested
  const best = verdict.alternatives[0]
  lines.push(
    `skill-manager: \`${requestedName}\` 和这次请求的相关度太低`
    + `（${requested ? requested.coverage.toFixed(2) : '0.00'}，最佳候选 \`${best.name}\` ${best.coverage.toFixed(2)}）。`,
  )
  const ranked = verdict.alternatives.slice(0, maxAlternatives)
  if (ranked.length > 0) {
    lines.push('更贴合的候选：')
    for (const row of ranked) {
      const note = summarize(row)
      lines.push(`- \`${row.name}\` ${row.coverage.toFixed(2)}${note ? `：${note}` : ''}`)
    }
  }
  lines.push(`确实需要 \`${requestedName}\` 时带上强制位再调一次：skill({ "name": "${requestedName}", "force": true })。`)
  lines.push('拿不准要哪个：先 `skill_search({ "query": "<一句话说清任务>" })`。')
  return lines.join('\n')
}

/** Usage clause shared by both tools. */
function usageNote(row) {
  const parts = [`used ${row.loads} (${percent(row.share)})`]
  if (row.blocks > 0) parts.push(`blocked ${row.blocks}`)
  if (row.average > 0) parts.push(`rel ${row.average.toFixed(2)}`)
  return parts.join(' · ')
}

/** Render the `skill_search` result for the model. */
function renderSearch(_args, value) {
  const lines = [`query: ${value.query}`, `available: ${value.total}`]
  if (value.matches.length === 0) {
    lines.push('no skill matched this request; proceed without loading a skill.')
  } else {
    for (const row of value.matches) {
      const note = row.whenToUse || row.description
      lines.push(`- \`${row.name}\` score=${row.score.toFixed(2)} ${usageNote(row)} hits=[${row.hits.slice(0, 4).join(', ')}]`)
      if (note) lines.push(`  ${note}`)
    }
    lines.push(`load the best match with the \`skill\` tool: skill({ "name": "${value.matches[0].name}" })`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Render the `skill_usage` table. */
function renderUsage(_args, value) {
  const lines = [`skills with usage history: ${value.rows.length} of ${value.known} · loads ${value.total} · blocked ${value.blocks}`]
  if (value.rows.length === 0) {
    lines.push('no skill has been loaded yet; this machine has no usage history.')
  } else {
    for (const row of value.rows) {
      const parts = [`${row.loads} loads`, percent(row.share)]
      if (row.blocks > 0) parts.push(`${row.blocks} blocked`)
      if (row.picks > 0) parts.push(`${row.picks} search wins`)
      if (row.average > 0) parts.push(`mean relevance ${row.average.toFixed(2)}`)
      lines.push(`- \`${row.name}\`: ${parts.join(' · ')}`)
    }
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Raw parameter schema of `skill_search` (implicit open object root). */
const SEARCH_PARAMETERS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: '一句话说清这次要做什么、对象是什么，用用户自己的说法即可。',
    },
    limit: {
      type: 'integer',
      description: '返回几个候选，默认取插件配置 searchLimit。',
    },
  },
  required: ['query'],
}

/** Raw output schema of `skill_search`. */
const SEARCH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string' },
    total: { type: 'integer' },
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          score: { type: 'number' },
          coverage: { type: 'number' },
          hits: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          whenToUse: { type: 'string' },
          loads: { type: 'integer' },
          blocks: { type: 'integer' },
          share: { type: 'number' },
          average: { type: 'number' },
        },
      },
    },
  },
  required: ['query', 'total', 'matches'],
}

/** Raw parameter schema of `skill_usage`. */
const USAGE_PARAMETERS = {
  type: 'object',
  properties: {
    limit: {
      type: 'integer',
      description: '返回几行，默认 20；0 表示全部。',
    },
  },
}

/** Raw output schema of `skill_usage`. */
const USAGE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    known: { type: 'integer' },
    total: { type: 'integer' },
    blocks: { type: 'integer' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          loads: { type: 'integer' },
          blocks: { type: 'integer' },
          picks: { type: 'integer' },
          share: { type: 'number' },
          average: { type: 'number' },
          lastAt: { type: 'integer' },
        },
      },
    },
  },
  required: ['known', 'total', 'blocks', 'rows'],
}

/**
 * Install routing: request capture, the load gate, the search and usage tools,
 * and the ledger that both the gate and the tools read.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Partial<typeof DEFAULTS>} [rawConfig] - plugin configuration.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const ledgerPath = config.usagePath !== '' ? config.usagePath : defaultUsagePath()

  let ledger = emptyUsage()
  let loaded = false
  let touched = false
  let flushing = Promise.resolve()

  const load = async () => {
    let disk
    try {
      disk = harvest(JSON.parse(await readFile(ledgerPath, 'utf8')))
    } catch {
      disk = emptyUsage()
    }
    // A tool call can land before the file read finishes; never clobber it.
    if (!touched) ledger = disk
    loaded = true
  }
  const ready = load()

  /** Persist the ledger, coalesced: at most one write queued per event burst. */
  const flush = () => {
    if (!loaded) return
    const body = serializeUsage(ledger)
    flushing = flushing
      .then(async () => {
        await mkdir(dirname(ledgerPath), { recursive: true })
        await writeFile(ledgerPath, body, 'utf8')
      })
      .catch(() => {})
  }

  /** Count one event, then queue the write. */
  const count = (skill, kind, coverage) => {
    try {
      touched = true
      ledger = prune(record(ledger, skill, kind, { coverage }), { keep: config.usageKeep })
      flush()
    } catch {
      // A ledger failure must never cost a tool call.
    }
  }

  // The gate needs the *current* request. Reading it back out of session history
  // would couple this plugin to Agent internals; the step's claimed messages
  // carry it directly, so keep the latest one per agent.
  ctx.on('agent/pre-step', async (step, next) => {
    const text = requestText(step?.messages)
    if (step?.agent && text !== '') lastRequest.set(step.agent, text)
    const decision = await next()
    if (!config.usageHint || !step?.agent || !decision || decision.kind === 'reject') return decision
    const hint = formatHint(ledger)
    if (hint === '') return decision
    const print = digest(ledger)
    if (annotated.get(step.agent) === print) return decision
    annotated.set(step.agent, print)
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    return {
      ...decision,
      messages: [...messages, usageMessage(hint, `技能使用率：累计 ${ledger.total} 次加载`)],
    }
  })

  /** Skills the model may load, resolved for one agent. */
  const listSkills = async (agent, signal) => {
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    return ctx.skills.list({ cwd, signal, scope: agent })
  }

  /** Rank one request against the live catalog. */
  const search = async (agent, signal, query, limit) => {
    const skills = routableSkills(await listSkills(agent, signal))
    const index = buildIndex(skills, ALIASES)
    return { index, rows: rank(index, query, { limit }) }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    // Routing must never break a tool call. A throw before delegation becomes
    // "allow"; a throw after delegation must not run the chain twice.
    let delegated = false
    const delegate = async () => {
      delegated = true
      return next()
    }
    try {
      if (exec?.name !== 'skill') return await delegate()
      const requested = exec.arguments?.name
      if (typeof requested !== 'string' || requested === '') return await delegate()
      if (config.disabled.includes(requested)) {
        count(requested, 'block')
        return {
          kind: 'deny',
          reason: `skill-manager: \`${requested}\` 已被配置禁用（settings.disabled）；不要重试，换个做法或问用户。`,
        }
      }
      if (exec.arguments?.force === true || config.alwaysAllow.includes(requested) || config.mode !== 'block') {
        count(requested, 'load')
        return await delegate()
      }
      const agent = exec.agent
      const query = agent ? lastRequest.get(agent) : undefined
      if (!query) {
        count(requested, 'load')
        return await delegate()
      }
      if (query.toLowerCase().includes(requested.toLowerCase())) {
        count(requested, 'load')
        return await delegate()
      }
      if (agent) {
        const remembered = deniedOnce.get(agent)
        if (remembered?.get(requested) === query) {
          // Second attempt inside the same request: the model insists.
          count(requested, 'load')
          return await delegate()
        }
      }
      const skills = routableSkills(await listSkills(agent, exec.signal))
      if (skills.length < 2) {
        count(requested, 'load')
        return await delegate()
      }
      const index = buildIndex(skills, ALIASES)
      if (!index.docs.some(doc => doc.name === requested)) return await delegate()
      const verdict = decide(index, query, requested, config)
      if (verdict.allow) {
        count(requested, 'load', verdict.requested?.coverage ?? 0)
        return await delegate()
      }
      if (agent) {
        const remembered = deniedOnce.get(agent) ?? new Map()
        remembered.set(requested, query)
        deniedOnce.set(agent, remembered)
      }
      count(requested, 'block')
      return { kind: 'deny', reason: denyReason(verdict, requested) }
    } catch {
      return delegated ? { kind: 'allow' } : next()
    }
  })

  ctx.tools.register({
    name: 'skill_search',
    description: [
      '按相关度排一遍当前可用的技能，返回名称、得分、命中的关键词、一句话说明和历史使用率。',
      '任务边界说不清、或不确定该加载哪个技能时先调它，再对第一名调 `skill`。',
      '已经知道确切技能名时不要用它，直接 `skill`。',
    ].join(''),
    parameters: SEARCH_PARAMETERS,
    output: {
      schema: SEARCH_OUTPUT,
      render: renderSearch,
    },
    isConcurrencySafe: () => true,
    presentCall(args) {
      return { card: 'generic', title: `Search skills: ${args.query}`, kind: 'read', rawInput: args.query }
    },
    async execute(args, exec) {
      const query = args?.query
      if (typeof query !== 'string' || query.trim() === '') {
        throw new Error('skill_search: `query` must be a non-empty string describing the task')
      }
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : config.searchLimit
      const { index, rows } = await search(exec.agent, exec.signal, query, limit)
      if (rows.length > 0) count(rows[0].name, 'pick')
      return {
        query,
        total: index.size,
        matches: rows.map(row => {
          const used = stats(ledger, row.name)
          return {
            name: row.name,
            score: Number(row.score.toFixed(3)),
            coverage: Number(row.coverage.toFixed(3)),
            hits: row.hits.slice(0, 8),
            description: summarize(row, 240),
            whenToUse: summarize({ whenToUse: row.whenToUse }, 200),
            loads: used.loads,
            blocks: used.blocks,
            share: Number(used.share.toFixed(3)),
            average: Number(used.average.toFixed(3)),
          }
        }),
      }
    },
  })

  ctx.tools.register({
    name: 'skill_usage',
    description: [
      '列出每个技能的历史使用率：加载次数、占全部加载的比例、被路由拦下的次数、被搜索选中的次数、加载时的平均相关度。',
      '想知道「哪些技能其实没人用」「哪个总是被误加载」时用它；数据来自本机账本，不是这次会话的猜测。',
    ].join(''),
    parameters: USAGE_PARAMETERS,
    output: {
      schema: USAGE_OUTPUT,
      render: renderUsage,
    },
    isConcurrencySafe: () => true,
    presentCall() {
      return { card: 'generic', title: 'Skill usage', kind: 'read' }
    },
    async execute(args) {
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : 20
      const rows = ranking(ledger, { limit: args?.limit === 0 ? 1000 : limit, includeUnused: false }).map(row => ({
        name: row.name,
        loads: row.loads,
        blocks: row.blocks,
        picks: row.picks,
        share: Number(row.share.toFixed(3)),
        average: Number(row.average.toFixed(3)),
        lastAt: Math.round(row.lastAt),
      }))
      return {
        known: Object.keys(ledger.skills).length,
        total: ledger.total,
        blocks: ledger.blocks,
        rows,
      }
    },
  })

  // Expose readiness so a caller (tests, diagnostics) can await the first read.
  return { ready, ledgerPath }
}