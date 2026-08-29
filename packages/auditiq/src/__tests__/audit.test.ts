// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import { AUDIT_CHAIN_GENESIS, type SealedAuditRecord } from "@proworks-hub/contracts";

import { createAuditIq } from "../audit.js";

// ─────────────────────────────────────────────────────────────────────────────
// Charter: "What happened, who or what acted, under what authority, and what
// result followed?" — tamper-evident, append-only, and owning no adjudication.
// ─────────────────────────────────────────────────────────────────────────────

let counter = 0;
const audit = () =>
  createAuditIq({ instance: { globalInstanceId: "hive.ksix.us-east", provisional: false },
    now: () => new Date("2026-08-29T10:00:00.000Z"),
    generateId: () => `aud_${(counter += 1)}`,
  });

const evidence = (over: Record<string, unknown> = {}) => ({
  actor: { actorId: "steven", kind: "human" as const },
  tenant: { organizationId: "ksix", roles: [] },
  component: "hive.inventoryiq",
  action: "material.reserved",
  target: { type: "work_order", id: "wo-1" },
  trace: { correlationId: "cor-1" },
  outcome: "succeeded" as const,
  reason: "Four sheets held for work order wo-1.",
  ...over,
});

describe("evidence answers the charter's question", () => {
  it("records who acted, on what, under what authority, with what result", () => {
    const log = audit();
    const result = log.record(
      evidence({ governanceDecisionId: "gd-1", policyId: "policy.migration", executionId: "exec-1" }),
    );

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.sealed.record).toMatchObject({
      actor: { actorId: "steven" },
      component: "hive.inventoryiq",
      action: "material.reserved",
      governanceDecisionId: "gd-1",
      outcome: "succeeded",
    });
  });

  it("requires a reason even when the action succeeded", () => {
    // Evidence that records only failures answers "what went wrong", not
    // "what happened".
    expect(audit().record(evidence({ reason: "" })).accepted).toBe(false);
  });

  it("requires a denial to reference the decision that denied it", () => {
    // A denial with no traceable decision cannot be reviewed, appealed, or
    // told apart from a fault.
    const withoutDecision = audit().record(evidence({ outcome: "denied" }));
    expect(withoutDecision.accepted).toBe(false);
    if (!withoutDecision.accepted) expect(withoutDecision.reason).toContain("governanceDecisionId");

    const withDecision = audit().record(
      evidence({ outcome: "denied", governanceDecisionId: "gd-9" }),
    );
    expect(withDecision.accepted).toBe(true);
  });

  it("records a denial at all — nothing happened, and that is the point", () => {
    const log = audit();
    log.record(evidence({ outcome: "denied", governanceDecisionId: "gd-2", reason: "Not in the grant." }));
    expect(log.query({ outcome: "denied" })).toHaveLength(1);
  });

  it("refuses rather than throwing", () => {
    // An audit write that throws is eventually wrapped in a try/catch that
    // swallows it, and silently unrecorded evidence is worse than a refusal.
    const log = audit();
    expect(() => log.record({ nonsense: true })).not.toThrow();
    expect(log.count()).toBe(0);
  });

  it("reports refusals to an observer", () => {
    // A run of rejected writes means something is emitting malformed evidence,
    // and nobody would otherwise see it.
    const rejected: string[] = [];
    createAuditIq({ instance: { globalInstanceId: "hive.ksix.us-east", provisional: false }, onRejected: (reason) => rejected.push(reason) }).record({ bad: true });
    expect(rejected).toHaveLength(1);
  });
});

describe("the chain is tamper-evident", () => {
  const withThree = () => {
    const log = audit();
    log.record(evidence({ action: "a.one" }));
    log.record(evidence({ action: "a.two" }));
    log.record(evidence({ action: "a.three" }));
    return log;
  };

  it("starts at a known genesis", () => {
    const log = audit();
    const first = log.record(evidence());
    expect(first.accepted && first.sealed.previousHash).toBe(AUDIT_CHAIN_GENESIS);
  });

  it("links each record to the one before", () => {
    const log = withThree();
    const [a, b, c] = log.query();
    expect(b!.previousHash).toBe(a!.hash);
    expect(c!.previousHash).toBe(b!.hash);
  });

  it("verifies an untouched chain", () => {
    const result = withThree().verify();
    expect(result.intact).toBe(true);
    expect(result.recordsChecked).toBe(3);
  });

  it("hashes the same content identically regardless of key order", () => {
    // Without canonical ordering the same record hashes two ways, and the
    // chain would break on a re-serialization rather than on tampering.
    //
    // The first version of this test spread `evidence()` AFTER the field it was
    // varying, which overwrote it — the two objects were identical and the test
    // proved nothing. These are built field by field in opposite orders.
    const forward = {
      auditEventId: "aud_fixed",
      occurredAt: "2026-08-29T10:00:00.000Z",
      actor: { actorId: "steven", kind: "human" as const },
      tenant: { organizationId: "ksix", roles: [] },
      component: "hive.inventoryiq",
      action: "material.reserved",
      trace: { correlationId: "cor-1" },
      outcome: "succeeded" as const,
      reason: "Four sheets held.",
    };
    const reversed = {
      reason: "Four sheets held.",
      outcome: "succeeded" as const,
      trace: { correlationId: "cor-1" },
      action: "material.reserved",
      component: "hive.inventoryiq",
      tenant: { roles: [], organizationId: "ksix" },
      actor: { kind: "human" as const, actorId: "steven" },
      occurredAt: "2026-08-29T10:00:00.000Z",
      auditEventId: "aud_fixed",
    };

    const a = audit().record(forward);
    const b = audit().record(reversed);
    expect(a.accepted).toBe(true);
    expect(b.accepted).toBe(true);
    if (!a.accepted || !b.accepted) return;
    expect(a.sealed.hash).toBe(b.sealed.hash);
  });

  it("gives different content different hashes", () => {
    const a = audit().record(evidence({ action: "a.one" }));
    const b = audit().record(evidence({ action: "a.two" }));
    expect(a.accepted && b.accepted && a.sealed.hash !== b.sealed.hash).toBe(true);
  });
});

describe("the store cannot be edited through what it hands out", () => {
  it("returns frozen records", () => {
    const log = audit();
    const result = log.record(evidence());
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(Object.isFrozen(result.sealed)).toBe(true);
  });

  it("does not let a query result mutate the store", () => {
    // Returning stored objects would let a caller alter evidence after it was
    // sealed — the hash was computed before the mutation, so the chain would
    // still verify against a record nobody wrote.
    const log = audit();
    log.record(evidence({ action: "original.action" }));

    const [copy] = log.query() as SealedAuditRecord[];
    try {
      (copy!.record as { action: string }).action = "tampered";
    } catch {
      // Frozen — also acceptable, and the stronger outcome.
    }

    expect(log.query()[0]!.record.action).toBe("original.action");
    expect(log.verify().intact).toBe(true);
  });

  it("exposes no update, delete or redact method", () => {
    // Not "they throw" — they do not exist. An interface offering the method
    // invites somebody to reach for it during an incident, which is the worst
    // possible moment. Retention and lawful erasure are real and need a
    // separately authorized compensating operation with its own evidence.
    const log = audit();
    // An exact surface, so an addition is a decision somebody makes here
    // rather than something that appears. `durability` was added when the
    // store became a port: it is a read-only accessor saying whether the
    // bound store survives a restart, which is the opposite of a mutation —
    // and the list below is what keeps that distinction from being assumed.
    expect(Object.keys(log).sort()).toEqual(["count", "durability", "query", "record", "verify"]);

    // The claim that actually matters, stated independently of the list.
    for (const forbidden of ["update", "delete", "redact", "remove", "purge", "truncate"]) {
      expect(Object.keys(log)).not.toContain(forbidden);
    }
  });
});

describe("query narrows without leaking", () => {
  const populated = () => {
    const log = audit();
    log.record(evidence({ action: "a.one", component: "hive.costiq" }));
    log.record(evidence({ action: "a.two", tenant: { organizationId: "other", roles: [] } }));
    log.record(evidence({ action: "a.three", outcome: "failed", reason: "ledger unreachable" }));
    return log;
  };

  it("filters by tenant", () => {
    expect(populated().query({ tenant: "ksix" })).toHaveLength(2);
  });

  it("filters by component, action and outcome", () => {
    const log = populated();
    expect(log.query({ component: "hive.costiq" })).toHaveLength(1);
    expect(log.query({ action: "a.two" })).toHaveLength(1);
    expect(log.query({ outcome: "failed" })).toHaveLength(1);
  });

  it("filters by correlation, so one workflow can be reconstructed", () => {
    expect(populated().query({ correlationId: "cor-1" })).toHaveLength(3);
  });

  it("honours a limit", () => {
    expect(populated().query({ limit: 2 })).toHaveLength(2);
  });

  it("returns everything when unfiltered", () => {
    expect(populated().query()).toHaveLength(3);
  });
});

describe("AuditIQ owns evidence, not judgement", () => {
  it("stores no verdict, guilt or adjudication field", () => {
    // Charter non-ownership: "constitutional guilt, security adjudication,
    // domain source records, or the authority decisions that produced the
    // recorded action."
    const log = audit();
    const result = log.record(evidence({ governanceDecisionId: "gd-1" }));
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;

    const keys = Object.keys(result.sealed.record);
    for (const forbidden of ["verdict", "guilt", "judgement", "adjudication", "decision"]) {
      expect(keys.some((k) => k.toLowerCase() === forbidden), forbidden).toBe(false);
    }
    // A decision REFERENCE is present and is not the decision.
    expect(result.sealed.record.governanceDecisionId).toBe("gd-1");
  });

  it("keeps detail to flat, non-sensitive values", () => {
    // A nested object is where a payload gets attached. The charter's guidance
    // is to reference protected content, not copy it into evidence.
    expect(audit().record(evidence({ detail: { sheets: 4, rush: true } })).accepted).toBe(true);
    expect(
      audit().record(evidence({ detail: { customer: { name: "Dana", email: "d@x.com" } } })).accepted,
    ).toBe(false);
  });
});
