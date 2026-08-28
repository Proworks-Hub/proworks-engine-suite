# ADR-001 — Hierarchical Hive Engine Architecture

Copyright © 2026 Steven Kreutzer. All rights reserved.
Status: **Accepted** · 2026-08-28 · Owner: Steven Kreutzer

## Context

The suite has grown from four engines to seventeen packages in a few months, and
the growth is not slowing: SenseIQ arrived this week, and the roadmap names
BudgetIQ, SchedulerIQ, AssetIQ, PeopleIQ and an industry layer beyond
manufacturing.

Today Prime depends only on `contracts`, and hosts call specialized engines
directly. That works at this size. It does not survive the trajectory.

The failure mode is specific and slow. Each new engine adds one more thing Prime
must know about, one more entry in a routing table, one more dependency to
consider when changing anything. At eight engines that is manageable. At eighty
it is a Prime nobody can test, nobody can reason about, and nobody dares modify
— which is the same thing as having no orchestrator at all, except harder to
replace.

The pressure to add each individual engine to Prime will always be locally
reasonable. That is what makes it dangerous.

## Decision

Adopt a hierarchical organization:

```
External application → Prime → Core → Specialized → Industry
```

Eight Core domains, deliberately hard to extend: Foundation, Knowledge,
Operations, Finance, Resources, Intelligence, Communication, Domain.

Prime knows eight domains. Each Core knows its own specialists. Specialists know
how to do one thing. The industry layer knows what that thing means in context.

Prime remains an **orchestrator, not a data path**. Cross-engine work may travel
by event under Prime's coordination without every byte passing through it —
making Prime proxy all traffic would convert the coordinator into the bottleneck
and the single point of failure, which is a worse outcome than the problem being
solved.

The taxonomy, dependency law and engine map are **executable**, in
`@proworks-hub/contracts/hiveArchitecture` and `hiveMap`, and enforced by
`tests/hiveArchitecture.test.ts`. An architecture that lives only in a document
drifts the first time somebody is in a hurry.

## Consequences

**Positive**

- Prime's complexity is bounded by the number of Cores, not the number of engines
- Domain ownership is explicit and singular
- Engines stay portable and independently replaceable
- A second industry composes existing capabilities instead of forking them
- Failure isolates at a domain boundary
- Testing Prime does not require the whole engine graph

**Costs, accepted**

- A routing layer that does not exist yet and must be built
- Core contracts have to be designed carefully; a bad Core boundary is expensive
  to move later
- Cross-domain ownership needs governing, or capabilities drift between Cores
- Event topology needs discipline
- **Cores can themselves become monoliths.** This is the most likely way the
  decision fails, and the Constitution addresses it directly: a Core coordinates
  its specialists and must not absorb them

**Explicitly not done now**

No Core coordinator packages have been created. Creating eight empty packages to
match a diagram would be the exact mistake §35 warns about — the seams are
defined and the mapping is recorded; implementation follows demand.

## Alternatives considered

**Keep the flat model.** Simplest today, and the whole reason for this ADR:
it degrades continuously rather than failing visibly, so there is never an
obvious moment to fix it.

**Fewer, broader Cores (three or four).** Less routing, but each Core becomes
large enough to be a monolith — trading a Prime nobody can change for a Finance
Core nobody can change.

**More, narrower Cores (fifteen-plus).** Closer to one Core per engine, which is
the flat model wearing a hat.

**A service mesh / microservice per capability.** Rejected: these are libraries,
not services. Making them services would put an HTTP server and a deployment
inside packages whose entire value is having neither.

## Naming conflict, resolved

`EngineManifest.hivePlacement` already used `"core"` to mean *the centre of the
visual hive* — Prime's position on the dashboard. The new architecture uses
"Core" for the eight domain coordinators.

Same word, two meanings, in one manifest. Rather than rename a working field for
aesthetics — which §35 forbids — the domain taxonomy is a separate field in a
separate package, and `hivePlacement` keeps its visual meaning. Documented here
so the collision is a known one rather than a trap.
