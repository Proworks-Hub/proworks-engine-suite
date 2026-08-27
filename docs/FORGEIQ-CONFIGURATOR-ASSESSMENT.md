# ForgeIQ no-code configurator — implementation assessment

Owner: Steven Kreutzer · 2026-08-27
Per §36: inspect first, assess, then implement the foundation.

---

## Headline: Phase 1 was ~80% built

ForgeIQ is 52 files. Most of the directive's Phase 1 domain foundation already exists under
different names, and per §36 it was kept rather than renamed.

| Directive concept | What exists | Verdict |
|---|---|---|
| `ProductTemplate` | `core/schemas/productDefinition.ts` | **Have it** |
| `CustomizationSurface` | `surfaces[]` — `safeAreaIn`, `editable`, `allowedElementTypes`, per-preset `surfaceOverrides` | **Have it** |
| `ConfiguratorField` | `optionGroups[]` with values, `priceModifier`, `defaultValueId`, `required` | **Have it** |
| Visual layer model | `core/schemas/configuration.ts` — surfaces → elements, text/image union, inches from top-left | **Have it** |
| Validation | `validationEngine` + 8 rules (bounds, min text height, image DPI, islands, machine/material compat, work area) | **Have it** |
| ManufacturingPlan integration | `manufacturing/buildManufacturingPlan.ts` | **Have it** |
| Pricing hooks | `core/pricing/` with internal-cost split | **Have it** |
| BOM, nesting, cutline export | `core/production/`, `core/export/` | **Have it** |
| AI-assisted authoring | `core/ai/` with a provider abstraction and a mock | **Seam exists** |
| **`ConfiguratorRule`** | — | **Was missing** |
| **Formula / calculated values** | — | **Was missing** |
| Versioning | Comment says version lives in DB columns, not the schema | **Partial** |
| Perspective / four-corner mapping | — | Missing (Phase 4) |

## The finding that decided what to build

`optionGroups` already carries `visibleWhen`, with this comment:

> *"Conditional visibility — parsed and stored now, enforced by the UI in a later phase."*

**Enforcing it in the UI is the thing to avoid.** A rule that lives only in a React component is a
rule the API does not apply — so a configuration posted directly bypasses it — and every host that
renders the configurator has to reimplement it identically. §19 says the opposite: complexity belongs
inside the engine, and the customer sees a simple surface.

So the smallest safe sequence was the two missing deterministic pieces, with `visibleWhen` given an
implementation rather than a promise.

---

## What was built

### Formula engine — `core/formula/expression.ts`, 24 tests

A tokenizer and recursive-descent parser over a closed grammar. **No `eval`, no `new Function`.**

A merchant's formula is untrusted input that runs on a server for every customer, so most of the
tests are about what it *cannot* do: no property access (the grammar has no `.`, so no path to a
prototype or global), no assignment, no function definition, no sequencing, and only the arithmetic
helpers in a fixed table are callable. `require`, `process`, `constructor` and `eval` are all just
unknown identifiers.

It is also bounded — a length limit and a parse-depth limit — because *deterministic* is not the same
as *terminates*, and a merchant who pastes a thousand nested parens should get an error, not a stack
overflow in a request handler.

Three deliberate refusals, each because the alternative fails silently:

- **An unknown name is an error, not zero.** A misspelled variable quietly becoming `0` turns
  `width * 0.04` into a border of nothing, and the sign ships wrong.
- **Division by zero is an error, not `Infinity`.** Infinity propagates into a dimension and produces
  a product nobody can make.
- **`+` is arithmetic only.** Implicit concatenation is how `width + margin` becomes `"362"`.

`validateFormula` names the misspelled variable at build time, so a merchant learns while typing
rather than a customer learning at checkout.

### Rule engine — `core/rules/ruleEngine.ts`, 18 tests

Conditions are formulas; effects are a **closed set of named operations** — hide, show, require,
optional, setValue, excludeValue, warn, block. A merchant cannot express "run this function" because
there is no function to run, and the schema is `.strict()` so an unknown effect is refused.

**Evaluation runs to a fixpoint.** One rule's effect can satisfy another's condition — a large size
forces heavy mounting, which reveals a bracket option. A single pass applies the first and misses the
second, and *which rules fired would depend on the order the merchant added them*. There is a test
that runs the same rules in both orders and asserts the same answer.

Rules that never settle are reported as `unstable` rather than looping — the outcome still comes
back, but a caller must not publish a configurator that reports it.

A condition that cannot be evaluated — usually a field the customer has not filled in — does not
fire. Blocking the whole configurator because one optional field is empty makes a half-filled form
unusable.

`findRuleConflicts` catches two rules assigning different values to one target, and a field both
hidden and required (the customer asked for something they cannot see). It is **syntactic and says
so**: proving two arbitrary conditions can hold together is undecidable, so it reports candidates for
a human rather than claiming certainty.

Every effect carries an explanation with the condition that caused it, for §31 — an unexplained
automatic change is indistinguishable from a bug and gets reported as one.

### Backward compatibility

`ruleFromVisibleWhen` converts the existing shape into a rule, so definitions already storing it keep
working and finally *do* something. Semantics are the obvious reading: every clause must hold, any
listed value within a clause satisfies it.

---

## Boundary check (§37)

Nothing added here touches VisionIQ's territory. Formulas and rules answer *what the customer wants*;
they say nothing about machines, materials, recipes or file preparation. `ManufacturingPlan` remains
the handoff.

---

## What is deliberately not built

- **Perspective / four-corner mapping** (§6) — Phase 4, and it wants the visual editor beside it.
- **Process-effect rendering** (§7) — Phase 4, and it overlaps VisionIQ's proof rendering; the
  boundary in §23 needs settling before either is built.
- **AI configurator authoring** (§13, §14) — the `core/ai/` seam exists; the deterministic foundation
  had to be trustworthy first, which §35 says explicitly.
- **Combination testing** (§18) — Phase 5. `findRuleConflicts` is the first piece.
- **Schema-level versioning** — currently a database column. Worth moving onto the definition so a
  published configurator is reproducible from the document alone, but it is a migration, not an
  addition.

## Result

**1,068 tests, typecheck clean.** No existing ForgeIQ functionality was replaced or renamed.
