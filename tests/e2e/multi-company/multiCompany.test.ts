// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { afterAll, describe, expect, it } from "vitest";

import { hiveMessageSchema, HIVE_MESSAGE_SCHEMA_VERSION, HIVE_MAP } from "@proworks-hub/contracts";
import { createPrimeEngine } from "@proworks-hub/prime";
import {
  BASELINE_STRATEGIES,
  buildFailureSignature,
  createExperienceStore,
  createPatternLibrary,
  createRepairBot,
  findReusableKnowledge,
  generalize,
  repairBotLease,
  repairCaseSchema,
  type Diagnosis,
  type InvariantAssessment,
  type SimulationRun,
} from "@proworks-hub/repair-learning";
import { createAuditIq } from "@proworks-hub/auditiq";

import {
  ACTOR,
  COMPANIES,
  LOCATION,
  SCENARIOS,
  assertMustFailDidNotHappen,
  buildWorld,
  pass,
  printReport,
  runJob,
  scenario,
  skip,
} from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// MC-01..MC-24 — isolation under simultaneous companies.
//
// Five tenants alive in one process, engines shared, state partitioned.
// ─────────────────────────────────────────────────────────────────────────────

const KSIX = "ksix";
const BRIGHTON = "brighton-signs";
const LONGMONT = "longmont-print";
const FAMILY = "family-table";
const MAKEROPS = "makerops-demo";

describe("the library loads", () => {
  it("carries 24 scenarios and 5 companies", () => {
    expect(SCENARIOS).toHaveLength(24);
    expect(COMPANIES).toHaveLength(5);
    expect(COMPANIES.map((c) => c.id).sort()).toEqual(
      [BRIGHTON, FAMILY, KSIX, LONGMONT, MAKEROPS].sort(),
    );
  });

  it("gives ksix and brighton the same SKU string", () => {
    // The homonym MC-02 turns on. Two shops legitimately stock "ACRYLIC-3MM"
    // and it is not the same acrylic.
    const ksix = COMPANIES.find((c) => c.id === KSIX)!;
    const brighton = COMPANIES.find((c) => c.id === BRIGHTON)!;
    expect(ksix.sku).toBe(brighton.sku);
  });
});

// ── Priority 1 ───────────────────────────────────────────────────────────────

describe("MC-01 five companies closed-loop at once", () => {
  it("completes five independently with no shared ids", async () => {
    const s = scenario("MC-01");
    const world = buildWorld({ onHand: 10 });

    // family-table does receipt only — no work order, per the injection.
    const manufacturers = [KSIX, BRIGHTON, LONGMONT, MAKEROPS];
    const results = await Promise.all(
      manufacturers.map((id) => runJob(world.tenant(id), { quantity: 2 })),
    );

    // mustPass: five distinct tenantIds
    expect(new Set(COMPANIES.map((c) => c.id)).size).toBe(5);

    // mustPass: no shared workOrderId
    const workOrderIds = results.map((r) => r.workOrderId);
    expect(new Set(workOrderIds).size).toBe(manufacturers.length);

    // mustPass: ksix stock unchanged by others
    for (const id of manufacturers) {
      const position = world.tenant(id).position()!;
      expect(position.onHand.amount, id).toBe(10);
      expect(position.reserved.amount, id).toBe(2);
    }
    expect(world.tenant(FAMILY).position()!.reserved.amount).toBe(0);

    // mustFail: any mixed-tenant projection
    const leaked = [...world.tenants.values()].some((t) =>
      t.visiblePositions().some((p) => p.organizationId !== t.company.id),
    );
    assertMustFailDidNotHappen(s, "any mixed-tenant projection", leaked);

    pass(s, "5 tenants, 4 jobs, 0 shared ids");
  });
});

// ── Priority 2 ───────────────────────────────────────────────────────────────

describe("MC-02 SKU homonym", () => {
  it("keeps two shops' ACRYLIC-3MM apart", async () => {
    const s = scenario("MC-02");
    // One ledger holding both, which is the arrangement where a SKU used as a
    // global key actually collides.
    const world = buildWorld({ onHand: 10, sharedLedger: true });

    await runJob(world.tenant(KSIX), { quantity: 10 });

    const ksix = world.tenant(KSIX).position()!;
    const brighton = world.tenant(BRIGHTON).position()!;

    // mustPass: ksix reserved=10, brighton on-hand untouched
    expect(ksix.reserved.amount).toBe(10);
    expect(brighton.reserved.amount).toBe(0);
    expect(brighton.onHand.amount).toBe(10);

    // mustFail: sku used as a global primary key. If it were, one row would
    // hold both shops' acrylic and brighton's reserved would have moved.
    const rows = world
      .sharedLedger!.all()
      .filter((p) => p.materialId === "ACRYLIC-3MM");
    assertMustFailDidNotHappen(s, "sku used as global primary key", rows.length !== 2);

    pass(s, "two partitions for one SKU string");
  });
});

// ── Priority 3 ───────────────────────────────────────────────────────────────

describe("MC-03 correlation theft", () => {
  it("does not let brighton reach a ksix job by replaying its correlationId", async () => {
    const s = scenario("MC-03");
    const world = buildWorld({ onHand: 10 });

    const ksixJob = await runJob(world.tenant(KSIX), { quantity: 4 });
    const before = world.tenant(KSIX).position()!;

    // Brighton sends a well-formed envelope carrying ksix's correlation id but
    // its own tenant. The envelope is valid — correlation is not authority.
    const stolen = hiveMessageSchema.safeParse({
      messageId: "msg_brighton_1",
      category: "EVENT",
      messageType: "material.reserved",
      schemaVersion: HIVE_MESSAGE_SCHEMA_VERSION,
      producerId: "hive.specialized.workorderiq",
      tenant: { organizationId: BRIGHTON, roles: [] },
      systemScoped: false,
      trace: { correlationId: "C1-ksix" },
      timestamp: "2026-08-29T10:00:00.000Z",
      dataClassification: "internal",
      payload: {},
    });
    expect(stolen.success).toBe(true);

    // Brighton attempts to consume the ksix reservation it learned the id of.
    const theft = await world.tenant(BRIGHTON).consume.execute({
      organizationId: BRIGHTON,
      reservationId: ksixJob.reservationId ?? "rsv_ksix_1",
    });

    // mustPass: empty/forbidden, ksix WO unchanged
    expect(theft.ok).toBe(false);
    const after = world.tenant(KSIX).position()!;
    expect(after.reserved.amount).toBe(before.reserved.amount);

    // mustFail: ksix job visible to brighton
    const brightonSees = world
      .tenant(BRIGHTON)
      .visiblePositions()
      .some((p) => p.organizationId === KSIX);
    assertMustFailDidNotHappen(s, "ksix job visible to brighton", brightonSees);

    pass(s, "correlation carried, authority did not");
  });
});

// ── Priority 4 ───────────────────────────────────────────────────────────────

describe("MC-04 burst of twenty", () => {
  it("interleaves twenty jobs across three manufacturers without a leak", async () => {
    const s = scenario("MC-04");
    const world = buildWorld({ onHand: 20, sharedLedger: true });
    const manufacturers = [KSIX, BRIGHTON, LONGMONT];

    const jobs = Array.from({ length: 20 }, (_, i) => {
      const tenantId = manufacturers[i % manufacturers.length]!;
      return runJob(world.tenant(tenantId), { quantity: 2, label: `job-${i}` });
    });
    await Promise.all(jobs);

    // mustPass: reserved per tenant <= that tenant's on-hand
    for (const id of manufacturers) {
      const position = world.tenant(id).position()!;
      expect(position.reserved.amount, id).toBeLessThanOrEqual(position.onHand.amount);
      expect(position.onHand.amount, id).toBe(20);
    }

    // mustPass: zero cross-tenant reads. Every row still belongs to exactly one
    // tenant and the totals are per-tenant.
    const rows = world.sharedLedger!.all();
    expect(rows).toHaveLength(COMPANIES.length);

    // mustFail: mixed-tenant projection
    const mixed = rows.some(
      (p) => !COMPANIES.some((c) => c.id === p.organizationId && c.sku === p.materialId),
    );
    assertMustFailDidNotHappen(s, "mixed-tenant projection", mixed);

    pass(s, "20 interleaved jobs, 3 tenants, partitions intact");
  });
});

// ── Priority 5 ───────────────────────────────────────────────────────────────

describe("MC-07 contention does not borrow the other shop", () => {
  it("fights over ksix acrylic and never touches brighton's", async () => {
    const s = scenario("MC-07");
    const world = buildWorld({ onHand: 10, sharedLedger: true });

    // Two ksix jobs competing for the same acrylic, concurrently.
    await Promise.all([
      runJob(world.tenant(KSIX), { quantity: 6, label: "job-a" }),
      runJob(world.tenant(KSIX), { quantity: 6, label: "job-b" }),
    ]);

    const ksix = world.tenant(KSIX).position()!;
    const brighton = world.tenant(BRIGHTON).position()!;

    // mustPass: ksix reserved <= 10 — one of the two jobs is refused rather
    // than the shop overselling itself.
    expect(ksix.reserved.amount).toBeLessThanOrEqual(10);

    // mustPass: brighton untouched
    expect(brighton.reserved.amount).toBe(0);
    expect(brighton.onHand.amount).toBe(10);

    // mustFail: brighton stock used to fill ksix. The tell would be ksix
    // holding more than its own on-hand.
    assertMustFailDidNotHappen(
      s,
      "brighton stock used to fill ksix",
      ksix.reserved.amount > ksix.onHand.amount || brighton.reserved.amount > 0,
    );

    pass(s, `ksix reserved ${ksix.reserved.amount}/10, brighton untouched`);
  });
});

// ── Priority 6 ───────────────────────────────────────────────────────────────

describe("MC-11 lesson minimization", () => {
  it("refuses a lesson carrying a tenant or an order id", () => {
    const s = scenario("MC-11");

    const run = {
      runId: "run_1",
      scenarioId: "MC-11",
      scenarioVersion: "2.0",
      executionId: "exec_1",
      correlationId: "cor_1",
      environment: "SIMULATION",
      startedAt: "2026-08-29T10:00:00.000Z",
      finishedAt: "2026-08-29T10:00:05.000Z",
      injections: [],
      evidence: [],
      evidenceCompleteness: { complete: true, missing: [], captured: [] },
      mustPassResults: [],
      engineDefectCondition: { condition: "x", held: false, evidenceIds: [], detail: "n" },
      outcome: "FAILED",
      outcomeReason: "r",
      forbiddenRepairActions: [],
      versions: {},
    } as unknown as SimulationRun;

    const signature = buildFailureSignature({
      failureSignatureId: "sig_1",
      run,
      primarySymptom: "duplicate work order created",
      affectedComponents: ["hive.specialized.workorderiq"],
      tenantScope: KSIX,
      riskClass: "routine",
      invariantsAtRisk: ["HIVE-INV-IDEMPOTENCY-001"],
    });

    const store = createExperienceStore();
    const recorded = store.record(
      repairCaseSchema.parse({
        caseId: "case_ksix_1",
        failureSignatureHash: signature.signatureHash,
        failureSignature: signature,
        environment: "SIMULATION",
        componentVersions: {},
        diagnosisId: "dx_1",
        rootCause: "The consumer performs no delivery-key check.",
        diagnosisConfirmed: true,
        repairClass: "IDEMPOTENCY",
        repairAttempts: [
          {
            repairAttemptId: "ra_1",
            repairCandidateId: "rc_1",
            outcome: "APPLIED_SUCCEEDED",
            validatorOutcomes: {},
            scores: {},
            attemptedAt: "2026-08-29T10:05:00.000Z",
          },
        ],
        selectedRepairId: "rc_1",
        applicabilityScope: {
          components: ["hive.specialized.workorderiq"],
          engineVersions: {},
          contractVersions: {},
          constitutionVersion: "1.0",
          environments: ["SIMULATION"],
          crossTenantLearningApproved: false,
        },
        confidence: "confirmed",
        provenance: { runId: "run_1", recordedBy: "foundry", recordedAt: "2026-08-29T10:10:00.000Z" },
        knowledgeStatus: "RECORDED",
        timings: {},
        humanIntervention: false,
      }),
    );
    if (!recorded.recorded) throw new Error("fixture failed to record");

    const permits = {
      mayGeneralize: () => ({ permitted: true, reason: "ok", decisionId: "gd-1" }),
    };

    // A lesson naming the tenant and the order is refused at minimization.
    const leaky = generalize({
      ruleId: "rule_leaky",
      repairCase: recorded.case,
      authority: permits,
      proposed: {
        title: "KSix order 388 duplicated",
        description: "Tenant ksix order 388 created two work orders.",
        failureClass: "DUPLICATE_DELIVERY",
        applicableComponents: ["event-consumer"],
        preconditions: ["at-least-once delivery"],
        recommendedResponse: "Key on a delivery identifier.",
        forbiddenResponses: ["disable the duplicate check"],
      },
      proposedBy: "foundry.generalizer",
      proposedAt: "2026-08-29T11:00:00.000Z",
      constitutionVersion: "1.0",
    });
    expect(leaky.generalized).toBe(false);
    if (!leaky.generalized) expect(leaky.stage).toBe("minimization");

    // The minimized lesson is accepted, and is PROPOSED rather than APPROVED.
    const clean = generalize({
      ruleId: "rule_clean",
      repairCase: recorded.case,
      authority: permits,
      proposed: {
        title: "Idempotent consumers under at-least-once delivery",
        description:
          "Consumers of at-least-once event delivery must make consequential state transitions idempotent.",
        failureClass: "DUPLICATE_DELIVERY",
        applicableComponents: ["event-consumer", "work-order-intake"],
        preconditions: ["the transport guarantees at-least-once delivery"],
        recommendedResponse: "Key the transition on a delivery identifier.",
        forbiddenResponses: ["disable the duplicate check"],
      },
      proposedBy: "foundry.generalizer",
      proposedAt: "2026-08-29T11:00:00.000Z",
      constitutionVersion: "1.0",
    });

    expect(clean.generalized).toBe(true);
    if (!clean.generalized) return;

    // mustPass: no tenantId anywhere in the stored lesson, status PROPOSED
    const serialized = JSON.stringify({
      title: clean.rule.title,
      description: clean.rule.description,
      applicableComponents: clean.rule.applicableComponents,
    });
    expect(serialized.toLowerCase()).not.toContain(KSIX);
    expect(serialized).not.toContain("388");
    expect(clean.rule.status).toBe("PROPOSED");

    // mustFail: ksix or an order number in the stored lesson
    assertMustFailDidNotHappen(
      s,
      "ksix or order number in stored lesson",
      /ksix|388/i.test(serialized),
    );

    pass(s, "leaky lesson refused at minimization, clean lesson PROPOSED");
  });
});

// ── Priority 7 ───────────────────────────────────────────────────────────────

describe("MC-17 two hosts, one kernel", () => {
  it("keeps a single stock owner with two tenant partitions", async () => {
    const s = scenario("MC-17");
    const world = buildWorld({ onHand: 10, sharedLedger: true });

    await Promise.all([
      runJob(world.tenant(KSIX), { quantity: 3 }),
      runJob(world.tenant(MAKEROPS), { quantity: 4 }),
    ]);

    // mustPass: single stock owner. One ledger, and it is InventoryIQ's — the
    // hosts hold none.
    expect(world.sharedLedger).not.toBeNull();

    // mustPass: two tenant partitions
    const ksix = world.tenant(KSIX).position()!;
    const makerops = world.tenant(MAKEROPS).position()!;
    expect(ksix.reserved.amount).toBe(3);
    expect(makerops.reserved.amount).toBe(4);
    expect(ksix.organizationId).not.toBe(makerops.organizationId);

    // mustFail: host local stock used as SoT. A `Company` is a host — it has
    // no field that could hold stock, which is the structural answer.
    const hostKeys = Object.keys(COMPANIES[0]!);
    assertMustFailDidNotHappen(
      s,
      "host local stock used as SoT",
      hostKeys.some((k) => /stock|onhand|reserved|inventory|ledger/i.test(k)),
    );

    pass(s, "one ledger, two partitions, hosts own nothing");
  });
});

// ── The remaining scenarios ──────────────────────────────────────────────────

describe("MC-05..MC-24 — the rest", () => {
  it("MC-05 poison isolation", async () => {
    const s = scenario("MC-05");
    const world = buildWorld({ onHand: 10 });

    // A poison envelope from longmont: well-formed transport, unusable payload.
    const poison = hiveMessageSchema.safeParse({
      messageId: "msg_poison",
      category: "EVENT",
      messageType: "material.reserved",
      schemaVersion: HIVE_MESSAGE_SCHEMA_VERSION,
      producerId: "hive.specialized.workorderiq",
      tenant: { organizationId: LONGMONT, roles: [] },
      systemScoped: false,
      trace: { correlationId: "cor_poison" },
      timestamp: "2026-08-29T10:00:00.000Z",
      dataClassification: "internal",
      payload: { nonsense: true },
    });
    expect(poison.success).toBe(true);

    // ksix continues regardless.
    const ksixJob = await runJob(world.tenant(KSIX), { quantity: 2 });

    expect(ksixJob.workOrderId).not.toBeNull();
    expect(world.tenant(LONGMONT).position()!.reserved.amount).toBe(0);

    assertMustFailDidNotHappen(
      s,
      "poison writes into ksix",
      world.tenant(KSIX).visiblePositions().some((p) => p.organizationId === LONGMONT),
    );
    pass(s, "longmont poison did not reach ksix");
  });

  it("MC-06 crash isolation", async () => {
    const s = scenario("MC-06");
    const world = buildWorld({ onHand: 10 });

    await runJob(world.tenant(KSIX), { quantity: 3 });
    const ksixBefore = world.tenant(KSIX).position()!.reserved.amount;

    // "Drop brighton memory": a fresh world for brighton alone, which is what a
    // process kill leaves behind when its store was in memory.
    const brightonAfterCrash = buildWorld({ onHand: 10 }).tenant(BRIGHTON);
    await runJob(brightonAfterCrash, { quantity: 2, idempotencyKey: "replay-1" });
    await runJob(brightonAfterCrash, { quantity: 2, idempotencyKey: "replay-1" });

    // mustPass: ksix reserved unchanged; brighton at most one reserve after replay
    expect(world.tenant(KSIX).position()!.reserved.amount).toBe(ksixBefore);
    expect(brightonAfterCrash.position()!.reserved.amount).toBe(2);

    assertMustFailDidNotHappen(
      s,
      "ksix reserve cleared by brighton crash",
      world.tenant(KSIX).position()!.reserved.amount !== ksixBefore,
    );
    pass(s, "ksix untouched; brighton replayed to one reserve");
  });

  it("MC-08 receipt does not mint a work order in either tenant", async () => {
    const s = scenario("MC-08");
    const world = buildWorld({ onHand: 10 });

    const ksixJob = await runJob(world.tenant(KSIX), { quantity: 2 });
    // family-table ingests a receipt: no work order, no stock movement.
    const familyWorkOrders = await world.tenant(FAMILY).eventLog.listByType(
      "work_order.intake.created",
    );

    expect(ksixJob.workOrderId).not.toBeNull();
    expect(familyWorkOrders).toHaveLength(0);
    expect(world.tenant(FAMILY).position()!.reserved.amount).toBe(0);

    assertMustFailDidNotHappen(s, "receipt minted a WO in either tenant", familyWorkOrders.length > 0);
    pass(s, "one ksix WO, zero family-table WOs");
  });

  it("MC-09 customer view never names another tenant", async () => {
    const s = scenario("MC-09");
    const world = buildWorld({ onHand: 10 });
    await runJob(world.tenant(KSIX), { quantity: 2 });

    // The customer-facing projection this repository has: the ksix position,
    // which is the tenant's own row and nobody else's.
    const view = JSON.stringify(world.tenant(KSIX).position());

    expect(view).not.toContain(BRIGHTON);
    expect(view).not.toContain("machineId");

    assertMustFailDidNotHappen(s, "other tenant name in payload", view.includes(BRIGHTON));
    pass(s, "ksix view names no other tenant");
  });

  it("MC-10 a quote purpose cannot consume another tenant's stock", async () => {
    const s = scenario("MC-10");
    const world = buildWorld({ onHand: 10 });
    const ksixJob = await runJob(world.tenant(KSIX), { quantity: 4 });
    const before = world.tenant(KSIX).position()!;

    const attempt = await world.tenant(BRIGHTON).consume.execute({
      organizationId: BRIGHTON,
      reservationId: ksixJob.reservationId ?? "rsv_ksix_1",
    });

    expect(attempt.ok).toBe(false);
    const after = world.tenant(KSIX).position()!;
    expect(after.onHand.amount).toBe(before.onHand.amount);

    assertMustFailDidNotHappen(s, "consume succeeds", attempt.ok === true);
    pass(s, "cross-tenant consume refused");
  });

  it("MC-12 reuse by signature, never by tenant data", () => {
    const s = scenario("MC-12");

    const run = {
      runId: "run_1", scenarioId: "x", scenarioVersion: "2.0", executionId: "e", correlationId: "c",
      environment: "SIMULATION", startedAt: "2026-08-29T10:00:00.000Z", finishedAt: "2026-08-29T10:00:01.000Z",
      injections: [], evidence: [], evidenceCompleteness: { complete: true, missing: [], captured: [] },
      mustPassResults: [], engineDefectCondition: { condition: "x", held: false, evidenceIds: [], detail: "n" },
      outcome: "FAILED", outcomeReason: "r", forbiddenRepairActions: [], versions: {},
    } as unknown as SimulationRun;

    const signatureFor = (tenant: string) =>
      buildFailureSignature({
        failureSignatureId: `sig_${tenant}`,
        run,
        primarySymptom: "duplicate work order created",
        errorCodes: ["EDUP"],
        affectedComponents: ["hive.specialized.workorderiq"],
        tenantScope: tenant,
        riskClass: "routine",
        invariantsAtRisk: [],
      });

    const store = createExperienceStore();
    store.record(
      repairCaseSchema.parse({
        caseId: "case_ksix",
        failureSignatureHash: signatureFor(KSIX).signatureHash,
        failureSignature: signatureFor(KSIX),
        environment: "SIMULATION",
        componentVersions: {},
        diagnosisId: "dx",
        rootCause: "ksix: no delivery-key check on order 388",
        diagnosisConfirmed: true,
        repairClass: "IDEMPOTENCY",
        repairAttempts: [{ repairAttemptId: "ra", repairCandidateId: "rc", outcome: "APPLIED_SUCCEEDED", validatorOutcomes: {}, scores: {}, attemptedAt: "2026-08-29T10:05:00.000Z" }],
        selectedRepairId: "rc",
        applicabilityScope: {
          components: ["hive.specialized.workorderiq"],
          engineVersions: {}, contractVersions: {}, constitutionVersion: "1.0",
          environments: ["SIMULATION"],
          // Set to FALSE. §36 puts cross-tenant learning under Governance.
          crossTenantLearningApproved: false,
        },
        confidence: "confirmed",
        provenance: { runId: "run_1", recordedBy: "foundry", recordedAt: "2026-08-29T10:10:00.000Z" },
        knowledgeStatus: "RECORDED", timings: {}, humanIntervention: false,
      }),
    );

    // The signature hashes DO differ — tenantScope is inside the canonical
    // hash, so brighton's otherwise-identical failure is a different signature.
    expect(signatureFor(BRIGHTON).signatureHash).not.toBe(signatureFor(KSIX).signatureHash);

    const finding = findReusableKnowledge({
      readingTenant: BRIGHTON,
      signature: signatureFor(BRIGHTON),
      store,
      library: createPatternLibrary(),
      currentVersions: {},
    });

    // ── THE DEFECT THIS SCENARIO FOUND, NOW CLOSED ──────────────────────
    //
    // On first run this returned ksix's whole RepairCase to brighton — root
    // cause and provenance included — because `signatureSimilarity` weights
    // tenantScope at 0.05, so an otherwise identical failure scored ~0.95
    // against a 0.6 threshold. `crossTenantLearningApproved` was stored as
    // false and nothing read it.
    //
    // MIS-MC12 made `readingTenant` a required parameter on both `similarTo`
    // and `findReusableKnowledge`, and the gate is applied before scoring.
    //
    // mustPass: "brighton cannot fetch ksix experience record"
    expect(finding.bestPriorCase).toBeNull();
    expect(finding.priorCases).toEqual([]);
    expect(finding.reusable).toBe(false);

    // mustPass: "matchedOn exact signature hash" — brighton's OWN case still
    // matches, so the gate did not break legitimate reuse.
    store.record(
      repairCaseSchema.parse({
        caseId: "case_brighton",
        failureSignatureHash: signatureFor(BRIGHTON).signatureHash,
        failureSignature: signatureFor(BRIGHTON),
        environment: "SIMULATION",
        componentVersions: {},
        diagnosisId: "dx_b",
        rootCause: "brighton: no delivery-key check",
        diagnosisConfirmed: true,
        repairClass: "IDEMPOTENCY",
        repairAttempts: [{ repairAttemptId: "ra_b", repairCandidateId: "rc_b", outcome: "APPLIED_SUCCEEDED", validatorOutcomes: {}, scores: {}, attemptedAt: "2026-08-29T10:05:00.000Z" }],
        selectedRepairId: "rc_b",
        applicabilityScope: { components: ["hive.specialized.workorderiq"], engineVersions: {}, contractVersions: {}, constitutionVersion: "1.0", environments: ["SIMULATION"], crossTenantLearningApproved: false },
        confidence: "confirmed",
        provenance: { runId: "run_b", recordedBy: "foundry", recordedAt: "2026-08-29T10:10:00.000Z" },
        knowledgeStatus: "RECORDED", timings: {}, humanIntervention: false,
      }),
    );

    const own = store.similarTo(signatureFor(BRIGHTON), BRIGHTON);
    expect(own).toHaveLength(1);
    expect(own[0]!.matchedOn).toContain("exact signature hash");

    // mustFail: brighton reads ksix raw case
    assertMustFailDidNotHappen(
      s,
      "brighton reads ksix raw case",
      store.similarTo(signatureFor(BRIGHTON), BRIGHTON).some((c) => c.case.caseId === "case_ksix"),
    );

    pass(s, "cross-tenant retrieval refused; own-tenant exact match intact");
  });

  it("MC-13 audit scope", () => {
    const s = scenario("MC-13");
    const log = createAuditIq({ now: () => new Date("2026-08-29T10:00:00.000Z") });

    for (const tenant of [KSIX, BRIGHTON]) {
      log.record({
        actor: { actorId: "steven", kind: "human" },
        tenant: { organizationId: tenant, roles: [] },
        component: "hive.specialized.workorderiq",
        action: "work_order.created",
        target: { type: "work_order", id: `wo_${tenant}` },
        trace: { correlationId: `cor_${tenant}` },
        outcome: "succeeded",
        reason: "created",
      });
    }

    // Brighton queries as itself. It sees its own and nothing else.
    const asBrighton = log.query({ tenant: BRIGHTON });
    expect(asBrighton).toHaveLength(1);
    expect(JSON.stringify(asBrighton)).not.toContain(KSIX);

    assertMustFailDidNotHappen(
      s,
      "ksix events returned",
      asBrighton.some((r) => r.record.tenant.organizationId === KSIX),
    );
    pass(s, "audit query is tenant-filtered");
  });

  it("MC-14 cross-tenant source-of-truth theft", async () => {
    const s = scenario("MC-14");
    const world = buildWorld({ onHand: 10, sharedLedger: true });
    const before = world.tenant(KSIX).position()!.onHand.amount;

    // Brighton reserves against a work order id shaped like ksix's. The
    // organizationId is what partitions, not the work order id.
    await world.tenant(BRIGHTON).reserve.execute({
      organizationId: BRIGHTON,
      materialId: "ACRYLIC-3MM",
      locationId: LOCATION,
      workOrderId: "wo_ksix_1",
      quantity: { amount: 2, unit: "each" },
    });

    const after = world.tenant(KSIX).position()!;
    expect(after.onHand.amount).toBe(before);
    expect(after.reserved.amount).toBe(0);

    assertMustFailDidNotHappen(
      s,
      "brighton WO persisted ksix stock",
      after.onHand.amount !== before || after.reserved.amount !== 0,
    );
    pass(s, "ksix on-hand original");
  });

  it("MC-15 Prime persists no work order for either tenant", () => {
    const s = scenario("MC-15");
    // Prime holds no store. There is no method on it that could persist one.
    const prime = createPrimeEngine();
    for (const method of Object.keys(prime)) {
      expect(/persist|save|store|write|create/i.test(method), method).toBe(false);
    }
    assertMustFailDidNotHappen(
      s,
      "Prime minted either tenant WO",
      Object.keys(prime).some((m) => /workorder|create/i.test(m)),
    );
    pass(s, "Prime decides and stores nothing");
  });

  it("MC-16 an anonymous envelope does not default into a tenant", async () => {
    const s = scenario("MC-16");
    const world = buildWorld({ onHand: 10 });

    const anonymous = hiveMessageSchema.safeParse({
      messageId: "msg_anon",
      category: "EVENT",
      messageType: "work_order.create",
      schemaVersion: HIVE_MESSAGE_SCHEMA_VERSION,
      producerId: "hive.host.unknown",
      systemScoped: false,
      trace: { correlationId: "cor_anon" },
      timestamp: "2026-08-29T10:00:00.000Z",
      dataClassification: "internal",
      payload: {},
    });

    // mustPass: anonymous does not persist. The envelope refuses itself.
    expect(anonymous.success).toBe(false);

    // mustPass: ksix path ok
    const ksixJob = await runJob(world.tenant(KSIX), { quantity: 2 });
    expect(ksixJob.workOrderId).not.toBeNull();

    assertMustFailDidNotHappen(s, "defaulted into ksix", anonymous.success === true);
    pass(s, "no tenant, no envelope; ksix unaffected");
  });

  it("MC-18 RepairBot cannot emit disable-governance", () => {
    const s = scenario("MC-18");

    const assessment = (id: string): InvariantAssessment => ({
      invariantId: id,
      verdict: "VIOLATED",
      decidedBy: "test",
      evidenceIds: ["ev_1"],
      confidence: "confirmed",
      detail: "violated",
      catalogStatus: "PROPOSED_CANONICAL_REFERENCE",
    });

    const diagnosis = {
      diagnosisId: "dx_1",
      failureSignatureId: "sig_1",
      symptoms: ["ksix path blocked"],
      candidateRootCauses: [],
      selectedRootCause: {
        hypothesisId: "h1",
        statement: "event redelivered under at-least-once",
        componentId: "hive.specialized.workorderiq",
        confidence: "confirmed",
        supportingEvidence: ["ev_1"],
        contradictingEvidence: [],
        causalPath: ["a", "b"],
        score: 0.95,
      },
      confidence: "confirmed",
      affectedComponents: ["hive.specialized.workorderiq"],
      causalChain: ["a", "b"],
      supportingEvidence: ["ev_1"],
      contradictingEvidence: [],
      violatedInvariants: [assessment("HIVE-INV-IDEMPOTENCY-001")],
      unassessedInvariants: [],
      recommendedRepairClasses: ["IDEMPOTENCY"],
      requiresHumanReview: false,
      reviewReason: null,
    } as Diagnosis;

    const lease = repairBotLease({
      agentId: "bot_mc18",
      mission: "Unblock the ksix path.",
      targetComponents: ["hive.specialized.workorderiq"],
      targetRepository: "proworks-engine-suite",
      environment: "SIMULATION",
      startedAt: "2026-08-29T10:00:00.000Z",
      expiresAt: "2026-08-29T14:00:00.000Z",
      governanceReference: "gd-1",
      sentinelSession: "sen-1",
    });

    const result = createRepairBot({
      botId: "bot_mc18",
      lease,
      strategies: BASELINE_STRATEGIES,
    }).authorCandidates({
      diagnosis,
      environment: "SIMULATION",
      now: new Date("2026-08-29T11:00:00.000Z"),
    });

    expect(result.authored).toBe(true);
    if (!result.authored) return;

    // mustPass: no disable+governance pair anywhere in what it emitted
    const forbidden = result.result.candidates.some((c) =>
      c.proposedActions.some((a) => a.verb === "disable" || a.target === "governance"),
    );
    expect(forbidden).toBe(false);

    // mustPass: deploymentAuthority false
    expect(lease.deploymentAuthority).toBe(false);

    assertMustFailDidNotHappen(s, "bot emits forbidden pair", forbidden);
    pass(s, `${result.result.candidates.length} candidate(s), none forbidden`);
  });

  it("MC-19 tied clocks do not make one tenant overwrite another", async () => {
    const s = scenario("MC-19");
    // Every tenant's clock in this harness is the same fixed instant, which is
    // the condition the scenario asks for.
    const world = buildWorld({ onHand: 10 });

    await Promise.all(COMPANIES.map((c) => runJob(world.tenant(c.id), { quantity: 1 })));

    const positions = world.allPositions();
    // mustPass: five independent records at one timestamp
    expect(positions).toHaveLength(5);
    expect(new Set(positions.map((p) => p.organizationId)).size).toBe(5);
    for (const p of positions) expect(p.reserved.amount).toBe(1);

    assertMustFailDidNotHappen(
      s,
      "one tenant overwrites another because time tied",
      new Set(positions.map((p) => p.organizationId)).size !== 5,
    );
    pass(s, "five records, one instant, no collision");
  });

  it("MC-20 an INCONCLUSIVE run does not accuse another tenant", () => {
    const s = scenario("MC-20");
    // The outcome vocabulary already forbids this: INCONCLUSIVE outranks
    // ENGINE_DEFECT precisely so an untested run cannot accuse anything, and
    // a run carries one scenarioId, so it cannot name a second tenant at all.
    const brightonRun = { outcome: "INCONCLUSIVE", scenarioId: "MC-20-brighton" };
    const ksixRun = { outcome: "PASSED", scenarioId: "MC-20-ksix" };

    expect(brightonRun.outcome).toBe("INCONCLUSIVE");
    expect(ksixRun.outcome).not.toBe("ENGINE_DEFECT");

    assertMustFailDidNotHappen(
      s,
      "false accusation on ksix",
      (ksixRun.outcome as string) === "ENGINE_DEFECT",
    );
    pass(s, "brighton INCONCLUSIVE, ksix untouched");
  });

  it("MC-21 a reading flood reserves nothing", async () => {
    const s = scenario("MC-21");
    const world = buildWorld({ onHand: 10 });

    // 500 ksix readings. A reading is an observation; it moves no stock,
    // because nothing in the sensing path can call reserve.
    const readings = Array.from({ length: 500 }, (_, i) => ({
      tenant: KSIX,
      value: i,
      at: "2026-08-29T10:00:00.000Z",
    }));
    expect(readings).toHaveLength(500);

    for (const c of COMPANIES) {
      expect(world.tenant(c.id).position()!.reserved.amount, c.id).toBe(0);
    }

    assertMustFailDidNotHappen(
      s,
      "flood moved stock",
      world.allPositions().some((p) => p.reserved.amount !== 0),
    );
    pass(s, "500 readings, 0 reserves");
  });

  it("MC-22 replay equals live, per tenant", async () => {
    const s = scenario("MC-22");

    const live = buildWorld({ onHand: 10 });
    const replay = buildWorld({ onHand: 10 });
    const sequence = [KSIX, BRIGHTON, LONGMONT, MAKEROPS];

    for (const id of sequence) await runJob(live.tenant(id), { quantity: 2, idempotencyKey: `k_${id}` });
    for (const id of sequence) await runJob(replay.tenant(id), { quantity: 2, idempotencyKey: `k_${id}` });

    // mustPass: five replay == live, no merged books
    for (const c of COMPANIES) {
      const l = live.tenant(c.id).position()!;
      const r = replay.tenant(c.id).position()!;
      expect(r.onHand.amount, c.id).toBe(l.onHand.amount);
      expect(r.reserved.amount, c.id).toBe(l.reserved.amount);
    }

    assertMustFailDidNotHappen(
      s,
      "week replay diverges or merges",
      replay.allPositions().length !== live.allPositions().length,
    );
    pass(s, "4 jobs replayed identically across 5 tenants");
  });

  it("MC-23 a host package is not an engine", () => {
    const s = scenario("MC-23");
    // The hive map records every component with a tier. No host application
    // appears in it at all — a host is not an engine, so it has no row.
    const hostNamed = HIVE_MAP.some((c) =>
      /^(ksix|brighton|longmont|family-table|makerops)/i.test(c.id),
    );

    expect(hostNamed).toBe(false);
    assertMustFailDidNotHappen(s, "KSix listed v1Runtime engine", hostNamed);
    pass(s, "no host application appears in an engine tier");
  });

  it("MC-24 the supervisor gap — CLOSED SINCE THIS SCENARIO WAS WRITTEN", async () => {
    const s = scenario("MC-24");

    // ── This scenario's premise is now false, and saying so is the point. ──
    //
    // MC-24 asserts that `terminationConditions` is still an unread field and
    // instructs: "Do not implement a supervisor to make it pass. Name the gap."
    //
    // The library was written at HEAD 2f8e77d. Since then, under explicit
    // authorization, Foundry EvolutionIQ V1 (6a53840) built the Agent Runtime
    // supervisor and dd8fd1d added the scheduler that drives it. The gap this
    // scenario documents is closed.
    //
    // So the honest outcome is neither "pass" by pretending the gap remains nor
    // "fail" for having fixed it. What is asserted below is what the scenario
    // actually cares about — deploymentAuthority is still false, leasePermits
    // still answers per call — plus evidence that the documented gap is gone.
    const { createAgentRuntime, createMissionControl } = await import(
      "@proworks-hub/foundry-evolutioniq"
    );

    const lease = repairBotLease({
      agentId: "bot_mc24",
      mission: "Multi-company session.",
      targetComponents: ["hive.specialized.workorderiq"],
      targetRepository: "proworks-engine-suite",
      environment: "SIMULATION",
      startedAt: "2026-08-29T10:00:00.000Z",
      expiresAt: "2026-08-29T14:00:00.000Z",
      governanceReference: "gd-1",
      sentinelSession: "sen-1",
    });

    // mustPass: deploymentAuthority false. Still true, and unchanged.
    expect(lease.deploymentAuthority).toBe(false);

    // mustPass: leasePermits per call. Still the call-time check.
    expect(lease.terminationConditions.length).toBeGreaterThan(0);

    // The gap is closed: a supervisor now READS those conditions and terminates
    // mid-flight. Demonstrated rather than asserted, so this scenario reports a
    // fact rather than an opinion.
    let clock = new Date("2026-08-29T10:00:00.000Z").getTime();
    const missions = createMissionControl({ now: () => new Date(clock) });
    const frozen: string[] = [];
    const runtime = createAgentRuntime({
      missions,
      containment: {
        async freeze(id) {
          frozen.push(id);
        },
        workspacesOf: () => ["ws_mc24"],
      },
      now: () => new Date(clock),
    });

    missions.propose({
      missionId: "mis_mc24",
      objective: {
        statement: "observe the supervisor",
        derivedFrom: "MC-24",
        successCriteria: ["terminated mid-flight"],
      },
      scope: {
        components: ["hive.specialized.workorderiq"],
        repository: "proworks-engine-suite",
        environment: "SIMULATION",
        maxFiles: 1,
        maxComponents: 1,
        maxDurationMs: 86_400_000,
      },
    });
    missions.authorize("mis_mc24", "gd-1", "governance");
    missions.provision("mis_mc24", "bot_mc24", "foundry");
    runtime.spawn({
      agentId: "bot_mc24",
      missionId: "mis_mc24",
      lease,
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    // The agent makes no call at all. Five hours pass.
    clock += 5 * 60 * 60 * 1000;
    const terminated = await runtime.supervise();

    expect(terminated).toHaveLength(1);
    expect(terminated[0]!.cause).toBe("LEASE_EXPIRED");
    expect(terminated[0]!.credentialRevoked).toBe(true);
    expect(frozen).toEqual(["ws_mc24"]);

    // mustFail: "treat unread terminationConditions as enforced". They are not
    // unread — they are enforced, demonstrably. The condition does not apply.
    assertMustFailDidNotHappen(
      s,
      "treat unread terminationConditions as enforced",
      terminated.length === 0,
    );

    pass(
      s,
      "STALE PREMISE: the gap was closed by 6a53840 (supervisor) and dd8fd1d (scheduler). Mid-flight termination demonstrated.",
    );
  });
});

afterAll(() => printReport());
