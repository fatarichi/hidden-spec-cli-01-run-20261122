[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fatarichi/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fatarichi/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format, per `SPEC.md` in the kit.

`main.ts` (Node 22, standard library only) reads a patch in one of four
formats — unified diff (line numbers may be wrong), SEARCH/REPLACE blocks,
V4A patches, or JSON tool calls — detects the format automatically (or with
`--format`), and applies every edit or none. Lines are matched at the first
of three tiers (exact, trailing whitespace, leading + trailing whitespace
with re-indentation); `--strict` uses exact matching only. `--check` reports
what would change without writing anything.

Usage: `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`

Practice set: 100/100 checks pass (score 1,000).

MIT licensed.
