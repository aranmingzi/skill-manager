/**
 * Pure routing engine for the skill-manager plugin.
 *
 * No imports, no I/O, no DSH types: the harness loader cannot resolve
 * `@deepseek-ai/*` outside the running harness, so everything that needs unit
 * tests lives here and everything that needs the runtime lives in `index.js`.
 *
 * Scoring model: IDF-weighted bag of tokens, with three refinements that matter
 * for real skill descriptions —
 *   1. `DO NOT TRIGGER` / `不适用` sections count as negative evidence;
 *   2. tokens that appear in the skill *name* weigh more than description words;
 *   3. alias words (the user's own vocabulary) are folded into the skill doc.
 */

/** Common English words that carry no routing signal. */
const EN_STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'as', 'at', 'by', 'for', 'from',
  'in', 'into', 'of', 'on', 'to', 'with', 'without', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'done', 'has', 'have', 'had', 'can', 'could', 'should', 'would', 'may', 'might',
  'will', 'must', 'shall', 'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'you', 'your', 'yours', 'we', 'our', 'us', 'me', 'my', 'i', 'he', 'she', 'his', 'her', 'who', 'what',
  'when', 'where', 'which', 'how', 'why', 'not', 'no', 'nor', 'only', 'also', 'just', 'very', 'more',
  'most', 'some', 'any', 'all', 'each', 'every', 'both', 'either', 'other', 'another', 'such', 'same',
  'use', 'used', 'using', 'uses', 'instead', 'user', 'users', 'task', 'tasks', 'work', 'works', 'need',
  'needs', 'needed', 'want', 'wants', 'like', 'make', 'makes', 'made', 'give', 'gives', 'get', 'gets',
  'one', 'two', 'first', 'before', 'after', 'during', 'while', 'about', 'over', 'under', 'between',
  'trigger', 'triggers', 'triggered', 'when', 'does', 'do', 'dot', 'not', 'skill', 'skills',
])

/** Common Chinese bigrams / words that carry no routing signal. */
const ZH_STOP = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '这些', '那些', '一个', '一些', '一下', '一点',
  '可以', '可以', '什么', '怎么', '怎样', '如何', '为什', '因为', '所以', '但是', '不过', '而且',
  '然后', '现在', '已经', '还是', '就是', '不是', '没有', '有的', '这样', '那样', '如果', '假如',
  '帮我', '帮忙', '请你', '麻烦', '需要', '想要', '我要', '我想', '给我', '把它', '把它', '看着',
  '时候', '东西', '事情', '问题', '方法', '方式', '情况', '地方', '这里', '那里', '知道', '觉得',
  '一下', '一起', '有点', '比较', '非常', '特别', '真的', '其实', '应该', '可能', '或者', '以及',
  '时用', '时使', '使用', '用于', '关于', '对于', '通过', '进行', '出来', '起来', '下来', '过来',
])

/** One CJK character run (no separators inside). */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

/** One latin word, allowing the separators real identifiers use. */
const LATIN_WORD = /[a-z][a-z0-9]+(?:[._+#-][a-z0-9]+)*/g

/** Markers that open a negative ("do not use me here") section. */
const NEGATIVE_MARKER = /do\s*n[o']?t\s*trigger|不适用|不触发|不要触发|别用|禁用场景|不要在|不适合/i

/**
 * Split a skill's prose into positive and negative evidence.
 * @param {string} text - description plus optional when-to-use note.
 * @returns {{ positive: string, negative: string }}
 */
export function splitTriggers(text) {
  const source = typeof text === 'string' ? text : ''
  const cut = source.search(NEGATIVE_MARKER)
  if (cut < 0) return { positive: source, negative: '' }
  return { positive: source.slice(0, cut), negative: source.slice(cut) }
}

/**
 * Tokenize mixed Chinese/English prose into routing tokens.
 * Chinese runs become overlapping bigrams, which is what makes
 * "写个插件" match "写插件" without a dictionary.
 * @param {string} text - any prose.
 * @returns {string[]} tokens in first-seen order, duplicates kept for tf.
 */
export function tokenize(text) {
  const out = []
  if (typeof text !== 'string' || text.length === 0) return out
  const lower = text.toLowerCase().replace(/\u3000/g, ' ')
  for (const match of lower.matchAll(LATIN_WORD)) {
    const token = match[0].replace(/[._+#-]+$/, '')
    if (token.length >= 2 && !EN_STOP.has(token)) out.push(token)
  }
  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0]
    if (run.length === 1) {
      if (!ZH_STOP.has(run)) out.push(run)
      continue
    }
    for (let index = 1; index < run.length; index += 1) {
      const bigram = run.slice(index - 1, index + 1)
      if (!ZH_STOP.has(bigram)) out.push(bigram)
    }
  }
  return out
}

/** Deduplicate while keeping first-seen order. */
function uniq(list) {
  return [...new Set(list)]
}

/**
 * Build a comparable index over the currently available skills.
 * @param {readonly {name: string, description?: string, whenToUse?: string}[]} skills - skill summaries.
 * @param {Record<string, readonly string[]>} [aliases] - extra user vocabulary per skill name.
 * @returns {{docs: object[], idf: (token: string) => number, size: number}}
 */
export function buildIndex(skills, aliases) {
  const aliasMap = aliases && typeof aliases === 'object' ? aliases : {}
  const df = new Map()
  const docs = []
  for (const skill of Array.isArray(skills) ? skills : []) {
    const name = typeof skill?.name === 'string' ? skill.name : ''
    if (name === '') continue
    const { positive, negative } = splitTriggers(
      `${skill.description ?? ''}\n${skill.whenToUse ?? ''}`,
    )
    const nameTokens = new Set(tokenize(name.replaceAll(/[^a-z0-9]+/g, ' ')))
    const pos = new Set(tokenize(positive))
    for (const token of nameTokens) pos.add(token)
    for (const alias of aliasMap[name] ?? []) {
      for (const token of tokenize(alias)) pos.add(token)
    }
    const neg = new Set(tokenize(negative))
    for (const token of pos) df.set(token, (df.get(token) ?? 0) + 1)
    docs.push({
      name,
      pos,
      neg,
      nameTokens,
      description: typeof skill.description === 'string' ? skill.description : '',
      whenToUse: typeof skill.whenToUse === 'string' ? skill.whenToUse : '',
    })
  }
  const size = docs.length
  const total = size > 0 ? size : 1
  const idf = token => Math.log(1 + (total + 0.5) / ((df.get(token) ?? 0) + 0.5))
  return { docs, df, idf, size }
}

/**
 * Rank every indexed skill against one query string.
 * @param {ReturnType<typeof buildIndex>} index - built index.
 * @param {string} query - the user's current request.
 * @param {{limit?: number}} [options] - how many rows to keep.
 * @returns {{name: string, score: number, coverage: number, hits: string[], description: string, whenToUse: string}[]}
 */
export function rank(index, query, options) {
  const limit = options?.limit ?? 5
  const queryTokens = uniq(tokenize(query))
  // Tokens no installed skill mentions cannot discriminate between candidates;
  // counting them in the denominator would only punish long, rambling requests.
  const denomTokens = queryTokens.filter(token => (index.df.get(token) ?? 0) > 0)
  const totalWeight = denomTokens.reduce((sum, token) => sum + index.idf(token), 0)
  const lowerQuery = typeof query === 'string' ? query.toLowerCase() : ''
  const rows = index.docs.map(doc => {
    let score = 0
    const hits = []
    for (const token of queryTokens) {
      const weight = index.idf(token)
      if (doc.neg.has(token)) {
        score -= 2 * weight
        continue
      }
      if (!doc.pos.has(token)) continue
      score += doc.nameTokens.has(token) ? weight * 1.6 : weight
      hits.push(token)
    }
    // A verbatim skill name in the request is the strongest possible signal:
    // the user (or the model quoting the user) asked for this skill by name.
    const named = doc.name !== '' && lowerQuery.includes(doc.name.toLowerCase())
    if (named) score += Math.max(totalWeight, 1)
    const coverage = totalWeight > 0 ? Math.min(1, Math.max(0, score) / totalWeight) : 0
    return {
      name: doc.name,
      score,
      coverage,
      hits,
      description: doc.description,
      whenToUse: doc.whenToUse,
      named,
    }
  })
  rows.sort((a, b) => b.coverage - a.coverage || b.hits.length - a.hits.length || a.name.localeCompare(b.name))
  return rows.slice(0, Math.max(1, limit))
}

/**
 * Decide whether loading `requestedName` is defensible for `query`.
 *
 * Conservative by construction: it only blocks when another skill matches
 * substantially better, so a merely mediocre match is never punished.
 * @param {ReturnType<typeof buildIndex>} index - built index.
 * @param {string} query - the user's current request.
 * @param {string} requestedName - the skill the model is about to load.
 * @param {{gapRatio?: number, minTopCoverage?: number, minTopHits?: number}} [options] - thresholds.
 * @returns {{allow: boolean, requested: object|null, alternatives: object[], rule: string}}
 */
export function decide(index, query, requestedName, options) {
  const gapRatio = options?.gapRatio ?? 0.45
  const minTopScore = options?.minTopScore ?? 1.2
  const minTopHits = options?.minTopHits ?? 2
  const rows = rank(index, query, { limit: index.docs.length })
  const requested = rows.find(row => row.name === requestedName) ?? null
  const alternatives = rows.filter(row => row.name !== requestedName)
  const top = alternatives[0] ?? null
  const verdict = (allow, rule) => ({ allow, requested, alternatives: alternatives.slice(0, 3), rule })
  if (requested === null) return verdict(true, 'unknown-skill')
  if (requested.named) return verdict(true, 'named-in-query')
  if (top === null) return verdict(true, 'only-skill')
  if (requested.coverage >= top.coverage) return verdict(true, 'requested-is-best')
  if (top.score < minTopScore) return verdict(true, 'no-strong-candidate')
  if (top.hits.length < minTopHits) return verdict(true, 'candidate-too-weak')
  if (requested.coverage >= top.coverage * gapRatio) return verdict(true, 'requested-close-enough')
  return verdict(false, 'better-skill-exists')
}

/** One-line reason for a skill, trimmed for a tool result. */
export function summarize(skill, maxLength = 120) {
  const text = String(skill?.whenToUse || skill?.description || '').replaceAll(/\s+/g, ' ').trim()
  const limit = Number.isFinite(maxLength) ? maxLength : 120
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`
}