<!-- Copyright © 2026 Steven Kreutzer. All Rights Reserved. -->
# P0 — Repository Snapshot

**Taken:** 2026-08-31 · **Branch:** `main` · **HEAD at snapshot:** `bb4c608`

## State before any manifesto work

| | |
|---|---|
| Workspace packages | 62 |
| Package manager | npm workspaces (`packages/*`), `package-lock.json` |
| Root `tsc -b --force` | **exit 0** |
| Full suite | **257 files / 5,643 tests, exit 0** |
| Pre-existing failures | none |
| Unpushed commits | 0 |
| Dirty files | 3, all belonging to the concurrent session (`foundry-evolutioniq`, `governance-engine`, `simulation-lab`) — **not touched** |

**No local work was discarded.** The three dirty files were left exactly as found and are not part of any commit made under this directive.

## One known flake, pre-existing

`packages/costiq/src/perf/__tests__/budgets.test.ts` — the `costGraph.rollup` complexity gate measures wall-clock and lands exactly on its 1.5 ceiling under parallel-suite CPU contention. It passes 3/3 in isolation and last changed in an unrelated CostIQ commit. **Recorded as pre-existing, not caused by this work, and not counted as a new failure.** A gate whose verdict depends on machine load will eventually block CI for a reason unrelated to the code.

## Verify commands

```bash
npx tsc -b --force          # exit code, not piped output
npx vitest run
```

Exit codes are read directly. A piped `cmd | head; echo $?` reports the exit status of `head`, which has bitten this repository before.
