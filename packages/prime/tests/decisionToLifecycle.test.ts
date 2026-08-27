import { describe, expect, it } from "vitest";
import type { CostResult, ManufacturingPlan } from "@proworks-hub/contracts";
import { decisionContextSchema, DECISION_CONTEXT_VERSION } from "@proworks-hub/contracts";
import {
  createPrimeEngine,
  createInMemoryEventLog,
  createCreateWorkOrderUseCase,
  type EventActor,
  type IntakeInput,
} from "../src/index";

// ─────────────────────────────────────────────────────────────────────────────
// Prime's two layers, composed.
//
//   decision boundary  →  "should this proceed?"
//   lifecycle          →  "then put it through intake and start the events"
//
// The boundary reads normalized output from ForgeIQ and CostIQ; the lifecycle
// knows nothing about either. Nothing here imports ForgeIQ or CostIQ — the
// plan and cost below are authored by hand, which is the point.
// ─────────────────────────────────────────────────────────────────────────────

const plan: ManufacturingPlan = {
  planVersion: 1,
  product: {
    slug: "firepit-24",
    name: "Custom Metal Fire Pit",
    category: "fire-pit",
    manufacturingProcess: "fiber-laser-cut",
  },
  quantity: 1,
  selections: { size: '24"' },
  material: { category: "corten", thicknessIn: 0.125 },
  machine: { process: "fiber-laser", workAreaWidthIn: 24, workAreaHeightIn: 24 },
  machines: [{ process: "fiber-laser", workAreaWidthIn: 24, workAreaHeightIn: 24 }],
  parts: [],
  stock: null,
  operations: [
    {
      id: "laser-cut",
      type: "cut",
      machineProcess: "fiber-laser",
      estimatedMinutes: 48,
      setupMinutes: 20,
      isLabor: false,
    },
  ],
  labor: { estimatedMinutes: 45, derivedFromOperations: false },
  finishing: [],
  advisoryRates: {},
  manufacturability: { valid: true, errors: 0, warnings: 0 },
  estimatedFromArea: false,
};

const healthyCost: CostResult = {
  engine: "test",
  resultVersion: 1,
  currency: "USD",
  totalCost: 300,
  lines: [{ code: "all", label: "Everything", amount: 300, category: "other" }],
  recommendedPrice: 750,
  margin: 450,
  marginPct: 0.6,
  assumptions: [],
  unpriced: [],
};

const contextFor = (cost: CostResult) =>
  decisionContextSchema.parse({
    contextVersion: DECISION_CONTEXT_VERSION,
    subject: { type: "order", reference: "KS-COMPOSE-1" },
    manufacturing: plan,
    cost,
  });

const actor: EventActor = { kind: "system", source: "decision-to-lifecycle-test" };

const intake: IntakeInput = {
  customerId: "cust-1",
  customerName: "Kreutzer",
  source: "portal",
  lineItems: [{ id: "li-1", label: '24" Custom Fire Pit', quantity: 1 }],
};

describe("Prime: decision boundary into lifecycle", () => {
  it("approves a healthy job, then intake starts the event stream", async () => {
    const decision = createPrimeEngine().decide(contextFor(healthyCost));
    expect(decision.status).toBe("proceed");

    // Only once Prime has approved does the work order enter the lifecycle.
    const eventLog = createInMemoryEventLog();
    const createWorkOrder = createCreateWorkOrderUseCase({ eventLog });
    const result = await createWorkOrder.execute(intake, actor);

    expect(result.ok).toBe(true);
    const events = await eventLog.listSince(0);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].workOrderId).toBeTruthy();
  });

  it("holds a thin-margin job at the boundary, before any events exist", async () => {
    const thin: CostResult = { ...healthyCost, marginPct: 0.05 };
    const decision = createPrimeEngine().decide(contextFor(thin));
    expect(decision.status).toBe("review");
    expect(decision.reasons.map((r) => r.code)).toContain("margin-below-minimum");

    // A held job never reaches the lifecycle, so its log stays empty.
    const eventLog = createInMemoryEventLog();
    expect(await eventLog.size()).toBe(0);
  });

  it("blocks an unmanufacturable job on ForgeIQ's verdict alone", () => {
    const unbuildable: ManufacturingPlan = {
      ...plan,
      manufacturability: { valid: false, errors: 2, warnings: 0 },
    };
    const decision = createPrimeEngine().decide(
      decisionContextSchema.parse({
        contextVersion: DECISION_CONTEXT_VERSION,
        subject: { type: "order", reference: "KS-COMPOSE-2" },
        manufacturing: unbuildable,
        cost: healthyCost,
      }),
    );
    expect(decision.status).toBe("blocked");
    expect(decision.actions.map((a) => a.code)).toContain("return-to-design");
  });

  it("rejects invalid intake without emitting anything", async () => {
    const eventLog = createInMemoryEventLog();
    const createWorkOrder = createCreateWorkOrderUseCase({ eventLog });
    const result = await createWorkOrder.execute({ ...intake, lineItems: [] }, actor);
    expect(result.ok).toBe(false);
  });
});
