# skill-manager

**Give your agent a brain for picking skills — and a ledger that shows which skills it actually uses.**

`skill-manager` is a DeepSeek Harness (DSH) host plugin. Before every `skill` tool call it scores the requested skill against the *current* request, blocks the load when another skill fits substantially better, and hands back a ranked shortlist instead. It also keeps a per-skill usage ledger, so "which skills are dead weight in my profile" becomes a number instead of a guess.

Zero dependencies. Pure ES modules. No build step.

[中文说明](README.zh-CN.md) · [How it works](docs/HOW-IT-WORKS.md) · [Changelog](CHANGELOG.md)

---

## The problem

A profile with forty installed skills gives the model a catalog of forty one-line descriptions and one tool: `skill({ name })`. Choosing is guesswork, and the failure is asymmetric:

- Pick wrong → a whole instruction file lands in the context window. Real tokens, real money, zero relevance.
- Pick nothing → work goes forward without the instructions that would have made it correct.

Nothing in that loop learns. A skill nobody ever uses stays in the catalog forever, looking exactly as attractive as the one that solves the task.

## What it does

| Mechanism | Behavior |
| --- | --- |
| **Gate** | On `skill({ name })`, rank every installed skill against the current user request. Deny the load when the requested skill's relevance is far below the best candidate — and name the top three alternatives with their scores. |
| **Search** | New tool `skill_search({ query })`: ranked candidates with the keywords that matched, a one-line summary, and each skill's historical usage. Search first, then load the winner. |
| **Ledger** | New tool `skill_usage()`: loads, share of all loads, blocks, search wins, mean relevance. Persisted per profile in `skill-manager/usage.json`. |

The gate is conservative by construction: it only blocks when *another skill matches substantially better*. A merely mediocre match is never punished, and any of these short-circuits to "allow":

- the requested name appears in the request (the user asked for it by name);
- the request was already denied for that skill once (no deny loops);
- fewer than two skills are installed, or the winning candidate is too weak to be worth insisting on;
- `force: true` was passed by the model, or the skill is in `alwaysAllow`.

## Quick start

```bash
git clone https://github.com/aranmingzi/skill-manager.git
```

1. **Install** — DSH → 设置 → 插件 → 安装本地插件 → point at the clone (the folder with `package.json`).
2. **Restart DSH** — the tool list gains `skill_search` and `skill_usage`.
3. **Use it** — let the model call `skill_search({ query })` before loading a skill; `skill_usage()` shows what your profile actually uses.
4. **Tune** — most false blocks are vocabulary gaps, so edit `aliases.js` before touching the thresholds.

## Install

Requires a DSH build that exposes `ctx.skills` and `ctx.tools` to host plugins.

```bash
git clone https://github.com/aranmingzi/skill-manager.git
```

Then, in DSH: **设置 → 插件 → 安装本地插件**, and point it at the cloned directory (the one containing `package.json` and `cordis.patch.yml`). The plugin manager copies/links the package into your profile, adds the `skill-manager` row, and prints `enabled: true`.

Restart DSH. You should now see `skill_search` and `skill_usage` in the tool list, and a new *Skill Manager* entry in the plugin list.

Agent-driven install (no clicking) is the same operation through the host tool:

```text
plugin_manager { action: "install_bundle", target: "<absolute path to the clone>" }
```

### Verify it is live

Ask the agent something unrelated to a heavy skill and watch it try anyway — for example, ask for a plugin tweak while a frontend-design skill is installed. The `skill` call should be refused with a reason listing better candidates. Or just call `skill_usage()`; an empty ledger still answers with the totals row.

## Usage

**Search before loading.** The model should call `skill_search({ query })` with the task in its own words whenever it is unsure which skill applies:

```text
skill_search { "query": "make the settings page look less like a template" }
→ 1. frontend-craft         0.82  used 14 (38%) · rel 0.79  页面太丑/去 AI 味/美化前端
  2. design-taste-frontend  0.41  used 2 (5%) · rel 0.55    anti-slop landing pages
  3. dsh-doc                0.12  used 9 (24%) · rel 0.61    DSH plugin API reference
```

**Read the ledger.** `skill_usage({ limit })` prints one line per skill, ordered by loads:

```text
skill_usage { "limit": 5 }
→ - frontend-craft 14 loads · 37.8% · 0 blocked · 6 search wins · mean relevance 0.79
  - dsh-doc        9 loads · 24.3% · 2 blocked · 3 search wins · mean relevance 0.61
  - embed          0 loads ·  0.0% · 0 blocked · 0 search wins · mean relevance —
```

**Escape hatch.** A denial is a suggestion with teeth, not a wall. The reason text tells the model to retry with `force: true` if it is certain; that load is allowed and still counted.

## What the ledger records

Three events, accumulated per skill name:

| Event | Recorded when |
| --- | --- |
| `load` | a `skill` call was actually allowed (includes `force`, named-in-request, `alwaysAllow`) |
| `block` | the router denied it, or the `disabled` list refused it |
| `pick` | `skill_search` ranked it first |

Two derived numbers:

- **share** = `skill loads / all skill loads` — the usage rate. Answers "which of my skills is dead weight".
- **mean relevance** = average relevance of that skill's allowed loads, against the request that triggered each load. Persistently low means it gets loaded when it does not fit, or its description misleads.

With `usageHint` on (default), a compact `<skill_usage>` block is appended to the step after the numbers change — one line per skill, capped at twelve, ordered by loads. It closes with a line the model is meant to read literally: **relevance is still the only basis for choosing; being rarely used does not make a skill wrong.** Usage never feeds scoring or the gate, so there is no rich-get-richer drift.

## Configuration

Settings live on the plugin's row in the profile (`config:` block); the plugin normalizes them in `apply()`, and illegal values fall back to defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `block` | `off` keeps search + ledger, drops the gate |
| `gapRatio` | `0.45` | requested relevance must reach this fraction of the best candidate to pass |
| `minTopScore` | `1.2` | if the best candidate scores below this, allow everything |
| `minTopHits` | `2` | best candidate must match at least this many distinct keywords |
| `alwaysAllow` | `[]` | skill names that are never blocked |
| `disabled` | `[]` | skill names that are always blocked |
| `searchLimit` | `5` | default number of candidates returned by `skill_search` |
| `usageHint` | `true` | append the usage block to the step |
| `usagePath` | `''` | ledger path; empty means `<profile>/skill-manager/usage.json` |
| `usageKeep` | `200` | max ledger entries kept; oldest-by-last-use dropped first |

## Tuning

| Symptom | Fix |
| --- | --- |
| A bad load got through | raise `gapRatio` (0.6), or lower `minTopScore` (0.8) |
| A correct load was blocked | add the skill to `alwaysAllow`, or add the user's real vocabulary to `aliases.js` — most false blocks are "the user says it this way, the description says it that way" |
| The suggested alternatives are nonsense | the descriptions are too vague; add `whenToUse` before touching thresholds |
| The usage block is too chatty | `usageHint: false`; the ledger keeps recording and `skill_usage` still answers |
| Start the history over | delete `usage.json` |

After editing `aliases.js` or config, reload the plugin. Then run the tests — they encode the cases that must keep working.

## Cost

- A blocked `skill` call costs one catalog read (`ctx.skills.list`); no extra model request.
- An allowed call costs one in-memory ranking pass; no I/O.
- Ledger writes are a few hundred bytes, coalesced per turn.
- The usage block is re-sent only when a counter changes.
- Every denial costs the model one extra round trip. That asymmetry is why the default thresholds lean lenient: better to miss a block than to argue with a correct choice.

## Uninstall

Remove the plugin from **设置 → 插件**. The `skill` tool returns to its stock behavior, `skill_search` and `skill_usage` disappear, and the ledger stops recording (an existing `usage.json` is left alone).

## Development

```bash
npm test          # or: node test/router.test.mjs && node test/usage.test.mjs && node test/plugin.test.mjs
```

36 checks: 13 routing fixtures, 12 ledger assertions, 11 end-to-end checks that drive the real `apply()` against a fake context.

`router.js` (scoring + verdict) and `usage.js` (ledger) import nothing at all — DSH's own packages do not resolve outside the harness loader, so all logic lives in dependency-free modules that plain `node` can test. `index.js` only wires the three mechanisms onto DSH events and tools.

See [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) for the scoring model, the decision rule table, and the event flow.

## License

[MIT](LICENSE)