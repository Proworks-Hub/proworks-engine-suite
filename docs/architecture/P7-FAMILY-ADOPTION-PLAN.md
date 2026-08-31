<!-- Copyright © 2026 Steven Kreutzer. All Rights Reserved. -->
# P7 — Family Adoption Plan

**GENERATED** from the live workspace. Regenerate; do not hand-edit.

## Where this stands

**1 of 64 packages adopted.** Remaining: 63.

Console headline: `2 of 65 adopted`

## Next up

- `@proworks-hub/allocationiq`
- `@proworks-hub/aria`
- `@proworks-hub/assetfinanceiq`
- `@proworks-hub/billingiq`
- `@proworks-hub/budgetiq`
- `@proworks-hub/closeiq`
- `@proworks-hub/collectionsiq`
- `@proworks-hub/communication-core`

## Waves

Ordered by blast radius ascending. The obvious reason is that a mistake in a leaf hurts less. The real reason is that adoption is a learning exercise, and you want the lessons before touching something the whole suite imports.

### Wave 0 — Already adopted (1)

| Package | Importers | Rationale |
|---|---:|---|
| `@proworks-hub/architecture-engine` | 0 | nothing in the workspace imports it, so a mistake here is contained |

### Wave 1 — Leaves — nothing imports them (56)

| Package | Importers | Rationale |
|---|---:|---|
| `@proworks-hub/allocationiq` | 0 | nothing in the workspace imports it, so a mistake here is contained |
| `@proworks-hub/aria` | 0 | nothing in the workspace imports it, so a mistake here is contained |
| `@proworks-hub/assetfinanceiq` | 0 | nothing in the workspace imports it, so a mistake here is contained |
| `@proworks-hub/billingiq` | 0 | nothing in the workspace imports it, so a mistake here is contained |
| `@proworks-hub/budgetiq` | 0 | nothing in the workspace imports it, so a mistake here is contained |
| `@proworks-hub/closeiq` | 0 | nothing in the workspace imports it, so a mistake here is contained |
| `@proworks-hub/collectionsiq` | 0 | nothing in the workspace imports it, so a mistake here is contained |
| `@proworks-hub/communication-core` | 0 | nothing in the workspace imports it, so a mistake here is contained |
| `@proworks-hub/consolidationiq` | 0 | nothing in the workspace imports it, so a mistake here is contained |
| `@proworks-hub/control-plane` | 0 | nothing in the workspace imports it, so a mistake here is contained |
| *…and 46 more* | | |

### Wave 2 — Lightly depended upon — one or two importers (5)

| Package | Importers | Rationale |
|---|---:|---|
| `@proworks-hub/eventiq` | 1 | 1 package imports it, so adopt it once the standard's cost is known |
| `@proworks-hub/hive-runtime` | 1 | 1 package imports it, so adopt it once the standard's cost is known |
| `@proworks-hub/repair-learning` | 1 | 1 package imports it, so adopt it once the standard's cost is known |
| `@proworks-hub/auditiq` | 2 | 2 packages import it, so adopt it once the standard's cost is known |
| `@proworks-hub/intelligence-core` | 2 | 2 packages import it, so adopt it once the standard's cost is known |

### Wave 4 — Foundational — the blast radius is the whole suite (2)

| Package | Importers | Rationale |
|---|---:|---|
| `@proworks-hub/core-kit` | 38 | 38 packages import it, so adopt it once the standard's cost is known |
| `@proworks-hub/contracts` | 59 | 59 packages import it, so adopt it once the standard's cost is known |

## Builder build context

Standard: `common-hive-runtime-v1` · Golden Reference: `hive.architecture.golden-reference`
Blocking rules: 10 · Advisory: 1 · Governed: 0
Capabilities exposed: 10, all READ_ONLY

**Stated limitations, carried with the context:**

- Conformance is about shape, not correctness. A fully conformant engine can still compute the wrong answer.
- 29 manifesto rules have no automated check yet.
- Passing every rule is not certification, and certification is not permission to deploy.
