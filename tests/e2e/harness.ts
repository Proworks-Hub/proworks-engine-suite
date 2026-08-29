// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createInMemoryReservationStore,
  createInMemoryStockLedger,
  createConsumeMaterialUseCase,
  createReleaseReservationUseCase,
  createReserveMaterialUseCase,
  type InMemoryStockLedger,
  type StockPosition,
  type StockPositionInput,
} from "@proworks-hub/inventoryiq";

// ─────────────────────────────────────────────────────────────────────────────
// The E2E harness.
//
// The scenario pack's instruction: "Family runners read JSON. Do not write 2048
// test files." So this loads the corpus and the four family runners iterate it.
//
// HOW A ROW IS RUN
//
//   seed `startingState` → apply `faultInjection` → assert `mustPass`
//   → assert `mustFail` did NOT happen → only `allowedRepairActions`
//
// AND THE PART THAT MATTERS MOST: A SKIP IS NOT A PASS
//
// E2E-01..12 are a gate and cannot be skipped. 13..48 may skip only when a
// named API is absent, with a one-line reason. Every skip is reported by
// scenarioId with its reason, and the report distinguishes three outcomes
// rather than two — a suite that reports 48/48 green while half of it never
// executed is worse than one that reports 20 passes and 28 honest skips.
//
// The `mustFail` list is the interesting half of each row. It does not describe
// a test that should fail; it describes something the ENGINE must never do. A
// row where `mustPass` holds and a `mustFail` condition also occurred is an
// engine defect, and it is reported as one.
// ─────────────────────────────────────────────────────────────────────────────

export interface E2EScenario {
  readonly scenarioId: string;
  readonly family: string;
  readonly title: string;
  readonly targetComponents: readonly string[];
  readonly startingState: string;
  readonly faultClass: string;
  readonly faultInjection: string;
  readonly expectedDetection: string;
  readonly expectedDiagnosis: string;
  readonly expectedContainment: string;
  readonly expectedRecovery: string;
  readonly mustPass: readonly string[];
  readonly mustFail: readonly string[];
  readonly violatedInvariants: readonly string[];
  readonly requiredEvidence: readonly string[];
  readonly repairClass: string;
  readonly allowedRepairActions: readonly string[];
  readonly forbiddenRepairActions: readonly string[];
  readonly severity: string;
  readonly blastRadius: string;
  readonly reversibility: string;
  readonly tenantAndDataClass?: unknown;
  readonly generalizationCandidate?: unknown;
}

const corpus = (name: string): unknown[] =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./corpus/${name}`, import.meta.url)), "utf8")) as unknown[];

export const E2E_SCENARIOS = corpus("e2e-48.json") as E2EScenario[];
export const PACK1 = () => corpus("pack1-sim-0001-1000.json") as E2EScenario[];
export const PACK2 = () => corpus("pack2-sim-1001-2000.json") as E2EScenario[];

/** E2E-01..12. The gate. */
export const GATE_IDS: readonly string[] = Object.freeze(
  Array.from({ length: 12 }, (_, i) => `E2E-${String(i + 1).padStart(2, "0")}`),
);

export function scenariosInRange(from: number, to: number): E2EScenario[] {
  return E2E_SCENARIOS.filter((s) => {
    const n = Number(s.scenarioId.replace("E2E-", ""));
    return n >= from && n <= to;
  });
}

export function scenario(id: string): E2EScenario {
  const found = E2E_SCENARIOS.find((s) => s.scenarioId === id);
  if (!found) throw new Error(`No scenario ${id} in the corpus.`);
  return found;
}

// ── Outcome recording ────────────────────────────────────────────────────────

export type Outcome = "pass" | "fail" | "skip" | "engine-defect";

export interface ScenarioOutcome {
  readonly scenarioId: string;
  readonly family: string;
  readonly outcome: Outcome;
  /** Required on skip and on failure. */
  readonly reason: string;
  readonly mustPassChecked: number;
  readonly mustFailChecked: number;
}

const outcomes: ScenarioOutcome[] = [];

export function record(outcome: ScenarioOutcome): void {
  outcomes.push(outcome);
}

export function allOutcomes(): readonly ScenarioOutcome[] {
  return [...outcomes];
}

/**
 * Marks a scenario skipped.
 *
 * Refuses to skip a gate scenario. The pack says E2E-01..12 cannot be skipped,
 * and a helper that quietly allowed it would make that rule advisory.
 */
export function skip(s: E2EScenario, reason: string): void {
  if (GATE_IDS.includes(s.scenarioId)) {
    throw new Error(
      `${s.scenarioId} is a GATE scenario and cannot be skipped. Reason offered: ${reason}`,
    );
  }
  record({
    scenarioId: s.scenarioId,
    family: s.family,
    outcome: "skip",
    reason,
    mustPassChecked: 0,
    mustFailChecked: 0,
  });
}

// ── The shop fixture ─────────────────────────────────────────────────────────

const KSIX = "ksix";
const OTHER = "other-shop";
const LOCATION = "main-rack";
const MATERIAL = "corten-18";

export interface ShopFixture {
  readonly ledger: InMemoryStockLedger;
  readonly reserve: ReturnType<typeof createReserveMaterialUseCase>;
  readonly release: ReturnType<typeof createReleaseReservationUseCase>;
  readonly consume: ReturnType<typeof createConsumeMaterialUseCase>;
  readonly reservations: ReturnType<typeof createInMemoryReservationStore>;
  /** Reads a position without going through a use case. */
  position(organizationId?: string): Promise<StockPosition | undefined>;
  readonly ids: { tenant: string; otherTenant: string; material: string; location: string };
}

/**
 * Seeds `startingState`.
 *
 * One fixture rather than one per scenario: the rows describe a single shop
 * with stock in it, and building a different world per row would test the
 * fixtures rather than the engines.
 */
export function seedShop(options: { onHand?: number; seedOtherTenant?: boolean } = {}): ShopFixture {
  const onHand = options.onHand ?? 20;
  const now = () => new Date("2026-08-29T10:00:00.000Z");

  const positions: StockPositionInput[] = [
    {
      materialId: MATERIAL,
      organizationId: KSIX,
      locationId: LOCATION,
      onHand: { amount: onHand, unit: "each" },
      reserved: { amount: 0, unit: "each" },
      updatedAt: "2026-08-29T09:00:00.000Z",
    },
  ];

  if (options.seedOtherTenant) {
    positions.push({
      materialId: MATERIAL,
      organizationId: OTHER,
      locationId: LOCATION,
      onHand: { amount: 5, unit: "each" },
      reserved: { amount: 0, unit: "each" },
      updatedAt: "2026-08-29T09:00:00.000Z",
    });
  }

  const ledger = createInMemoryStockLedger(positions);
  const reservations = createInMemoryReservationStore();
  let counter = 0;
  const deps = { stock: ledger, reservations, now, generateId: () => `rsv_${(counter += 1)}` };

  return {
    ledger,
    reservations,
    reserve: createReserveMaterialUseCase(deps),
    release: createReleaseReservationUseCase(deps),
    consume: createConsumeMaterialUseCase(deps),
    async position(organizationId = KSIX) {
      return ledger.all().find((p) => p.organizationId === organizationId && p.materialId === MATERIAL);
    },
    ids: { tenant: KSIX, otherTenant: OTHER, material: MATERIAL, location: LOCATION },
  };
}

// ── mustFail checking ────────────────────────────────────────────────────────

/**
 * Asserts a `mustFail` condition did not occur.
 *
 * Separate from an ordinary assertion because the failure means something
 * different: a `mustPass` that does not hold is a scenario finding, and a
 * `mustFail` that DID happen is an engine defect. The pack is explicit — "If it
 * did, the engine failed" — and collapsing the two would lose which one a
 * reader is looking at.
 */
export function assertMustFailDidNotHappen(
  s: E2EScenario,
  condition: string,
  happened: boolean,
): void {
  if (happened) {
    record({
      scenarioId: s.scenarioId,
      family: s.family,
      outcome: "engine-defect",
      reason: `mustFail condition occurred: ${condition}`,
      mustPassChecked: 0,
      mustFailChecked: 1,
    });
    throw new Error(
      `ENGINE DEFECT in ${s.scenarioId}: the condition "${condition}" is listed under mustFail and it happened.`,
    );
  }
}

/** Records a scenario that passed, with what was actually checked. */
export function pass(s: E2EScenario, mustPassChecked: number, mustFailChecked: number): void {
  record({
    scenarioId: s.scenarioId,
    family: s.family,
    outcome: "pass",
    reason: "",
    mustPassChecked,
    mustFailChecked,
  });
}

/**
 * Prints the outcomes recorded IN THIS FILE.
 *
 * Per-file rather than consolidated, because vitest gives each test file its
 * own module registry — a shared `outcomes` array is not shared, and a
 * consolidated reporter reading it printed zero while every runner had recorded
 * its results correctly. Reporting where the data actually lives is the honest
 * fix; the alternative was a sidecar file, which trades a wrong number for a
 * stale one.
 */
export function printReport(title: string): void {
  const rows = allOutcomes();
  if (rows.length === 0) return;

  const by = (o: Outcome) => rows.filter((r) => r.outcome === o);
  const lines: string[] = [
    "",
    "─".repeat(78),
    `  ${title}`,
    "─".repeat(78),
    `  pass ${by("pass").length}   skip ${by("skip").length}   fail ${by("fail").length}   engine-defect ${by("engine-defect").length}`,
    "",
  ];

  for (const row of rows) {
    const mark =
      row.outcome === "pass" ? "PASS" : row.outcome === "skip" ? "SKIP" : row.outcome.toUpperCase();
    const detail =
      row.outcome === "pass"
        ? `${row.mustPassChecked} mustPass, ${row.mustFailChecked} mustFail checked`
        : row.reason;
    lines.push(`  ${mark.padEnd(13)} ${row.scenarioId.padEnd(9)} ${row.family.padEnd(13)} ${detail}`);
  }
  lines.push("─".repeat(78));
  // eslint-disable-next-line no-console
  console.log(lines.join(String.fromCharCode(10)));
}
