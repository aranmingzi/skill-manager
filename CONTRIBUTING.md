# Contributing

Thanks for taking a look. This plugin's whole value is in being *predictable*, so the bar for changes is:

1. **Run the tests.** `npm test` must pass (36 checks). If you change scoring or a threshold, add a fixture that fails before your change and passes after.
2. **Keep the logic dependency-free.** `router.js` and `usage.js` must import nothing. `@deepseek-ai/*` does not resolve outside the DSH loader, so anything that needs testing has to live in those files. `index.js` is the only place that touches DSH.
3. **Prefer the safe direction.** A missed block costs relevance; a wrong block costs a round trip and the user's trust. New rules should be conservative, and any deny path needs an escape hatch.
4. **Don't let usage feed routing.** The ledger is informational by design; scoring against it would make popular skills structurally unbeatable.

## Adding vocabulary

Most "it blocked the wrong skill" reports are a vocabulary gap, not a maths problem. Add the words the user actually types to `aliases.js`:

```js
export const ALIASES = {
  'your-skill': ['用户会打的词', '英文也会打的词', 'how the user phrases it'],
}
```

Then add a fixture to `test/router.test.mjs` that asserts the new phrasing ranks the skill first.

## Adding a skill-shaped heuristic

If you want to teach the router something new about *descriptions* (a new negative marker, a new weighting rule), put it in `router.js` behind a small pure function and cover it with a case in `test/router.test.mjs`. Do not read files, spawn processes, or import DSH from there.

## Reporting a bad block

Open an issue with:

- the user request text,
- the skill the model tried to load,
- the skills installed (names only),
- the denial reason the plugin produced.

That is enough to reproduce a scoring case as a fixture.

## Code style

- ES modules, no build step, no dependencies.
- Two-space indent, no semicolons, single quotes, `const` by default.
- JSDoc on exported functions; comments explain *why*, not *what*.
- User-facing strings in the tool output follow the user's language; keep tool names and JSON keys in English.