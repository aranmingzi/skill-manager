/**
 * Usage ledger for skills: how often each skill was actually loaded, how often a
 * load was blocked as irrelevant, and how relevant the loads were on average.
 *
 * Import-free on purpose — `index.js` owns the file I/O and the DSH wiring, so
 * every rule in here is testable from plain `node`.
 *
 * @module skill-manager/usage
 */

/** Version of the on-disk shape; bump when the entry fields change meaning. */
export const USAGE_VERSION = 1

/** Cap on retained entries so a long-lived machine never grows the file forever. */
const KEEP_ENTRIES = 200

/** One skill's counters. */
function emptyEntry() {
  return {
    /** Completed `skill` loads. */
    loads: 0,
    /** Loads denied by the router. */
    blocks: 0,
    /** Times `skill_search` returned this skill first. */
    picks: 0,
    /** Sum of the relevance coverage of recorded loads. */
    coverageSum: 0,
    /** Loads that contributed to `coverageSum`. */
    scored: 0,
    /** Last recorded activity, epoch milliseconds. */
    lastAt: 0,
  }
}

/** A ledger with no history. */
export function emptyUsage() {
  return { version: USAGE_VERSION, total: 0, blocks: 0, skills: {} }
}

/** Coerce anything (a parsed file, a corrupt blob) into a usable ledger. */
export function harvest(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  const usage = emptyUsage()
  const table = source.skills !== null && typeof source.skills === 'object' ? source.skills : {}
  for (const [name, raw] of Object.entries(table)) {
    if (typeof name !== 'string' || name === '') continue
    const entry = raw !== null && typeof raw === 'object' ? raw : {}
    const count = key => (Number.isFinite(entry[key]) && entry[key] > 0 ? Math.floor(entry[key]) : 0)
    usage.skills[name] = {
      loads: count('loads'),
      blocks: count('blocks'),
      picks: count('picks'),
      coverageSum: Number.isFinite(entry.coverageSum) && entry.coverageSum > 0 ? entry.coverageSum : 0,
      scored: count('scored'),
      lastAt: Number.isFinite(entry.lastAt) && entry.lastAt > 0 ? entry.lastAt : 0,
    }
  }
  usage.total = Object.values(usage.skills).reduce((sum, entry) => sum + entry.loads, 0)
  usage.blocks = Object.values(usage.skills).reduce((sum, entry) => sum + entry.blocks, 0)
  return usage
}

/** Serialize a ledger for the file on disk. */
export function serializeUsage(usage) {
  return `${JSON.stringify(usage, null, 2)}\n`
}

/**
 * Record one event against a skill.
 * @param usage - current ledger; never mutated.
 * @param name - skill name.
 * @param kind - `load`, `block`, or `pick`.
 * @param options - optional relevance coverage of a load, and the event time.
 * @returns A new ledger.
 */
export function record(usage, name, kind, options = {}) {
  if (typeof name !== 'string' || name === '') return usage
  if (kind !== 'load' && kind !== 'block' && kind !== 'pick') return usage
  const source = usage !== null && typeof usage === 'object' && usage.skills !== null && typeof usage.skills === 'object'
    ? usage
    : emptyUsage()
  const at = Number.isFinite(options.at) ? options.at : Date.now()
  const previous = source.skills[name] ?? emptyEntry()
  const entry = { ...previous, lastAt: at }
  if (kind === 'load') {
    entry.loads += 1
    const coverage = options.coverage
    if (Number.isFinite(coverage) && coverage >= 0) {
      entry.coverageSum += coverage
      entry.scored += 1
    }
  } else if (kind === 'block') {
    entry.blocks += 1
  } else {
    entry.picks += 1
  }
  const skills = { ...source.skills, [name]: entry }
  const total = Object.values(skills).reduce((sum, row) => sum + row.loads, 0)
  const blocks = Object.values(skills).reduce((sum, row) => sum + row.blocks, 0)
  return { ...source, skills, total, blocks }
}

/**
 * Public per-skill numbers.
 * @param usage - current ledger.
 * @param name - skill name.
 * @returns Counters plus derived share-of-loads and mean relevance.
 */
export function stats(usage, name) {
  const entry = usage.skills[name]
  if (!entry) return { loads: 0, blocks: 0, picks: 0, share: 0, average: 0, lastAt: 0 }
  return {
    loads: entry.loads,
    blocks: entry.blocks,
    picks: entry.picks,
    share: usage.total > 0 ? entry.loads / usage.total : 0,
    average: entry.scored > 0 ? entry.coverageSum / entry.scored : 0,
    lastAt: entry.lastAt,
  }
}

/**
 * Skills ordered by how much they are actually used.
 * @param usage - current ledger.
 * @param options - `limit` caps the rows; `includeUnused` keeps zero-load skills.
 * @returns Rows with the public counters attached.
 */
export function ranking(usage, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20
  const rows = Object.entries(usage.skills)
    .map(([name, entry]) => ({ name, entry }))
    .filter(({ entry }) => options.includeUnused === true || entry.loads > 0 || entry.blocks > 0)
    .map(({ name }) => ({ name, ...stats(usage, name) }))
    .sort((left, right) => right.loads - left.loads || right.blocks - left.blocks || left.name.localeCompare(right.name))
  return rows.slice(0, limit)
}

/** Percent rendering that keeps tiny non-zero shares visible. */
export function percent(value) {
  if (!Number.isFinite(value) || value <= 0) return '0%'
  const rounded = Math.round(value * 1000) / 10
  if (rounded < 0.1) return '<0.1%'
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`
}

/** One line per used skill, for the catalog annotation. */
export function formatHint(usage, options = {}) {
  const rows = ranking(usage, { limit: options.limit ?? 12 })
  if (rows.length === 0) return ''
  const lines = [`<skill_usage>技能使用率（本机累计，共 ${usage.total} 次加载）：`]
  for (const row of rows) {
    const parts = [`加载 ${row.loads} 次 · ${percent(row.share)}`]
    if (row.blocks > 0) parts.push(`被拦 ${row.blocks}`)
    if (row.average > 0) parts.push(`相关度均值 ${row.average.toFixed(2)}`)
    lines.push(`- ${row.name}：${parts.join(' · ')}`)
  }
  lines.push('只描述历史使用偏好：相关度仍是选技能的唯一依据，用得少不代表不该用。</skill_usage>')
  return lines.join('\n')
}

/** Digest used to avoid re-annotating unchanged usage on every step. */
export function digest(usage) {
  return ranking(usage, { limit: 200 })
    .map(row => `${row.name}:${row.loads}:${row.blocks}`)
    .join('|')
}

/**
 * Drop cold entries so the ledger stays bounded.
 * @param usage - current ledger.
 * @param options - `keep` entries to retain, `keepUnused` retains zero-load rows.
 * @returns A pruned ledger.
 */
export function prune(usage, options = {}) {
  const keep = Number.isInteger(options.keep) && options.keep > 0 ? options.keep : KEEP_ENTRIES
  const entries = Object.entries(usage.skills)
  if (entries.length <= keep) return usage
  const survivors = entries
    .filter(([, entry]) => options.keepUnused === true || entry.loads > 0 || entry.blocks > 0)
    .sort((left, right) => right[1].lastAt - left[1].lastAt)
    .slice(0, keep)
  const skills = Object.fromEntries(survivors)
  const total = Object.values(skills).reduce((sum, entry) => sum + entry.loads, 0)
  const blocks = Object.values(skills).reduce((sum, entry) => sum + entry.blocks, 0)
  return { ...usage, skills, total, blocks }
}