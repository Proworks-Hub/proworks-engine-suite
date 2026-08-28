# The Hive Engine Constitution

Copyright © 2026 Steven Kreutzer. All rights reserved.
Owner: Steven Kreutzer · Ratified 2026-08-28

Binding on every existing and future engine. Where this document and any other
disagree, this one governs. Amending it is a deliberate act with a decision
record, not a side effect of a pull request.

The machine-readable half lives in `@proworks-hub/contracts/hiveArchitecture`
and is enforced by `tests/hiveArchitecture.test.ts` — because a constitution
nothing checks is a document, and documents drift.

---

## The shape

```
External application
        ↓
      PRIME                  knows which domain should answer
        ↓
  CORE ENGINES               know which specialist in their domain answers
        ↓
SPECIALIZED ENGINES          know how to do the work
        ↓
  INDUSTRY LAYER             knows what that work means in this industry
```

**Prime knows who should do the work. The Core knows which specialist in its
domain should do it. The specialized engine knows how. The industry layer knows
what it means.**

Prime orchestrates; it is not a data path. Cross-engine work may travel by event
under Prime's coordination without every byte passing through it. Making Prime a
proxy for all traffic would turn the coordinator into the bottleneck and the
single point of failure.

---

## The fourteen rules

**1 — Single domain ownership.** Every engine owns one clearly defined
responsibility. If something genuinely belongs to two domains, it is two
capabilities, not one shared one. Shared ownership is how a capability gets
implemented twice, with the copies disagreeing and nobody able to say which is
authoritative.

**2 — Prime orchestrates.** Prime establishes context, decides which domain
answers, and coordinates across Cores. It executes no domain logic and holds no
domain data. *Enforced:* Prime's package may not depend on any specialized or
industry engine.

**3 — Cores coordinate.** A Core routes within its domain and returns a
normalized answer. Prime talks to eight domains, not eighty implementations.

**4 — Specialists own their logic.** CostIQ owns costing. ForgeIQ owns
manufacturability. ReceiptIQ owns receipt intelligence. A Core coordinates its
specialists; it does not absorb them.

**5 — Engines are portable.** No engine may depend on ProWorks Hub, KSix
Designs, MakerOps, Family Table, or any other host. Hosts consume engines; they
do not own them. *Enforced.*

**6 — Interfaces are versioned.** Contracts evolve without uncontrolled breaking
changes. A higher manifest version drops unknown fields and reports them; an
unknown field at the *current* version is rejected, because it is a typo.

**7 — Event-driven by default.** Cross-engine communication uses commands,
queries, events and responses. Not imports, and not shared tables.

**8 — No cross-engine database ownership.** One engine may not read or write
another's private storage. Domain data crosses through explicit contracts.

**9 — Tenant data belongs to the tenant.** The Hive must never require a
business to surrender ownership of its private data in order to receive
intelligence.

**10 — Learning respects privacy.** Local learning stays local. Generalized
learning may only be produced through a deliberate, lossy boundary with stated
minimums for sample size and distinct contributors. **De-identification is not
achieved by removing a name**, and this project does not claim
privacy-preserving generalized learning is solved — the boundary types exist;
the practice is unproven.

**11 — Explainability.** Intelligence carries provenance, confidence, evidence
and version. A recommendation nobody can interrogate is a rumour with a
progress bar.

**12 — Failure isolation.** One failed specialist must not collapse the Hive.
Timeouts, retries, circuit breaking, degraded operation, partial responses and
explicit error contracts are required, not optional. *Enforced:* no engine may
depend on the control plane, so the console being down cannot stop production.

**13 — Replaceability.** Any specialist should be replaceable by another
implementation honouring the same contract.

**14 — Observability.** Every engine exposes health, version, status,
dependencies, latency, errors and events. **Unknown is a state, and it is not
the same as healthy.**

---

## Dependency law

Dependencies run **downward only**. Nothing depends upward.

| Tier | May depend on |
|---|---|
| Prime | Core, platform |
| Core | its specialists, platform |
| Specialized | platform only |
| Industry | Core, specialized, platform |
| Platform | nothing |

Two consequences worth stating plainly, because both compile perfectly well:

- **A specialist that imports its Core** can never be reused under a different
  one. The Core is a coordinator, not a parent class.
- **A specialist that imports another specialist** welds two domains together
  where a contract should have been. This holds *even within one Core* — the
  shared domain is not a licence to couple.

---

## The Core layer stays small

Eight Cores. Specialized engines may grow without limit; industry packs may grow
without limit; **this list should barely move.** Every addition costs Prime a
domain it must understand, and the value of the layer comes entirely from that
number staying small.

Before proposing a ninth, all five must be strongly true:

1. Is this responsibility universal across most industries?
2. Is it substantially different from every existing Core?
3. Would adding it reduce architectural complexity rather than increase it?
4. Will there be several specialized engines beneath it?
5. Will the concept still be valid in ten years?

Anything less belongs as a specialist beneath an existing Core.

---

## Honesty about what exists

Every component in the engine map carries a status: `existing`, `partial`,
`planned`, or `conceptual`. A `partial` component **must** state its gap — the
schema refuses one that does not.

This is the rule most easily eroded and the most costly to lose. An architecture
diagram where the built and the imagined look alike is a diagram that makes the
system appear finished, and the first person to rely on it builds against
nothing.

The same applies to running systems: no fabricated telemetry, no invented
confidence, no estimated impact presented as measured. **Unknown is better than
falsely healthy.**

---

## What this forbids

- Domain logic accumulating in Prime
- Cores becoming monoliths that absorb their specialists
- An engine depending on a host application
- Cross-engine direct database access
- Duplicating costing, workflow, identity or security per industry
- Creating an engine package because a name appeared in a diagram
- Claiming generalized privacy-preserving learning works before it does
- Breaking a host-facing API to make the hierarchy look tidier
