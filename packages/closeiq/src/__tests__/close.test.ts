// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { GovernanceDecision } from "@proworks-hub/contracts";

import { createCloseEngine, type CallContext } from "../engine.js";
import { satisfies } from "../kernel/evidence.js";
import { determineCutOff } from "../kernel/reconciliation.js";
import { validateTemplate } from "../kernel/tasks.js";
import {
  ADJUSTMENT_TRANSITIONS,
  adjustmentStateSchema,
  TERMINAL_ADJUSTMENT_STATES,
  type BalanceObservation,
  type CloseEvidenceRef,
  type CloseProfile,
  type CloseTemplate,
} from "../model.js";

const usd = (amount: string) => ({ amount, currency: "USD", scale: 2 });

const quality = (sourceStrength = "observed-local" as const) => ({
  coverage: "adequate" as const,
  freshness: "adequate" as const,
  sourceStrength,
  sampleSufficiency: "adequate" as const,
  normalizationQuality: "adequate" as const,
  assumptionLoad: "light" as const,
  historicalReliability: "unknown" as const,
});

const evidence = (id: string, overrides?: Partial<CloseEvidenceRef>): CloseEvidenceRef => ({
  evidenceId: id,
  kind: "reconciliation-result",
  target: `target-${id}`,
  quality: quality(),
  observedAt: "2026-08-28",
  producedBy: "system.recon",
  ...overrides,
});

const ctx = (asOf = "2026-08-30", org = "org-1"): CallContext => ({
  tenant: { organizationId: org, roles: [] },
  trace: { correlationId: "c-1" },
  asOf,
});

const permitted = (decisionId: string): GovernanceDecision => ({
  decision: "PERMITTED",
  reason: "fixture",
  conditions: [],
  decisionId,
  decidedAt: "2026-08-30T00:00:00Z",
});

const REQUIREMENT = {
  requirementId: "req-1",
  clauses: [
    { kind: "reconciliation-result" as const, minCount: 1, minSourceStrength: "derived" as const },
  ],
  attestationSufficient: false,
};

const TEMPLATE: CloseTemplate = {
  templateId: "tmpl-monthly",
  semanticVersion: "1.0.0",
  tasks: [
    {
      taskDefinitionId: "t-recs",
      semanticVersion: "1.0.0",
      name: "Complete reconciliations",
      taskClass: "manual",
      criticality: "blocking",
      owner: "human.alice",
      predecessors: [],
      dueOffsetWorkDays: 2,
      evidenceRequirement: REQUIREMENT,
    },
    {
      taskDefinitionId: "t-review",
      semanticVersion: "1.0.0",
      name: "Review reconciliations",
      taskClass: "review",
      criticality: "required",
      owner: "human.bob",
      reviewer: "human.bob",
      predecessors: ["t-recs"],
      dueOffsetWorkDays: 3,
      evidenceRequirement: REQUIREMENT,
    },
  ],
};

const PRODUCIBLE = ["reconciliation-result", "human-attestation", "ledger-event"] as const;

function engine(overrides?: { materialityThresholdMinor?: bigint }) {
  return createCloseEngine({
    currencyRegistry: { USD: 2, EUR: 2 },
    producibleEvidenceKinds: [...PRODUCIBLE],
    ...(overrides?.materialityThresholdMinor !== undefined
      ? { materialityThresholdMinor: overrides.materialityThresholdMinor }
      : {}),
  });
}

describe("template validation — refused at load, not warned", () => {
  it("refuses a cycle", () => {
    const cyclic: CloseTemplate = {
      ...TEMPLATE,
      tasks: [
        { ...TEMPLATE.tasks[0]!, predecessors: ["t-review"] },
        TEMPLATE.tasks[1]!,
      ],
    };
    const outcome = validateTemplate(cyclic, [...PRODUCIBLE]);
    expect(!outcome.ok && outcome.refusal.kind).toBe("dag-invalid");
  });
  it("refuses a task depending on a nonexistent predecessor", () => {
    const orphan: CloseTemplate = {
      ...TEMPLATE,
      tasks: [{ ...TEMPLATE.tasks[0]!, predecessors: ["t-ghost"] }],
    };
    const outcome = validateTemplate(orphan, [...PRODUCIBLE]);
    expect(!outcome.ok && outcome.refusal.kind).toBe("unreachable-task");
  });
  it("refuses an evidence requirement nothing can ever produce", () => {
    const orphaned: CloseTemplate = {
      ...TEMPLATE,
      tasks: [
        {
          ...TEMPLATE.tasks[0]!,
          evidenceRequirement: {
            requirementId: "req-x",
            clauses: [{ kind: "consolidation-run", minCount: 1, minSourceStrength: "derived" }],
            attestationSufficient: false,
          },
        },
      ],
    };
    const outcome = validateTemplate(orphaned, [...PRODUCIBLE]);
    expect(!outcome.ok && outcome.refusal.kind).toBe("orphaned-evidence-requirement");
  });
});

describe("M-1 satisfaction — LOCK-2 as arithmetic, attestation gating, acyclicity", () => {
  const context = { subjectId: "task-1", controlPopulations: new Map() };
  it("an ai-candidate can never satisfy a clause — it ranks below the derived floor", () => {
    const outcome = satisfies(
      REQUIREMENT,
      [evidence("e1", { quality: quality("ai-candidate" as never) })],
      "2026-08-30",
      context,
    );
    expect(outcome.satisfied).toBe(false);
    if (!outcome.satisfied) {
      expect(outcome.unmet[0]?.drops[0]).toContain("ranks below");
    }
  });
  it("an attestation is dropped entirely when attestationSufficient is false", () => {
    const requirement = {
      requirementId: "req-a",
      clauses: [{ kind: "human-attestation" as const, minCount: 1, minSourceStrength: "collective-generalized" as const }],
      attestationSufficient: false,
    };
    const outcome = satisfies(
      requirement,
      [evidence("e1", { kind: "human-attestation" })],
      "2026-08-30",
      context,
    );
    expect(outcome.satisfied).toBe(false);
  });
  it("stale evidence is dropped against the EXPLICIT asOf", () => {
    const requirement = {
      ...REQUIREMENT,
      clauses: [{ ...REQUIREMENT.clauses[0]!, maxAgeDays: 5 }],
    };
    const outcome = satisfies(
      requirement,
      [evidence("e1", { observedAt: "2026-08-01" })],
      "2026-08-30",
      context,
    );
    expect(outcome.satisfied).toBe(false);
  });
  it("self-supporting control evidence is not evidence; unresolvable population is UNMET, not assumed acyclic", () => {
    const requirement = {
      requirementId: "req-c",
      clauses: [{ kind: "control-test-result" as const, minCount: 1, minSourceStrength: "derived" as const }],
      attestationSufficient: false,
    };
    const selfRef = evidence("e1", { kind: "control-test-result", target: "ctl-1" });
    const cyclic = satisfies(requirement, [selfRef], "2026-08-30", {
      subjectId: "task-1",
      controlPopulations: new Map([["ctl-1", ["task-1"]]]),
    });
    expect(cyclic.satisfied).toBe(false);
    const unbound = satisfies(requirement, [selfRef], "2026-08-30", { subjectId: "task-1" });
    expect(unbound.satisfied).toBe(false);
    if (!unbound.satisfied) expect(unbound.unmet[0]?.drops[0]).toContain("unbound");
    const clean = satisfies(requirement, [selfRef], "2026-08-30", {
      subjectId: "task-1",
      controlPopulations: new Map([["ctl-1", ["something-else"]]]),
    });
    expect(clean.satisfied).toBe(true);
  });
});

describe("the task lifecycle — evidence-gated completion, waiver is not completion", () => {
  function setup() {
    const e = engine({ materialityThresholdMinor: 100n });
    const instantiated = e.instantiateClose(
      {
        template: TEMPLATE,
        periodRef: { fiscalYear: 2026, periodNumber: 8 },
        entityScope: ["entity-a"],
        closeDayZero: "2026-09-01",
      },
      ctx(),
    );
    if (!instantiated.ok) throw new Error("fixture");
    return { e, tasks: instantiated.value.tasks };
  }

  it("blocks the dependent task until the predecessor completes; completion demands satisfying evidence", () => {
    const { e, tasks } = setup();
    const recTask = tasks[0]!.closeTaskId;
    const reviewTask = tasks[1]!.closeTaskId;
    const blocked = e.startTask({ taskId: reviewTask, by: "human.bob" }, ctx());
    expect(!blocked.ok && blocked.refusal.kind).toBe("predecessors-unmet");
    const noEvidence = e.completeTask({ taskId: recTask, evidence: [], by: "human.alice" }, ctx());
    expect(!noEvidence.ok && noEvidence.refusal.kind).toBe("evidence-unsatisfied");
    const completed = e.completeTask(
      { taskId: recTask, evidence: [evidence("e1")], by: "human.alice" },
      ctx(),
    );
    expect(completed.ok).toBe(true);
    if (completed.ok && completed.value.status === "completed") {
      expect(completed.value.evidence).toHaveLength(1);
      expect(completed.value.satisfaction.perClause[0]?.satisfiedBy).toEqual(["e1"]);
    }
  });

  it("a review task refuses the preparer reviewing their own work", () => {
    const { e, tasks } = setup();
    const recTask = tasks[0]!.closeTaskId;
    const reviewTask = tasks[1]!.closeTaskId;
    e.completeTask({ taskId: recTask, evidence: [evidence("e1")], by: "human.bob" }, ctx());
    const selfReview = e.completeTask(
      { taskId: reviewTask, evidence: [evidence("e2")], by: "human.bob" },
      ctx(),
    );
    expect(!selfReview.ok && selfReview.refusal.kind).toBe("self-authorization");
  });

  it("a waiver needs a human, a reason and a permitted decision; it records the unmet requirement and never reads as completed", () => {
    const { e, tasks } = setup();
    const recTask = tasks[0]!.closeTaskId;
    const notHuman = e.waiveTask(
      { taskId: recTask, by: "engine.closeiq", reason: "hurry", governance: permitted("g1") },
      ctx(),
    );
    expect(!notHuman.ok && notHuman.refusal.kind).toBe("not-a-human");
    expect(!notHuman.ok && notHuman.refusal.detail).toContain("engine identity");
    const noReason = e.waiveTask(
      { taskId: recTask, by: "human.carol", reason: "  ", governance: permitted("g1") },
      ctx(),
    );
    expect(!noReason.ok && noReason.refusal.kind).toBe("empty-reason");
    const waived = e.waiveTask(
      { taskId: recTask, by: "human.carol", reason: "bank feed outage", governance: permitted("g1") },
      ctx(),
    );
    expect(waived.ok).toBe(true);
    if (waived.ok && waived.value.status === "waived") {
      expect(waived.value.unmetRequirement.requirementId).toBe("req-1");
    }
    expect(e.listWaivers(ctx())).toHaveLength(1);
    // A blocking task that was WAIVED does not pass G1 and blocks sign-off.
    const readiness = e.assessReadiness({ closePeriodId: "close:org-1:2026-8" }, ctx());
    expect(readiness.ok && readiness.value.gates[0]?.outcome).toBe("fail");
  });

  it("a governance decision cannot be replayed onto a second item", () => {
    const { e, tasks } = setup();
    e.waiveTask(
      { taskId: tasks[0]!.closeTaskId, by: "human.carol", reason: "outage", governance: permitted("g-same") },
      ctx(),
    );
    const replayed = e.waiveTask(
      { taskId: tasks[1]!.closeTaskId, by: "human.carol", reason: "outage", governance: permitted("g-same") },
      ctx(),
    );
    expect(!replayed.ok && replayed.refusal.kind).toBe("replayed-authorization");
  });
});

describe("reconciliation — three facts, the honesty states", () => {
  const observation = (source: BalanceObservation["source"], amount: string): BalanceObservation => ({
    source,
    balance: usd(amount),
    asOf: "2026-08-31",
    provenance: `prov-${source}`,
    quality: quality(),
  });

  it("fewer than two observations is unsubstantiated-unknown with NO difference — not zero", () => {
    const e = engine();
    const outcome = e.computeReconciliation(
      {
        reconciliationId: "rec-1",
        closePeriodId: "cp-1",
        accountRef: "1000",
        observations: [observation("ledger", "500.00")],
      },
      ctx(),
    );
    expect(outcome.ok && outcome.value.state).toBe("unsubstantiated-unknown");
    expect(outcome.ok && outcome.value.difference).toBeUndefined();
  });
  it("balanced, explained, unexplained and rounding-indeterminate are distinct", () => {
    const e = engine();
    const run = (id: string, ledger: string, sub: string, items: string[] = []) =>
      e.computeReconciliation(
        {
          reconciliationId: id,
          closePeriodId: "cp-1",
          accountRef: "1000",
          observations: [observation("ledger", ledger), observation("sub-ledger", sub)],
          reconcilingItems: items.map((amount, i) => ({
            itemId: `ri-${i}`,
            description: "in transit",
            amount: usd(amount),
            identifiedOn: "2026-08-15",
            disposition: "expected-timing" as const,
          })),
        },
        ctx(),
      );
    const balanced = run("r1", "500.00", "500.00");
    expect(balanced.ok && balanced.value.state).toBe("balanced");
    const explained = run("r2", "500.00", "450.00", ["50.00"]);
    expect(explained.ok && explained.value.state).toBe("explained-difference");
    const unexplained = run("r3", "500.00", "450.00");
    expect(unexplained.ok && unexplained.value.state).toBe("unexplained-difference");
    expect(unexplained.ok && unexplained.value.difference?.amount).toBe("50.00");
    // One minor unit: arithmetic noise, not a difference to chase (TD-9).
    const noise = run("r4", "500.00", "499.99");
    expect(noise.ok && noise.value.state).toBe("rounding-indeterminate");
  });
  it("refuses an unregistered currency rather than assuming a scale", () => {
    const e = engine();
    const outcome = e.computeReconciliation(
      {
        reconciliationId: "r1",
        closePeriodId: "cp-1",
        accountRef: "1000",
        observations: [
          { source: "ledger", balance: { amount: "100", currency: "JPY", scale: 0 }, asOf: "2026-08-31", provenance: "p", quality: quality() },
          { source: "sub-ledger", balance: { amount: "100", currency: "JPY", scale: 0 }, asOf: "2026-08-31", provenance: "p", quality: quality() },
        ],
      },
      ctx(),
    );
    expect(!outcome.ok && outcome.refusal.kind).toBe("unknown-currency-scale");
  });
});

describe("auto-certification — candidates, conservatism, governance-bound rules", () => {
  const profile: CloseProfile = {
    profileId: "p1",
    accountRef: "1000",
    riskTier: "low",
    requiredFrequency: "monthly",
    requiredReviewLevel: 0,
    evidenceRequirement: REQUIREMENT,
    autoCertifiable: true,
    agedItemLimitDays: 30,
  };
  function reconcile(e: ReturnType<typeof engine>, ledger: string, sub: string) {
    const outcome = e.computeReconciliation(
      {
        reconciliationId: "rec-1",
        closePeriodId: "cp-1",
        accountRef: "1000",
        observations: [
          { source: "ledger", balance: usd(ledger), asOf: "2026-08-31", provenance: "p", quality: quality() },
          { source: "sub-ledger", balance: usd(sub), asOf: "2026-08-31", provenance: "p", quality: quality() },
        ],
      },
      ctx(),
    );
    if (!outcome.ok) throw new Error("fixture");
    return outcome.value;
  }

  it("an unknown tier blocks auto-certification entirely", () => {
    const e = engine({ materialityThresholdMinor: 100n });
    reconcile(e, "0.00", "0.00");
    const outcome = e.proposeCertification(
      { reconciliationId: "rec-1", profile: { ...profile, riskTier: "unknown" }, ruleId: "zero-balance" },
      ctx(),
    );
    expect(!outcome.ok && outcome.refusal.kind).toBe("tier-unknown");
  });
  it("within-threshold is inoperable without materiality — no fallback threshold", () => {
    const e = engine(); // no materiality bound
    reconcile(e, "500.00", "499.50");
    const outcome = e.proposeCertification(
      { reconciliationId: "rec-1", profile, ruleId: "within-threshold" },
      ctx(),
    );
    expect(!outcome.ok && outcome.refusal.kind).toBe("materiality-unbound");
  });
  it("a candidate certifies only under a grant naming the rule AND version; a changed balance voids", () => {
    const e = engine({ materialityThresholdMinor: 10000n });
    reconcile(e, "500.00", "499.50");
    const candidate = e.proposeCertification(
      { reconciliationId: "rec-1", profile, ruleId: "within-threshold" },
      ctx(),
    );
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    const wrongRule = e.certify(
      {
        candidateId: candidate.value.candidateId,
        governance: permitted("g1"),
        grantedRule: { methodId: "close.autocertification.zero-balance", semanticVersion: "1.0.0" },
        by: "system.autocert",
      },
      ctx(),
    );
    expect(!wrongRule.ok && wrongRule.refusal.kind).toBe("not-permitted");
    // A grant binds to the rule AND ITS VERSION: the right methodId at the
    // wrong version refuses. (Mutation CONTROL-grant-version-dropped survived
    // until this — the methodId check masked the version check.)
    const wrongVersion = e.certify(
      {
        candidateId: candidate.value.candidateId,
        governance: permitted("g1b"),
        grantedRule: { methodId: candidate.value.ruleRef.methodId, semanticVersion: "9.9.9" },
        by: "system.autocert",
      },
      ctx(),
    );
    expect(!wrongVersion.ok && wrongVersion.refusal.kind).toBe("not-permitted");
    const certified = e.certify(
      {
        candidateId: candidate.value.candidateId,
        governance: permitted("g1"),
        grantedRule: candidate.value.ruleRef,
        by: "system.autocert",
      },
      ctx(),
    );
    expect(certified.ok).toBe(true);
    // The balance changes → certification-void, prior record retained.
    const changed = e.computeReconciliation(
      {
        reconciliationId: "rec-1",
        closePeriodId: "cp-1",
        accountRef: "1000",
        observations: [
          { source: "ledger", balance: usd("600.00"), asOf: "2026-09-01", provenance: "p", quality: quality() },
          { source: "sub-ledger", balance: usd("600.00"), asOf: "2026-09-01", provenance: "p", quality: quality() },
        ],
      },
      ctx("2026-09-01"),
    );
    expect(changed.ok && changed.value.state).toBe("certification-void");
    expect(changed.ok && changed.value.certification).toBeDefined();
  });
});

describe("M-6 cut-off — the grace window is read and recorded", () => {
  const rule = {
    ruleId: "rev-cutoff",
    transactionClass: "revenue" as const,
    governingDateField: "shipmentDate",
    cutOffDate: "2026-08-31",
    graceWindowDays: 2,
    methodRef: { methodId: "close.cutoff.determination", semanticVersion: "1.0.0" },
  };
  it("a governing date inside the widened window recorded in-period is NOT a finding; outside it is", () => {
    const inside = determineCutOff(
      rule,
      { subjectRef: "ship-1", governingDate: "2026-09-01", recordedInPeriod: true, amount: usd("100.00") },
      "2026-08-01",
      "2026-08-31",
    );
    expect(inside).toBeUndefined(); // within cutOff + 2 grace days
    const outside = determineCutOff(
      rule,
      { subjectRef: "ship-2", governingDate: "2026-09-05", recordedInPeriod: true, amount: usd("100.00") },
      "2026-08-01",
      "2026-08-31",
    );
    expect(outside?.graceWindowDaysApplied).toBe(2);
  });
});

describe("sign-off and the ledger boundary", () => {
  it("sign-off refuses stale fingerprints and incomplete blocking tasks; close is REQUESTED, outcome recorded verbatim", () => {
    const e = engine({ materialityThresholdMinor: 100n });
    const instantiated = e.instantiateClose(
      {
        template: TEMPLATE,
        periodRef: { fiscalYear: 2026, periodNumber: 8 },
        entityScope: ["entity-a"],
        closeDayZero: "2026-09-01",
      },
      ctx(),
    );
    if (!instantiated.ok) throw new Error("fixture");
    const closePeriodId = instantiated.value.closePeriod.closePeriodId;
    const [rec, review] = instantiated.value.tasks;

    const early = e.recordSignOff(
      { closePeriodId, by: "human.cfo", statement: "closed", readinessFingerprint: "x", governance: permitted("g1") },
      ctx(),
    );
    expect(!early.ok && early.refusal.kind).toBe("blocking-incomplete");

    e.completeTask({ taskId: rec!.closeTaskId, evidence: [evidence("e1")], by: "human.alice" }, ctx());
    e.completeTask({ taskId: review!.closeTaskId, evidence: [evidence("e2")], by: "human.bob" }, ctx());
    const readiness = e.assessReadiness({ closePeriodId }, ctx());
    expect(readiness.ok && readiness.value.verdict).toBe("ready");
    const fingerprint = readiness.ok ? readiness.value.readinessFingerprint : "";

    const stale = e.recordSignOff(
      { closePeriodId, by: "human.cfo", statement: "closed", readinessFingerprint: "old", governance: permitted("g2") },
      ctx(),
    );
    expect(!stale.ok && stale.refusal.kind).toBe("stale-fingerprint");

    const signed = e.recordSignOff(
      { closePeriodId, by: "human.cfo", statement: "August close complete", readinessFingerprint: fingerprint, governance: permitted("g3") },
      ctx(),
    );
    expect(signed.ok).toBe(true);

    const requested = e.requestPeriodClose({ closePeriodId }, ctx());
    expect(requested.ok).toBe(true);
    // ledger-closed is LEDGERIQ's answer, never inferred.
    const outcome = e.recordPeriodCloseOutcome({ closePeriodId, outcome: "refused", refusalDetail: "EARLIER_PERIOD_OPEN" }, ctx());
    expect(outcome.ok && outcome.value.processState).toBe("ledger-close-refused");
  });

  it("undeterminable beats not-ready: unbound materiality makes G4 undeterminable and hides percentComplete", () => {
    const e = engine(); // materiality unbound
    const instantiated = e.instantiateClose(
      {
        template: TEMPLATE,
        periodRef: { fiscalYear: 2026, periodNumber: 8 },
        entityScope: ["entity-a"],
        closeDayZero: "2026-09-01",
      },
      ctx(),
    );
    if (!instantiated.ok) throw new Error("fixture");
    const readiness = e.assessReadiness(
      { closePeriodId: instantiated.value.closePeriod.closePeriodId },
      ctx(),
    );
    expect(readiness.ok && readiness.value.verdict).toBe("undeterminable");
    expect(readiness.ok && readiness.value.percentComplete).toBeUndefined();
  });
});

describe("the adjustment state machine — every state exits or is declared terminal", () => {
  it("walks the table; the held state has an exit through the M-7 ladder", () => {
    for (const state of adjustmentStateSchema.options) {
      const hasExit = ADJUSTMENT_TRANSITIONS.some((t) => t.from === state);
      const terminal = TERMINAL_ADJUSTMENT_STATES.includes(state);
      expect(hasExit || terminal, state).toBe(true);
      expect(hasExit && terminal, state).toBe(false);
    }
  });
  it("authorization requires human + reason + governance, refuses the preparer, and consumes the decision", () => {
    const e = engine({ materialityThresholdMinor: 100n });
    const advance = (to: string, by = "human.dana", governance?: GovernanceDecision, reason?: string) =>
      e.transitionAdjustment(
        {
          adjustmentRequestId: "adj-1",
          to: to as never,
          by,
          ...(reason !== undefined ? { reason } : {}),
          ...(governance !== undefined ? { governance } : {}),
        },
        ctx(),
      );
    advance("drafted", "human.alice");
    advance("evidence-attached");
    advance("reviewed");
    advance("awaiting-human-authorization");
    const selfAuth = advance("authorized", "human.alice", permitted("g1"), "approved");
    expect(!selfAuth.ok && selfAuth.refusal.kind).toBe("self-authorization");
    const authorized = advance("authorized", "human.dana", permitted("g1"), "approved");
    expect(authorized.ok).toBe(true);
    const illegal = advance("drafted");
    expect(!illegal.ok && illegal.refusal.kind).toBe("wrong-state");
  });
});

// ── Guards ──────────────────────────────────────────────────────────────────

const SRC = join(process.cwd(), "packages/closeiq/src");
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}
const files = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("guards", () => {
  it("imports only contracts, core-kit and zod; no clock; no bypass surface", () => {
    for (const f of files) {
      expect(/(?:from|import)\s+"@proworks-hub\/(?!contracts|core-kit)[a-z-]+/.test(f.text), f.path).toBe(false);
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random|crypto\.randomUUID/.test(f.text), f.path).toBe(false);
      expect(/\b(force|skipValidation)\s*[?:]|\boverride\s*\?\s*:/.test(f.text), f.path).toBe(false);
      expect(/postEntry|writeJournal|appendJournal|postToLedger/.test(f.text), f.path).toBe(false);
    }
  });
  it("no rolled-up close health score exists anywhere — recorded so it is not proposed", () => {
    for (const f of files) {
      expect(/healthScore|closeScore|readinessScore/.test(f.text), f.path).toBe(false);
    }
  });
});
