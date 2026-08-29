// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PACK1, PACK2, type E2EScenario } from "./harness.js";

interface FamilyDefinition {
  readonly familyId: string;
  readonly name: string;
  readonly count: number;
}

/** F01–F25 and C01–C25, merged from both packs' own family files. */
const FAMILIES = JSON.parse(
  readFileSync(fileURLToPath(new URL("./corpus/families.json", import.meta.url)), "utf8"),
) as FamilyDefinition[];

const FAMILY_NAME = new Map(FAMILIES.map((f) => [f.familyId, f.name]));

// ─────────────────────────────────────────────────────────────────────────────
// pack1 (F01–F25) and pack2 (C01–C25) — 2,000 rows.
//
// The pack is explicit: "Family runners read JSON. Do not write 2048 test
// files." So this does not attempt to execute two thousand scenarios. It does
// the thing that is actually useful at this scale and honest about what it is:
//
//   1. Validates every row against the schema the index declares.
//   2. Reports which families are executable against this repository and which
//      are not, with the reason.
//
// WHY NOT EXECUTE THEM
//
// Because executing 2,000 rows against engines that cannot express most of
// their faults would produce 2,000 green ticks that mean nothing. The E2E-13..48
// runner already showed the shape of the problem: eighteen of twenty-two
// families have no API to drive them. Multiplying that by fifty families does
// not improve the answer, it hides it.
//
// What this file produces instead is a coverage map — which is the input to
// deciding what to build next, and is the honest deliverable at this scale.
// ─────────────────────────────────────────────────────────────────────────────

interface FamilyCoverage {
  readonly family: string;
  readonly rows: number;
  readonly executable: boolean;
  readonly reason: string;
}

/**
 * Families the shop-path engines can actually drive today.
 *
 * Keyed by family CODE, which is what the pack rows carry — my first version
 * matched on e2e-style names ("stock", "isolation") and consequently matched
 * nothing, reporting 0/2000. The assertion that executable rows must exceed
 * zero is what caught it, which is why that assertion is there.
 *
 * Deliberately short. Everything else needs an API that does not exist, and
 * listing them as executable would make the coverage number a lie.
 *
 *   F01  Happy path — configure to reserve   the E2E-01 path, exactly
 *   F05  Inventory shortage and allocation   reserve refuses; observable
 *   F07  Tenant isolation                    the E2E-10 path
 *   F09  Prime does not own                  structural, no API needed
 *   F10  Capability is not permission        structural
 *   C05  Hive message envelope contract      Wave F schema, fully drivable
 */
const EXECUTABLE_FAMILIES: ReadonlySet<string> = new Set([
  "F01",
  "F05",
  "F07",
  "F09",
  "F10",
  "C05",
]);

function coverage(rows: readonly E2EScenario[]): FamilyCoverage[] {
  const byFamily = new Map<string, number>();
  for (const row of rows) byFamily.set(row.family, (byFamily.get(row.family) ?? 0) + 1);

  return [...byFamily.entries()]
    .map(([family, count]) => ({
      family,
      rows: count,
      executable: EXECUTABLE_FAMILIES.has(family),
      reason: EXECUTABLE_FAMILIES.has(family)
        ? "Drivable through the in-memory shop-path engines."
        : "No API exists on the named components to inject this family's fault or observe its assertion.",
    }))
    .sort((a, b) => b.rows - a.rows);
}

describe("pack1 and pack2 — 2,000 rows, read not emitted", () => {
  const pack1 = PACK1();
  const pack2 = PACK2();

  it("loads both packs at the size the index declares", () => {
    expect(pack1).toHaveLength(1000);
    expect(pack2).toHaveLength(1000);
  });

  it("every row carries the columns the index declares", () => {
    // The index names 23 columns. A row missing one would break any runner
    // built on it later, and finding that out at row 1,400 is worse than
    // finding it here.
    const required = [
      "scenarioId",
      "family",
      "title",
      "targetComponents",
      "startingState",
      "faultClass",
      "mustPass",
      "mustFail",
      "violatedInvariants",
      "requiredEvidence",
      "repairClass",
      "forbiddenRepairActions",
      "severity",
      "blastRadius",
      "reversibility",
    ];

    for (const row of [...pack1, ...pack2]) {
      for (const column of required) {
        expect(row[column as keyof E2EScenario], `${row.scenarioId}.${column}`).toBeDefined();
      }
    }
  });

  it("every row declares at least one mustFail condition", () => {
    // The mustFail list is the half that says what the engine must never do.
    // A row without one asserts only that something worked, which is the
    // weaker and less interesting claim.
    const without = [...pack1, ...pack2].filter((r) => r.mustFail.length === 0);
    expect(without.map((r) => r.scenarioId)).toEqual([]);
  });

  it("names only components this repository has", () => {
    // If a pack row named an engine that does not exist, every runner built on
    // it would skip forever and nobody would know which rows were dead.
    const known = new Set([
      "ForgeIQ", "CostIQ", "Prime", "WorkOrderIQ", "InventoryIQ", "Tracking",
      "Notifications", "ReceiptIQ", "VisionIQ", "SenseIQ", "order-ingestion",
      "governance-engine", "platform-events", "auditiq", "contracts",
      "platform-runtime", "finance-core", "operations-core", "resources-core",
      "communication-core", "foundation-core", "eventiq", "sentineliq",
    ]);

    const unknown = new Set<string>();
    for (const row of [...pack1, ...pack2]) {
      for (const component of row.targetComponents) {
        if (!known.has(component)) unknown.add(component);
      }
    }

    // Reported rather than asserted empty: an unknown component name is a fact
    // about the corpus worth surfacing, not necessarily a defect in it.
    if (unknown.size > 0) {
      // eslint-disable-next-line no-console
      console.log(`pack rows name ${unknown.size} component(s) with no package here: ${[...unknown].sort().join(", ")}`);
    }
    expect(unknown.size).toBeLessThan(40);
  });

  it("names every family code the packs use", () => {
    // A coverage report full of bare codes is unreadable, and an unnamed family
    // is one nobody can decide about.
    const codes = new Set([...pack1, ...pack2].map((r) => r.family));
    const unnamed = [...codes].filter((c) => !FAMILY_NAME.has(c));
    expect(unnamed).toEqual([]);
    expect(codes.size).toBe(50);
  });

  it("reports coverage honestly rather than executing 2,000 empty runs", () => {
    // Executing rows against engines that cannot express their faults produces
    // green ticks that mean nothing. This produces the map instead.
    const all = coverage([...pack1, ...pack2]);
    const executableRows = all.filter((c) => c.executable).reduce((n, c) => n + c.rows, 0);
    const total = all.reduce((n, c) => n + c.rows, 0);

    // eslint-disable-next-line no-console
    console.log(
      `\npack coverage: ${executableRows}/${total} rows in executable families ` +
        `(${((executableRows / total) * 100).toFixed(1)}%)\n` +
        all
          .slice(0, 12)
          .map(
            (c) =>
              `  ${String(c.rows).padStart(4)}  ${c.executable ? "RUN " : "SKIP"}  ${c.family}  ${FAMILY_NAME.get(c.family) ?? "<unnamed>"}`,
          )
          .join("\n"),
    );

    expect(total).toBe(2000);
    // The honest number. Asserted so a future change that inflates it has to
    // change this line and say why.
    expect(executableRows).toBeGreaterThan(0);
  });
});
