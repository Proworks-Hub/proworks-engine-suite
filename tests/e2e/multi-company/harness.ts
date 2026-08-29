// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createConsumeMaterialUseCase,
  createInMemoryReservationStore,
  createInMemoryStockLedger,
  createReleaseReservationUseCase,
  createReserveMaterialUseCase,
  type StockPosition,
  type StockPositionInput,
} from "@proworks-hub/inventoryiq";
import {
  createCreateWorkOrderUseCase,
  createInMemoryEventLog,
  createInMemoryIdempotencyStore,
  type EventActor,
  type IntakeInput,
} from "@proworks-hub/workorderiq";

// ─────────────────────────────────────────────────────────────────────────────
// The multi-company harness: five tenants alive in one process.
//
// "This is isolation under simultaneous companies — the OS-shape test."
//
// WHY FIVE SEPARATE HOSTS AND ONE ENGINE SET
//
// The prompt asks for "isolated stores keyed by tenantId", and the distinction
// it is testing is the one that matters for a multi-tenant kernel: the ENGINES
// are shared and the STATE is not. Constructing five copies of InventoryIQ
// would prove nothing — of course two separate programs do not leak into each
// other. Sharing one engine set over partitioned stores is the arrangement a
// real host runs, and therefore the arrangement whose leaks are worth finding.
//
// So: one `createReserveMaterialUseCase` per tenant over ITS OWN ledger, which
// is how a host binds per-tenant storage; and the shared ledger variant for the
// scenarios that ask whether one ledger holding five tenants keeps them apart.
// Both are here because they fail differently, and MC-17 is specifically about
// the second.
//
// A HOST IS NOT AN ENGINE
//
// `Company` below is a host: a name, a SKU vocabulary, a product. It holds no
// stock of its own and owns no source of truth — MC-17 and MC-23 both turn on
// that, and the type has no field that could hold one.
// ─────────────────────────────────────────────────────────────────────────────

export interface Company {
  readonly id: string;
  readonly host: string;
  readonly sku: string;
  readonly product: string;
}

export interface MultiCompanyScenario {
  readonly scenarioId: string;
  readonly family: string;
  readonly title: string;
  readonly targetComponents: readonly string[];
  readonly startingState: string;
  readonly faultClass: string;
  readonly faultInjection: string;
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
}

const corpus = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./corpus/${name}`, import.meta.url)), "utf8"));

export const COMPANIES = corpus("companies.json") as Company[];
export const SCENARIOS = corpus("scenarios.json") as MultiCompanyScenario[];

export function scenario(id: string): MultiCompanyScenario {
  const found = SCENARIOS.find((s) => s.scenarioId === id);
  if (!found) throw new Error(`No scenario ${id}.`);
  return found;
}

export const LOCATION = "main-rack";
export const ACTOR: EventActor = { kind: "system", source: "multi-company-harness" };

/** One company's slice of the world. Engines shared, state its own. */
export interface Tenant {
  readonly company: Company;
  readonly reserve: ReturnType<typeof createReserveMaterialUseCase>;
  readonly release: ReturnType<typeof createReleaseReservationUseCase>;
  readonly consume: ReturnType<typeof createConsumeMaterialUseCase>;
  readonly createWorkOrder: ReturnType<typeof createCreateWorkOrderUseCase>;
  readonly eventLog: ReturnType<typeof createInMemoryEventLog>;
  position(): StockPosition | undefined;
  /** Every position this tenant's ledger holds, whoever it belongs to. */
  visiblePositions(): StockPositionInput[];
}

export interface MultiCompanyWorld {
  readonly tenants: ReadonlyMap<string, Tenant>;
  tenant(id: string): Tenant;
  /** The one shared ledger, when the world was built with `sharedLedger`. */
  readonly sharedLedger: ReturnType<typeof createInMemoryStockLedger> | null;
  /** Every position across every tenant. For cross-tenant assertions. */
  allPositions(): StockPositionInput[];
}

/**
 * Stock per tenant, and the asymmetry is deliberate.
 *
 * ksix holds fifty sheets and brighton-signs holds three, of a SKU string they
 * share exactly. That gap is the instrument: if the ledger keyed stock by SKU
 * rather than by (tenant, SKU), brighton's three would be indistinguishable
 * from part of ksix's fifty, and a leak would look like plenty of stock rather
 * than like an error.
 *
 * Equal seeds would hide it. Two tenants each holding ten look the same whether
 * they are partitioned or pooled at twenty.
 */
export const SEED: Readonly<Record<string, number>> = Object.freeze({
  ksix: 50,
  "brighton-signs": 3,
  "longmont-print": 25,
  "family-table": 0,
  "makerops-demo": 12,
});

export interface WorldOptions {
  /** Overrides the per-company seed. Rarely wanted — the asymmetry is the test. */
  onHand?: number;
  /**
   * Put every tenant on ONE ledger instead of one each.
   *
   * The harder arrangement, and the one MC-17 asks about: a single stock owner
   * with tenant partitions inside it, rather than five stores that cannot
   * possibly leak because they are separate objects.
   */
  sharedLedger?: boolean;
}

const positionFor = (company: Company, onHand: number): StockPositionInput => ({
  materialId: company.sku,
  organizationId: company.id,
  locationId: LOCATION,
  onHand: { amount: onHand, unit: "each" },
  reserved: { amount: 0, unit: "each" },
  updatedAt: "2026-08-29T09:00:00.000Z",
});

export function buildWorld(options: WorldOptions = {}): MultiCompanyWorld {
  const seedFor = (company: Company): number => options.onHand ?? SEED[company.id] ?? 10;
  const now = () => new Date("2026-08-29T10:00:00.000Z");

  const shared = options.sharedLedger
    ? createInMemoryStockLedger(COMPANIES.map((c) => positionFor(c, seedFor(c))))
    : null;

  const tenants = new Map<string, Tenant>();
  let rsvCounter = 0;
  let woCounter = 0;

  for (const company of COMPANIES) {
    // One ledger each, unless the world is shared. Note that even the
    // per-tenant ledger is seeded with ONLY that tenant's position — a store
    // that held another tenant's row would make the isolation assertions
    // vacuous.
    const ledger = shared ?? createInMemoryStockLedger([positionFor(company, seedFor(company))]);
    const reservations = createInMemoryReservationStore();
    const eventLog = createInMemoryEventLog();

    const inventoryDeps = {
      stock: ledger,
      reservations,
      now,
      generateId: () => `rsv_${company.id}_${(rsvCounter += 1)}`,
    };

    tenants.set(company.id, {
      company,
      reserve: createReserveMaterialUseCase(inventoryDeps),
      release: createReleaseReservationUseCase(inventoryDeps),
      consume: createConsumeMaterialUseCase(inventoryDeps),
      createWorkOrder: createCreateWorkOrderUseCase({
        eventLog,
        workOrderIdGenerator: () => `wo_${company.id}_${(woCounter += 1)}`,
        clock: now,
        idempotencyStore: createInMemoryIdempotencyStore(),
      }),
      eventLog,
      position: () =>
        ledger.all().find((p) => p.organizationId === company.id && p.materialId === company.sku),
      visiblePositions: () => ledger.all(),
    });
  }

  return {
    tenants,
    tenant(id) {
      const t = tenants.get(id);
      if (!t) throw new Error(`No tenant ${id}.`);
      return t;
    },
    sharedLedger: shared,
    allPositions: () =>
      shared
        ? shared.all()
        : [...tenants.values()].flatMap((t) => t.visiblePositions()),
  };
}

/** A shop job: create a work order, reserve its BOM. */
export async function runJob(
  tenant: Tenant,
  options: { quantity?: number; idempotencyKey?: string; label?: string } = {},
): Promise<{ workOrderId: string | null; reservationId: string | null }> {
  const quantity = options.quantity ?? 2;

  const input: IntakeInput = {
    customerId: `cus_${tenant.company.id}`,
    customerName: tenant.company.host,
    source: "manual",
    lineItems: [{ id: "li_1", label: options.label ?? tenant.company.product, quantity: 1 }],
  };

  const created = await tenant.createWorkOrder.execute(
    input,
    ACTOR,
    options.idempotencyKey
      ? { organizationId: tenant.company.id, key: options.idempotencyKey }
      : undefined,
  );
  if (!created.ok) return { workOrderId: null, reservationId: null };

  const reserved = await tenant.reserve.execute({
    organizationId: tenant.company.id,
    materialId: tenant.company.sku,
    locationId: LOCATION,
    workOrderId: created.draft.workOrderId,
    quantity: { amount: quantity, unit: "each" },
  });

  return {
    workOrderId: created.draft.workOrderId,
    reservationId: reserved.ok ? reserved.data.reservationId : null,
  };
}

// ── Outcome recording, same discipline as the E2E suite ──────────────────────

export type Outcome = "pass" | "skip" | "engine-defect";

export interface McOutcome {
  readonly scenarioId: string;
  readonly family: string;
  readonly outcome: Outcome;
  readonly reason: string;
}

const outcomes: McOutcome[] = [];

export function pass(s: MultiCompanyScenario, note = ""): void {
  outcomes.push({ scenarioId: s.scenarioId, family: s.family, outcome: "pass", reason: note });
}

export function skip(s: MultiCompanyScenario, reason: string): void {
  outcomes.push({ scenarioId: s.scenarioId, family: s.family, outcome: "skip", reason });
}

/**
 * A `mustFail` condition that occurred is an engine defect, not a test failure.
 *
 * Same rule as the main E2E suite. In this library almost every one of them is
 * a tenant leak, which is the class of defect that does not announce itself.
 */
export function assertMustFailDidNotHappen(
  s: MultiCompanyScenario,
  condition: string,
  happened: boolean,
): void {
  if (happened) {
    outcomes.push({
      scenarioId: s.scenarioId,
      family: s.family,
      outcome: "engine-defect",
      reason: `mustFail occurred: ${condition}`,
    });
    throw new Error(
      `ENGINE DEFECT in ${s.scenarioId}: "${condition}" is listed under mustFail and it happened.`,
    );
  }
}

/**
 * A real defect found outside this scenario's stated `mustFail`.
 *
 * `assertMustFailDidNotHappen` answers the corpus's question and throws. This
 * answers a different one: the scenario's own conditions held, AND something
 * else is wrong. Recorded rather than thrown so the remaining scenarios still
 * run -- a finding that halts the suite hides the findings behind it.
 *
 * It shows in the report as ENGINE-DEFECT, which is the loud part.
 */
export function engineDefect(s: MultiCompanyScenario, reason: string): void {
  outcomes.push({
    scenarioId: s.scenarioId,
    family: s.family,
    outcome: "engine-defect",
    reason,
  });
}

export function printReport(): void {
  if (outcomes.length === 0) return;
  const by = (o: Outcome) => outcomes.filter((r) => r.outcome === o);
  const lines = [
    "",
    "─".repeat(78),
    "  MULTI-COMPANY LIBRARY — MC-01..MC-24",
    "─".repeat(78),
    `  pass ${by("pass").length}   skip ${by("skip").length}   engine-defect ${by("engine-defect").length}`,
    "",
  ];
  for (const o of outcomes) {
    const mark = o.outcome === "pass" ? "PASS" : o.outcome === "skip" ? "SKIP" : "ENGINE-DEFECT";
    lines.push(`  ${mark.padEnd(13)} ${o.scenarioId.padEnd(7)} ${o.family.padEnd(32)} ${o.reason}`);
  }
  lines.push("─".repeat(78));
  // eslint-disable-next-line no-console
  console.log(lines.join(String.fromCharCode(10)));
}
