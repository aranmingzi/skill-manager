# How it works

Three independent mechanisms, one shared index. Nothing here needs a model call: routing costs a catalog read and a few hundred floating-point operations.

```
user request ──▶ agent/pre-step ──▶ lastRequest: WeakMap<Agent, string>
                                          │
skill({name}) ──▶ tools/pre-execute ──▶ rank(all skills, request text)
                                          │
                        ┌─────────────────┴──────────────────┐
                     deny │                               allow │
             ranked alternatives                        count('load')
             + force hint                                next() ──▶ stock `skill` tool
```

## 1. Capturing the request

The plugin listens on `agent/pre-step`, which fires with the messages about to be sent. It keeps the text of the most recent **direct user message** (`source.kind === 'user'`) per agent in a `WeakMap`. Everything else — tool results, catalog injections, relays, notices — is ignored, because the question the router answers is "what did the human actually ask for".

Holding it in a `WeakMap` keyed by the agent object keeps multiple concurrent agents in one session from borrowing each other's requests, and leaves no cleanup work when an agent goes away.

The same listener appends the `skill_usage` block (see §5) when a counter has changed, using the standard `{...decision, messages: [...]}` waterfall contract.

## 2. The scoring model (`router.js`)

A skill becomes a document made of its `description` plus `whenToUse`, split into **positive** and **negative** evidence:

- anything from the first `DO NOT TRIGGER` / `不适用` / `不触发` / `别用` / `禁用场景` marker onward is negative evidence;
- everything before it is positive.

Tokenization is deliberately dictionary-free:

| Input | Tokens |
| --- | --- |
| latin words | lowercased, ≥2 chars, stopwords dropped, identifiers kept whole (`gpt-image-2.6`) |
| CJK runs | overlapping bigrams: `写个插件` → `写个`, `个插`, `插件` |

Overlapping bigrams are what let "写个插件" match a description that says "写插件" without a segmenter or a dictionary.

Each token is weighted by IDF over the installed catalog, `log(1 + (N + 0.5) / (df + 0.5))`, so words that appear in every skill description ("plugin", "文件") carry almost no signal while a rare word carries a lot.

Three refinements that matter in practice:

1. **Negative evidence subtracts.** A shared token found in a skill's *do-not-trigger* section costs `-2 × idf`, which is how "use vision for images" stops matching a *image-generation* skill that explicitly says so.
2. **Name tokens weigh 1.6×.** A skill called `frontend-craft` matches the word "frontend" more strongly than a description merely mentioning it.
3. **Aliases fold into the document.** `aliases.js` holds the vocabulary users actually type per skill (`页面太丑`, `去 AI 味`, `写个插件`). This is the cheapest way to fix a false block — usually the user's words never appear in the skill's own description.

The query side is deduplicated, and **tokens no installed skill mentions are dropped from the denominator** before coverage is computed. A long rambling request would otherwise dilute every candidate equally and make every score look weak.

`coverage = clamp(score, 0, totalWeight) / totalWeight` where `totalWeight` is the summed IDF of the *distinguishing* query tokens. So coverage is "how much of the part of this request that any skill could match did this skill match", scaled to `0..1`. A verbatim skill name in the request adds `totalWeight`, pushing coverage to 1 — the user naming the skill is the strongest signal there is.

A skill that matches metadata only by its name adds `totalWeight`, and rank sorts by `coverage`, then hit count, then name for determinism.

## 3. The verdict (`decide()`)

`decide()` answers one narrow question: *is loading this skill defensible for this request?* It is written to be wrong in the safe direction — a dubious block costs a round trip and an argument, a missed block costs the whole reason the plugin exists.

Rules are evaluated in order; the first match wins:

| # | Rule | Outcome | Why |
| --- | --- | --- | --- |
| 1 | `unknown-skill` | allow | not installed; the stock tool will report it |
| 2 | `named-in-query` | allow | the request contains the skill name verbatim |
| 3 | `only-skill` | allow | nothing to compare against |
| 4 | `requested-is-best` | allow | it *is* the top candidate |
| 5 | `no-strong-candidate` | allow | `top.score < minTopScore`; nothing fits well, so don't insist |
| 6 | `candidate-too-weak` | allow | `top.hits < minTopHits`; one shared word is a coincidence |
| 7 | `requested-close-enough` | allow | `requested.coverage ≥ top.coverage × gapRatio` |
| 8 | `better-skill-exists` | **deny** | another skill matches substantially better |

Defaults: `gapRatio 0.45`, `minTopScore 1.2`, `minTopHits 2`. Rule 7 is the one that keeps the plugin tolerable: being 60% as relevant as the winner is not a mistake worth blocking.

The denial carries the top three alternatives with `score` and a one-line `whenToUse`/`description` summary, the `force: true` escape hatch, and a pointer to `skill_search` — so a blocked turn still ends with the model knowing what to do next, instead of guessing again.

## 4. Wiring (`index.js`)

| Hook | Type | Role |
| --- | --- | --- |
| `agent/pre-step` | waterfall | capture the request; append the usage block on change |
| `tools/pre-execute` | waterfall | the gate; deny, or `next()` |
| `ctx.tools.register` | — | `skill_search`, `skill_usage` |

The gate only ever inspects `exec.name === 'skill'`; every other tool call is delegated immediately. Per-agent state lives in three `WeakMap`s: `lastRequest` (the text), `deniedOnce` (which skill was denied for which request, so a second attempt in the same request passes), `annotated` (the last usage digest sent).

**Failure containment.** A gate that can throw is a gate that can break every tool call in the session, so the entire handler is wrapped: any exception before delegation becomes "allow", any exception after delegation returns `{kind: 'allow'}` instead of calling `next()` a second time (re-entering the downstream chain would run other plugins' listeners twice).

## 5. The ledger (`usage.js`)

State shape:

```json
{
  "version": 1,
  "total": 14,
  "blocks": 2,
  "skills": {
    "dsh-doc": { "loads": 9, "blocks": 2, "picks": 3, "coverageSum": 5.5, "scored": 9, "lastAt": 1764... }
  }
}
```

- `share = loads / total` (the usage rate), `average = coverageSum / scored`.
- Every mutation is copy-on-write and pruned to `usageKeep` entries, dropping least-recently-used unused entries first, so the file cannot grow without bound.
- Writes are serialized on one promise chain and coalesced per turn; the file is a few hundred bytes.
- Disk reads are asynchronous but guarded by a `touched` flag: a slow read that lands after the first recorded event cannot overwrite it. Anything unreadable or half-written is salvaged by `harvest()`, which recomputes the totals rather than trusting them.
- Nothing in scoring or gating reads the ledger. The usage block is informational, and says so in its own closing line.

## 6. Tool definitions

Both tools are registered as plain `ToolDefinition` objects with hand-written JSON Schema — `defineTool()` in `dsh-tools` only compiles author-facing schema specs into exactly this shape, and importing it would require the harness loader to resolve `@deepseek-ai/*`, which a locally linked plugin cannot count on.

| Tool | Parameters | Output |
| --- | --- | --- |
| `skill_search` | `query` (required), `limit` | `{query, total, matches[{name, score, coverage, hits, description, whenToUse, loads, blocks, share, average}]}` |
| `skill_usage` | `limit` | `{known, total, blocks, rows[{name, loads, blocks, picks, share, average, lastAt}]}` |

Both render as compact text so the result reads well in a transcript, and both take `presentCall` hints that mark them as generic reads.

## 7. Tests

`router.js` and `usage.js` import nothing, which is the whole point of the split: plain `node` can test the decisions without a harness.

- `test/router.test.mjs` — 13 cases over an 11-skill fixture catalog, including the motivating failure (a plugin request loading a frontend-design skill), a named skill, a vague request that must never block, and a do-not-trigger precedence case.
- `test/usage.test.mjs` — 12 assertions: accumulation, shares, harvest of garbage, round-tripping, pruning, annotation text.
- `test/plugin.test.mjs` — 11 end-to-end checks driving the real `apply()` against a fake context: listeners, waterfall semantics, tool registration, the gate's allow/deny paths, `force`, repeat denial, `useHint` suppression, and a broken context that must not break the tool call.

`npm test` runs all three (36 checks).