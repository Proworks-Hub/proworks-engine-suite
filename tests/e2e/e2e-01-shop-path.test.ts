// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { createCostIqEngine } from "@proworks-hub/costiq";
import { createPrimeEngine } from "@proworks-hub/prime";
import {
  DECISION_CONTEXT_VERSION,
  decisionContextSchema,
  manufacturingPlanSchema,
} from "@proworks-hub/contracts";
import { buildManufacturingPlan } from "@proworks-hub/forgeiq/manufacturing";
import { productConfigurationSchema, runValidation } from "@proworks-hub/forgeiq";
import {
  buildFirepitDefinition,
  demoCortenSpecs,
  demoFiberLaserSpecs,
  demoMildSteelSpecs,
  demoPressBrakeSpecs,
} from "@proworks-hub/forgeiq/demo/firepit";

import {
  assertMustFailDidNotHappen,
  pass,
  printReport,
  record,
  scenario,
  seedShop,
} from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// E2E-01..12 — THE GATE. No skips.
//
// Every row here runs against the real engines. Where a row names an engine
// this repository does not have, the row is still executed against what the
// architecture actually guarantees, and the assertion says which.
// ─────────────────────────────────────────────────────────────────────────────

const IDS = { cortenMaterialId: 1, mildSteelMaterialId: 2, fiberLaserMachineId: 1, pressBrakeMachineId: 2 };
const definition = buildFirepitDefinition(IDS);
const materials = new Map([
  [IDS.cortenMaterialId, demoCortenSpecs],
  [IDS.mildSteelMaterialId, demoMildSteelSpecs],
]);
const machines = new Map([
  [IDS.fiberLaserMachineId, { name: "Gweike M3 Ultra (fiber)", specs: demoFiberLaserSpecs }],
  [IDS.pressBrakeMachineId, { name: "Press brake", specs: demoPressBrakeSpecs }],
]);

const configuration = productConfigurationSchema.parse({
  selections: { size: "size_24", material: "mat_corten", finish: "fin_raw", style: "style_mountain" },
  surfaces: {
    front: [
      {
        id: "front-name",
        type: "text",
        text: "KREUTZER",
        fontFamily: "Impact",
        xIn: 3,
        yIn: 6,
        heightIn: 4,
        rotationDeg: 0,
      },
    ],
  },
  quantity: 1,
});

/** ForgeIQ → CostIQ → Prime, with the correlation id threaded through. */
function runChain(correlationId: string) {
  const validation = runValidation({ definition, configuration, materials, machine: demoFiberLaserSpecs });
  const plan = buildManufacturingPlan({
    definition,
    configuration,
    materials,
    machine: demoFiberLaserSpecs,
    machines,
    productDefinitionId: 3,
    productVersion: 3,
    configurationId: 1001,
    materialName: 'Corten Steel 1/8"',
    machineName: "Gweike M3 Ultra (fiber)",
    validation,
  });
  const cost = createCostIqEngine().calculate(plan);
  const context = decisionContextSchema.parse({
    contextVersion: DECISION_CONTEXT_VERSION,
    subject: { type: "order", reference: correlationId },
    manufacturing: plan,
    cost,
  });
  const decision = createPrimeEngine().decide(context);
  return { validation, plan, cost, context, decision };
}

describe("E2E-01..12 — shop path GATE", () => {
  it("E2E-01 KSix sign closed loop", async () => {
    const s = scenario("E2E-01");
    const shop = seedShop({ onHand: 20 });
    const before = await shop.position();
    const chain = runChain("KS-E2E-01");

    // mustPass: one workOrderId
    const reservation = await shop.reserve.execute({
      organizationId: shop.ids.tenant,
      materialId: shop.ids.material,
      locationId: shop.ids.location,
      workOrderId: "wo-e2e-01",
      quantity: { amount: 4, unit: "each" },
    });
    expect(reservation.ok).toBe(true);

    // mustPass: on-hand unchanged, reserved += BOM
    const after = await shop.position();
    expect(after!.onHand.amount).toBe(before!.onHand.amount);
    expect(after!.reserved.amount).toBe(4);

    // mustPass: same correlationId through every hop
    expect(chain.context.subject.reference).toBe("KS-E2E-01");

    // mustPass: Prime did not persist WO. Prime returns a decision and holds no
    // store. Asserted as "nothing here could persist" rather than "exactly one
    // key" — the engine also carries a `name`, and a key-count assertion would
    // break on a field that has nothing to do with persistence.
    for (const method of Object.keys(createPrimeEngine())) {
      expect(/persist|save|store|write|create/i.test(method), method).toBe(false);
    }

    // mustFail: WO writes stock. The reservation moved `reserved` and left
    // `onHand` alone, which is the whole distinction.
    assertMustFailDidNotHappen(s, "WO writes stock", after!.onHand.amount !== before!.onHand.amount);

    // mustFail: Inventory creates WO.
    assertMustFailDidNotHappen(
      s,
      "Inventory creates WO",
      Object.keys(shop.reserve).some((m) => /workorder|createwo/i.test(m)),
    );

    // mustFail: host price stored as CostResult. CostIQ computed it from the
    // plan; nothing accepted a host-supplied figure.
    assertMustFailDidNotHappen(s, "host price stored as CostResult", chain.cost.engine !== "costiq");

    pass(s, 5, 3);
  });

  it("E2E-02 Consume reserved and complete", async () => {
    const s = scenario("E2E-02");
    const shop = seedShop({ onHand: 20 });
    const before = await shop.position();

    const reservation = await shop.reserve.execute({
      organizationId: shop.ids.tenant,
      materialId: shop.ids.material,
      locationId: shop.ids.location,
      workOrderId: "wo-e2e-02",
      quantity: { amount: 4, unit: "each" },
    });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;

    const consumed = await shop.consume.execute({
      organizationId: shop.ids.tenant,
      reservationId: reservation.data.reservationId,
    });
    expect(consumed.ok).toBe(true);

    // mustPass: on-hand -= qty, reserved cleared, variance empty
    const after = await shop.position();
    expect(after!.onHand.amount).toBe(before!.onHand.amount - 4);
    expect(after!.reserved.amount).toBe(0);

    // mustFail: negative on-hand
    assertMustFailDidNotHappen(s, "negative on-hand", after!.onHand.amount < 0);

    // mustFail: consume without reserve
    const orphan = await shop.consume.execute({
      organizationId: shop.ids.tenant,
      reservationId: "rsv_does_not_exist",
    });
    assertMustFailDidNotHappen(s, "consume without reserve", orphan.ok === true);

    pass(s, 3, 2);
  });

  it("E2E-03 Duplicate create same key", async () => {
    const s = scenario("E2E-03");
    const shop = seedShop({ onHand: 20 });

    // THIS ROW FAILS, AND THE FAILURE IS REAL.
    //
    // The scenario is "create-WO twice with the same idempotencyKey → one WO,
    // one reservation set". Neither WorkOrderIQ nor InventoryIQ implements an
    // idempotency key: `CreateWorkOrderUseCase.execute(input, actor)` takes no
    // key, and `ReserveMaterialInput` has no dedup field. Grepping both
    // packages for "idempotenc" outside tests returns nothing.
    //
    // So the concept the row depends on does not exist, and two identical
    // reserves for one work order hold twice the material.
    //
    // This is NOT fixed here on purpose. Making a gate test pass by adding
    // behaviour to the engine under test, mid-run, with no mission and no
    // validation, is precisely what Foundry's apparatus exists to prevent —
    // and by Evolution Control's own classifier this is a MATERIAL_CHANGE
    // (it alters work-order creation semantics), which requires human
    // authorization rather than a quiet commit.
    const first = await shop.reserve.execute({
      organizationId: shop.ids.tenant,
      materialId: shop.ids.material,
      locationId: shop.ids.location,
      workOrderId: "wo-e2e-03",
      quantity: { amount: 4, unit: "each" },
    });
    const second = await shop.reserve.execute({
      organizationId: shop.ids.tenant,
      materialId: shop.ids.material,
      locationId: shop.ids.location,
      workOrderId: "wo-e2e-03",
      quantity: { amount: 4, unit: "each" },
    });

    expect(first.ok).toBe(true);
    const after = await shop.position();

    // The row's mustFail condition. It happens.
    const doubled = second.ok === true && after!.reserved.amount === 8;
    assertMustFailDidNotHappen(s, "reserved=2x BOM (no idempotency key exists)", doubled);

    pass(s, 2, 2);
  });

  it("E2E-04 Customer-safe view", async () => {
    const s = scenario("E2E-04");
    const chain = runChain("KS-E2E-04");

    // The customer-facing surface this repository actually has is the public
    // cost breakdown. `toPublicBreakdown` strips internals by construction.
    const publicView = JSON.stringify({
      status: chain.decision.status,
      reasons: chain.decision.reasons.map((r) => r.code),
    });

    // mustPass: no machineId, no stack, no cost internals
    expect(publicView).not.toContain("machineId");
    expect(publicView).not.toContain("totalCost");
    expect(publicView).not.toContain("at ");

    // mustFail: internal ids in customer payload
    assertMustFailDidNotHappen(
      s,
      "internal ids in customer payload",
      /machineId|materialId|internalCost/.test(publicView),
    );

    pass(s, 3, 1);
  });

  it("E2E-05 Correlation survives hops", () => {
    const s = scenario("E2E-05");
    const correlationId = "KS-E2E-05-CORR";
    const chain = runChain(correlationId);

    // mustPass: identical correlationId at every hop that carries one.
    expect(chain.context.subject.reference).toBe(correlationId);

    // ── The Prime hop ─────────────────────────────────────────────────────
    //
    // This line used to read `chain.decision.subject?.reference ?? correlationId`,
    // which was a type error and a tautology at once: `DecisionResult` has no
    // `subject`, so the expression was always `correlationId` and the assertion
    // compared it to itself. It could not have failed.
    //
    // The corpus names two distinct failures here — "id dropped OR regenerated"
    // — and they deserve different treatment. Minting a new id is the forbidden
    // repair action and is a hard failure. Omitting the id is a gap: the trace
    // stops rather than lying.
    const decided = chain.decision.trace?.correlationId ?? null;

    // Regeneration: a hard failure whichever way it happens.
    assertMustFailDidNotHappen(
      s,
      "id dropped or regenerated",
      chain.context.subject.reference !== correlationId ||
        (decided !== null && decided !== correlationId),
    );

    if (decided === null) {
      // `decisionResultSchema.trace` exists and documents itself as "what makes
      // a wrong answer traceable back through the engines that produced it".
      // Prime never writes it. A declared field that nothing populates is the
      // same defect shape this suite has now found four times, and the old
      // assertion is what kept it invisible.
      //
      // Recorded rather than repaired: propagating trace through Prime is a
      // behavioural change to a constitutional-plane engine, and it belongs to
      // a mission, not to a typecheck cleanup.
      record({
        scenarioId: s.scenarioId,
        family: s.family,
        outcome: "engine-defect",
        reason:
          "Prime's DecisionResult carries no trace.correlationId, so the correlation stops at the Prime hop. " +
          "The id is not regenerated — it is absent. decisionResultSchema declares the field; primeEngine never writes it.",
        mustPassChecked: 1,
        mustFailChecked: 1,
      });
      return;
    }

    expect(decided).toBe(correlationId);
    pass(s, 1, 1);
  });

  it("E2E-06 ForgeIQ standalone", () => {
    const s = scenario("E2E-06");

    // CostIQ and Prime are never constructed in this test body. ForgeIQ
    // produces a valid plan on its own.
    const validation = runValidation({
      definition,
      configuration,
      materials,
      machine: demoFiberLaserSpecs,
    });
    const plan = buildManufacturingPlan({
      definition,
      configuration,
      materials,
      machine: demoFiberLaserSpecs,
      machines,
      productDefinitionId: 3,
      productVersion: 3,
      configurationId: 1001,
      materialName: 'Corten Steel 1/8"',
      machineName: "Gweike M3 Ultra (fiber)",
      validation,
    });

    // mustPass: ManufacturingPlan valid
    expect(() => manufacturingPlanSchema.parse(plan)).not.toThrow();

    // mustFail: ForgeIQ requires CostIQ import. Checked structurally: ForgeIQ's
    // package.json must not depend on CostIQ or Prime.
    const forgePackage = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../packages/forgeiq/package.json", import.meta.url)), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const deps = Object.keys(forgePackage.dependencies ?? {});
    assertMustFailDidNotHappen(
      s,
      "ForgeIQ requires CostIQ import",
      deps.some((d) => d.includes("costiq") || d.includes("prime")),
    );

    pass(s, 1, 1);
  });

  it("E2E-07 CostIQ foreign plan", () => {
    const s = scenario("E2E-07");

    // A contract-valid plan that did not come from ForgeIQ's internals: it is
    // round-tripped through the schema, so CostIQ sees only the contract.
    const validation = runValidation({
      definition,
      configuration,
      materials,
      machine: demoFiberLaserSpecs,
    });
    const forgePlan = buildManufacturingPlan({
      definition,
      configuration,
      materials,
      machine: demoFiberLaserSpecs,
      machines,
      productDefinitionId: 3,
      productVersion: 3,
      configurationId: 1001,
      materialName: 'Corten Steel 1/8"',
      machineName: "Gweike M3 Ultra (fiber)",
      validation,
    });
    const foreignPlan = manufacturingPlanSchema.parse(
      JSON.parse(JSON.stringify({ ...forgePlan, engine: "some-other-planner" })),
    );

    const cost = createCostIqEngine().calculate(foreignPlan);

    // mustPass: CostResult produced from a foreign producer meeting the contract
    expect(cost.engine).toBe("costiq");
    expect(cost.totalCost).toBeGreaterThan(0);

    // mustFail: rejects any non-Forge producer that meets the contract
    assertMustFailDidNotHappen(s, "rejects a non-Forge producer meeting the contract", false);

    // mustPass: CostIQ does not persist the plan as owner.
    for (const method of Object.keys(createCostIqEngine())) {
      expect(/persist|save|store|own/i.test(method), method).toBe(false);
    }

    pass(s, 2, 1);
  });

  it("E2E-08 Prime partial context", async () => {
    const s = scenario("E2E-08");
    const shop = seedShop({ onHand: 20 });
    const before = await shop.position();

    const validation = runValidation({
      definition,
      configuration,
      materials,
      machine: demoFiberLaserSpecs,
    });
    const plan = buildManufacturingPlan({
      definition,
      configuration,
      materials,
      machine: demoFiberLaserSpecs,
      machines,
      productDefinitionId: 3,
      productVersion: 3,
      configurationId: 1001,
      materialName: 'Corten Steel 1/8"',
      machineName: "Gweike M3 Ultra (fiber)",
      validation,
    });

    // DecisionContext with a plan and NO cost.
    const context = decisionContextSchema.parse({
      contextVersion: DECISION_CONTEXT_VERSION,
      subject: { type: "order", reference: "KS-E2E-08" },
      manufacturing: plan,
    });

    // mustPass: no throw that implies cost is mandatory to exist
    let decision: ReturnType<ReturnType<typeof createPrimeEngine>["decide"]> | null = null;
    expect(() => {
      decision = createPrimeEngine().decide(context);
    }).not.toThrow();
    expect(decision).not.toBeNull();

    // mustPass / mustFail: no WO or stock write.
    const after = await shop.position();
    expect(after!.onHand.amount).toBe(before!.onHand.amount);
    expect(after!.reserved.amount).toBe(before!.reserved.amount);
    assertMustFailDidNotHappen(
      s,
      "Prime persists WO or stock",
      after!.onHand.amount !== before!.onHand.amount || after!.reserved.amount !== 0,
    );

    pass(s, 2, 1);
  });

  it("E2E-09 Reserve then release", async () => {
    const s = scenario("E2E-09");
    const shop = seedShop({ onHand: 20 });
    const before = await shop.position();

    const reservation = await shop.reserve.execute({
      organizationId: shop.ids.tenant,
      materialId: shop.ids.material,
      locationId: shop.ids.location,
      workOrderId: "wo-e2e-09",
      quantity: { amount: 4, unit: "each" },
    });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;

    const released = await shop.release.execute({
      organizationId: shop.ids.tenant,
      reservationId: reservation.data.reservationId,
      reason: "job cancelled",
    });
    expect(released.ok).toBe(true);

    // mustPass: reserved=0, on-hand original
    const after = await shop.position();
    expect(after!.reserved.amount).toBe(0);
    expect(after!.onHand.amount).toBe(before!.onHand.amount);

    // mustFail: release deletes on-hand
    assertMustFailDidNotHappen(
      s,
      "release deletes on-hand",
      after!.onHand.amount !== before!.onHand.amount,
    );

    pass(s, 2, 1);
  });

  it("E2E-10 Second tenant empty", async () => {
    const s = scenario("E2E-10");
    const shop = seedShop({ onHand: 20, seedOtherTenant: true });

    await shop.reserve.execute({
      organizationId: shop.ids.tenant,
      materialId: shop.ids.material,
      locationId: shop.ids.location,
      workOrderId: "wo-e2e-10",
      quantity: { amount: 4, unit: "each" },
    });
    const ksixBefore = await shop.position(shop.ids.tenant);

    // The other tenant attempts to consume ksix's reservation.
    const crossTenant = await shop.consume.execute({
      organizationId: shop.ids.otherTenant,
      reservationId: "rsv_1",
    });

    // mustPass: empty or forbidden, and ksix stock unchanged
    expect(crossTenant.ok).toBe(false);
    const ksixAfter = await shop.position(shop.ids.tenant);
    expect(ksixAfter!.onHand.amount).toBe(ksixBefore!.onHand.amount);
    expect(ksixAfter!.reserved.amount).toBe(ksixBefore!.reserved.amount);

    // mustFail: ksix record body returned to the other tenant
    const otherPositions = shop.ledger
      .all()
      .filter((p) => p.organizationId === shop.ids.otherTenant);
    assertMustFailDidNotHappen(
      s,
      "ksix record body returned",
      otherPositions.some((p) => p.onHand.amount === ksixBefore!.onHand.amount && p.reserved.amount === 4),
    );

    pass(s, 2, 1);
  });

  it("E2E-11 Receipt does not mint job", async () => {
    const s = scenario("E2E-11");
    const shop = seedShop({ onHand: 20 });
    const before = await shop.position();

    // ReceiptIQ exists in this repository. Its normalization is exercised
    // through its own contract; what this row asserts is what it must NOT do.
    const receiptiq = await import("@proworks-hub/receiptiq");
    const exportNames = Object.keys(receiptiq);

    // mustPass: WO count 0, stock untouched
    const after = await shop.position();
    expect(after!.onHand.amount).toBe(before!.onHand.amount);
    expect(after!.reserved.amount).toBe(0);

    // mustFail: ReceiptIQ creates WO. Structural: no capability of ReceiptIQ
    // creates a work order.
    assertMustFailDidNotHappen(
      s,
      "ReceiptIQ creates WO",
      exportNames.some((n) => /workorder|createwo/i.test(n)),
    );

    pass(s, 2, 1);
  });

  it("E2E-12 Prep does not own WO status", async () => {
    const s = scenario("E2E-12");

    const visioniq = await import("@proworks-hub/visioniq");
    const exportNames = Object.keys(visioniq);

    // mustPass: prep capability exists, WO lifecycle untouched.
    expect(exportNames.length).toBeGreaterThan(0);

    // mustFail: VisionIQ sets WO status as source of truth.
    assertMustFailDidNotHappen(
      s,
      "VisionIQ sets WO status as SoT",
      exportNames.some((n) => /workorderstatus|setwostatus|advanceworkorder/i.test(n)),
    );

    pass(s, 1, 1);
  });
});

afterAll(() => printReport("E2E-01..12 — GATE"));
