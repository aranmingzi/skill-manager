# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.2.0

### Changed

- Renamed to **skill-manager**: package name, patch row, ledger directory (`<profile>/skill-manager/usage.json`) and the `skill-manager-usage` message source. Tool names (`skill_search`, `skill_usage`) and configuration keys are unchanged, so existing profiles only need a plugin reinstall and a restart.
- README split into English (default) and [简体中文](README.zh-CN.md); added [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md), CONTRIBUTING, CHANGELOG, LICENSE, and `scripts/publish.ps1` for publishing this repo to GitHub.
- Test script wired as `npm test`.

## 1.1.0

### Added

- `skill_usage` tool: loads, blocks, search wins, usage share and mean relevance per skill, ordered by use.
- Per-skill usage ledger persisted to `<profile>/skill-manager/usage.json`; `usagePath` and `usageKeep` control location and size.
- `usageHint` (default on): a compact `<skill_usage>` block is appended to the step after a counter changes, closing with the reminder that relevance — not popularity — decides.
- `skill_search` rows now carry `loads`, `blocks`, `share`, `average`, and each search records a `pick` for its top row.
- Three-mechanism, event, and symptom-tuning tables in the docs.

### Fixed

- The gate's `catch` no longer calls `next()` a second time after delegation; a late exception returns `{kind: 'allow'}` instead of re-entering the downstream chain.
- A ledger read that lands after the first recorded event can no longer overwrite it (`touched` guard).
- `record()` tolerates a `null` ledger instead of throwing on `usage.skills`.

## 1.0.0

### Added

- Relevance gate on `skill` calls: deny when another installed skill matches substantially better, with the top three alternatives and their scores.
- `force: true` escape hatch, per-request repeat protection, `alwaysAllow` / `disabled` name lists, `mode: off`.
- `skill_search` tool: ranked candidates with matched keywords and a one-line summary.
- IDF-weighted mixed Chinese/English scoring with negative trigger sections, name weighting, and alias vocabulary.
- `gapRatio`, `minTopScore`, `minTopHits`, `searchLimit` configuration.
- 36 unit and end-to-end checks across `router.js`, `usage.js` and `index.js`.