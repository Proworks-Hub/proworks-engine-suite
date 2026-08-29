// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  createCollectiveLedger,
  createInstanceLedger,
  escalationSchema,
  ledgerEntryGrantsAuthority,
  localRetentionErasesCollective,
  type CollectiveLedger,
  type InstanceLedger,
} from "@proworks-hub/auditiq";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — the execution ledger.
//
// The six acceptance tests the ledger architecture names, each written as the
// thing that must NOT happen, plus the positives that keep them from being
// vacuous:
//
//   1. A tenant cannot read another tenant's ledger.
//   2. Collective operators cannot replay a tenant workflow unauthorized.
//   3. Tampering with an old entry is detectable.
//   4. Replay creates a new trace and cannot duplicate critical effects.
//   5. Escalated records include provenance and sanitization status.
//   6. Local retention deletion does not erase collective records.
//
// The hash chain, append-only storage and refusal-not-throw behaviour are
// AuditIQ's and already tested. What is new is the separation between the two
// ledgers, and most of this file is about the wall.
// ─────────────────────────────────────────────────────────────────────────────

const INSTANCE_A = { globalInstanceId: "hive.ksix.us-east", provisional: false };
const COLLECTIVE = { globalInstanceId: "hive.collective", provisional: false };
const NOW = () => new Date("2026-08-29T12:00:00.000Z");

let seq = 0;
const ids = () => `aud_${(seq += 1)}`;

const instanceLedger = (): InstanceLedger =>
  createInstanceLedger({ instance: INSTANCE_A, now: NOW, generateId: ids });

const collectiveLedger = (): CollectiveLedger =>
  createCollectiveLedger({ collectiveId: COLLECTIVE, now: NOW, generateId: ids });

const entry = (over: Record<string, unknown> = {}) => ({
  actor: { actorId: "user.steven", kind: "human" },
  tenant: { organizationId: "ksix", roles: [] },
  component: "hive.workorderiq",
  componentVersion: "0.19.0",
  actionType: "event",
  action: "work_order.created",
  outcome: "succeeded",
  reason: "The shop opened a work order.",
  trace: { correlationId: "ORDER-123" },
  ...over,
});

const escalation = (over: Record<string, unknown> = {}) => ({
  escalationId: "esc.1",
  reason: "Repeated authorization failures from one connector.",
  scope: "incident:conn-77",
  approvingPolicyId: "policy.security.escalation",
  decisionId: "gd.esc.1",
  sourceEntryRefs: [
    {
      globalInstanceId: INSTANCE_A.globalInstanceId,
      auditEventId: "aud_1",
      sequence: 0,
      hash: "abc123",
    },
  ],
  sanitizationStatus: "digests-only",
  closedAt: "2026-08-29T13:00:00.000Z",
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. TENANT ISOLATION
// ─────────────────────────────────────────────────────────────────────────────

describe("a tenant cannot read another tenant's ledger", () => {
  it("returns nothing for a tenant asking about another", () => {
    const ledger = instanceLedger();
    ledger.append(entry());
    expect(ledger.read({ readingTenant: "competitor" })).toHaveLength(0);
  });

  it("returns the entries to the tenant they belong to", () => {
    // Non-vacuity. Without this, a `read` that returned nothing to everybody
    // would pass the test above.
    const ledger = instanceLedger();
    ledger.append(entry());
    expect(ledger.read({ readingTenant: "ksix" })).toHaveLength(1);
  });

  it("ignores a tenant filter that disagrees with the reader", () => {
    // The reading tenant OVERRIDES rather than combines. A caller able to pass
    // both would be a caller able to ask for another tenant's entries, and
    // which of the two wins is exactly what gets refactored the wrong way.
    const ledger = instanceLedger();
    ledger.append(entry());
    ledger.append(entry({ tenant: { organizationId: "competitor", roles: [] } }));

    const asKsix = ledger.read({ readingTenant: "ksix", tenant: "competitor" });
    expect(asKsix).toHaveLength(1);
    expect(asKsix[0]?.record.tenant.organizationId).toBe("ksix");
  });

  it("has no unscoped read at all", () => {
    // `readingTenant` is required by the type. Asserted at runtime too, because
    // a JavaScript host has no types — and an omitted filter that silently
    // became a global query is the failure mode this shape exists to prevent.
    const ledger = instanceLedger();
    ledger.append(entry());
    const unscoped = ledger.read({} as { readingTenant: string });
    expect(unscoped).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 & 6. THE WALL BETWEEN THE LEDGERS
// ─────────────────────────────────────────────────────────────────────────────

describe("the collective ledger is not a copy of the local ones", () => {
  it("refuses an ordinary operational entry", () => {
    // The design, in one assertion. A collective ledger that accepted this
    // would become a central copy of every tenant's business history — the
    // outcome the whole multi-instance architecture exists to avoid, reached
    // through the audit system instead of the database.
    const collective = collectiveLedger();
    const result = collective.append(entry(), "operational" as never);
    expect(result.written).toBe(false);
    if (result.written) return;
    expect(result.reason).toMatch(/never ordinary operational execution/);
  });

  it("accepts the classes it exists for", () => {
    const collective = collectiveLedger();
    for (const cls of ["constitutional", "security", "foundry", "release"] as const) {
      const r = collective.append(
        entry({
          tenant: { organizationId: "collective", roles: [] },
          action: "charter.amended",
          actionType: "approval",
        }),
        cls,
      );
      expect(r.written).toBe(true);
    }
    expect(collective.count()).toBe(4);
  });

  it("refuses an escalated incident appended directly", () => {
    // The route around the provenance requirements, closed. Appending one
    // directly would skip the reason, scope, approving policy, source
    // references, sanitization status and closure.
    const collective = collectiveLedger();
    const r = collective.append(entry(), "escalated_incident");
    expect(r.written).toBe(false);
    if (r.written) return;
    expect(r.reason).toMatch(/written by `escalate`/);
  });

  it("keeps local retention away from collective records", () => {
    // Two separate stores, and no operation spans them. There is no method on
    // an instance ledger that takes a collective one, and neither has a delete
    // at all — so a tenant expiring local history removes nothing
    // constitutional, because nothing constitutional was inside the thing
    // being expired.
    const local = instanceLedger();
    const collective = collectiveLedger();
    local.append(entry());
    collective.append(
      entry({ tenant: { organizationId: "collective", roles: [] }, action: "charter.amended" }),
      "constitutional",
    );

    expect(localRetentionErasesCollective()).toBe(false);
    expect(Object.keys(local)).not.toContain("delete");
    expect(Object.keys(local)).not.toContain("purge");
    expect(collective.count()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. TAMPER EVIDENCE
// ─────────────────────────────────────────────────────────────────────────────

describe("tampering with an old entry is detectable", () => {
  it("verifies an untouched chain", () => {
    const ledger = instanceLedger();
    ledger.append(entry());
    ledger.append(entry({ action: "work_order.completed" }));
    ledger.append(entry({ action: "work_order.shipped" }));

    const check = ledger.verify();
    expect(check.intact).toBe(true);
    expect(check.recordsChecked).toBe(3);
  });

  it("cannot be tampered with through a returned entry", () => {
    // Entries come out frozen and deeply copied. A caller holding a mutable
    // reference could alter evidence after its hash was computed, which is
    // tamper-evidence defeated by the accessor rather than by the store.
    const ledger = instanceLedger();
    const written = ledger.append(entry());
    expect(written.written).toBe(true);
    if (!written.written) return;

    expect(() => {
      (written.sealed as { hash: string }).hash = "forged";
    }).toThrow();

    expect(ledger.verify().intact).toBe(true);
  });

  it("seals the same record differently in two instances", () => {
    // The test that proves the instance is genuinely INSIDE the hash rather
    // than merely stored beside it. `verify()` cannot show this on its own: it
    // recomputes with the same function, so a preimage missing the instance is
    // still self-consistent and still reports intact.
    //
    // Found by a surviving mutation — dropping `globalInstanceId` from the
    // preimage changed no test result, which meant "attribution cannot be
    // edited without breaking the chain" was a claim nothing checked.
    //
    // Identical record, identical clock, identical id, identical sequence and
    // previousHash. The only difference is which instance sealed it, so if the
    // hashes match, the instance is not in the preimage.
    const a = createInstanceLedger({
      instance: INSTANCE_A,
      now: NOW,
      generateId: () => "aud_fixed",
    });
    const b = createInstanceLedger({
      instance: { globalInstanceId: "hive.proworks.us-east", provisional: false },
      now: NOW,
      generateId: () => "aud_fixed",
    });

    const inA = a.append(entry());
    const inB = b.append(entry());
    expect(inA.written && inB.written).toBe(true);
    if (!inA.written || !inB.written) return;

    expect(inA.sealed.record).toEqual(inB.sealed.record);
    expect(inA.sealed.sequence).toBe(inB.sealed.sequence);
    expect(inA.sealed.previousHash).toBe(inB.sealed.previousHash);
    expect(inA.sealed.hash).not.toBe(inB.sealed.hash);
  });

  it("covers the sealing instance, so attribution cannot be edited", () => {
    // The instance is inside the hash. Outside it, "which instance sealed
    // this" would be a label an editor could change — and it is precisely the
    // claim a collective ledger has to rely on when reading an escalation.
    const ledger = instanceLedger();
    const written = ledger.append(entry());
    expect(written.written).toBe(true);
    if (!written.written) return;
    expect(written.sealed.globalInstanceId).toBe("hive.ksix.us-east");
    expect(ledger.verify().intact).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. REPLAY
// ─────────────────────────────────────────────────────────────────────────────

describe("a replay never masquerades as the original execution", () => {
  it("writes its own entry, with a new session id", () => {
    // "Every replay decision and side effect is itself written to the ledger."
    // A replay that left no trace would be the one operation able to re-run
    // history while being invisible in it.
    const ledger = instanceLedger();
    const r = ledger.recordReplay({
      replaySessionId: "replay.1",
      requestedBy: "operator.steven",
      tenant: { organizationId: "ksix", roles: [] },
      correlationId: "ORDER-123",
      scope: "execution:exec-9",
      decisionId: "gd.replay.1",
      reason: "Recovering a lost projection.",
    });

    expect(r.written).toBe(true);
    if (!r.written) return;
    expect(r.sealed.record.actionType).toBe("replay");
    expect(r.sealed.record.detail?.["replaySessionId"]).toBe("replay.1");
    // The original correlation is kept, so the replay is findable alongside
    // what it replayed — while the session id keeps them distinguishable.
    expect(r.sealed.record.trace.correlationId).toBe("ORDER-123");
  });

  it("defaults to a dry run", () => {
    // Dry-run is the default posture the architecture asks for. A default of
    // false would make the dangerous mode the one you get by not thinking.
    const ledger = instanceLedger();
    const r = ledger.recordReplay({
      replaySessionId: "replay.2",
      requestedBy: "operator.steven",
      tenant: { organizationId: "ksix", roles: [] },
      correlationId: "ORDER-123",
      scope: "execution:exec-9",
      decisionId: "gd.replay.2",
      reason: "Checking what would happen.",
    });
    expect(r.written).toBe(true);
    if (!r.written) return;
    expect(r.sealed.record.detail?.["dryRun"]).toBe(true);
  });

  it("records a live replay as live", () => {
    const ledger = instanceLedger();
    const r = ledger.recordReplay({
      replaySessionId: "replay.3",
      requestedBy: "operator.steven",
      tenant: { organizationId: "ksix", roles: [] },
      correlationId: "ORDER-123",
      scope: "execution:exec-9",
      decisionId: "gd.replay.3",
      dryRun: false,
      reason: "Authorized recovery.",
    });
    expect(r.written).toBe(true);
    if (!r.written) return;
    expect(r.sealed.record.detail?.["dryRun"]).toBe(false);
  });

  it("gives each replay a distinct entry, so two are not one", () => {
    const ledger = instanceLedger();
    for (const id of ["replay.a", "replay.b"]) {
      ledger.recordReplay({
        replaySessionId: id,
        requestedBy: "operator.steven",
        tenant: { organizationId: "ksix", roles: [] },
        correlationId: "ORDER-123",
        scope: "execution:exec-9",
        decisionId: "gd.x",
        reason: "recovery",
      });
    }
    const replays = ledger.read({ readingTenant: "ksix", action: "execution.replayed" });
    expect(replays).toHaveLength(2);
    expect(new Set(replays.map((r) => r.record.detail?.["replaySessionId"]))).toEqual(
      new Set(["replay.a", "replay.b"]),
    );
  });

  it("keeps a replay in the tenant's own ledger, unreadable by another", () => {
    // "Collective operators cannot replay a tenant workflow without required
    // authorization." The ledger half of that: a replay recorded against a
    // tenant is that tenant's evidence, and nobody else's read reaches it.
    const ledger = instanceLedger();
    ledger.recordReplay({
      replaySessionId: "replay.z",
      requestedBy: "collective.operator",
      tenant: { organizationId: "ksix", roles: [] },
      correlationId: "ORDER-123",
      scope: "execution:exec-9",
      decisionId: "gd.x",
      reason: "collective investigation",
    });
    expect(ledger.read({ readingTenant: "collective" })).toHaveLength(0);
    expect(ledger.read({ readingTenant: "ksix" })).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ESCALATION
// ─────────────────────────────────────────────────────────────────────────────

describe("an escalation carries provenance, not records", () => {
  it("writes references and digests, never the source entries", () => {
    const collective = collectiveLedger();
    const r = collective.escalate(escalation());
    expect(r.written).toBe(true);
    if (!r.written) return;

    const detail = r.sealed.record.detail ?? {};
    expect(detail["sourceInstances"]).toBe("hive.ksix.us-east");
    expect(detail["sourceEntryIds"]).toBe("aud_1");
    expect(detail["sourceEntryHashes"]).toBe("abc123");
    expect(detail["sanitizationStatus"]).toBe("digests-only");
    // The record itself is nowhere in the escalation. `detail` accepts only
    // strings, numbers and booleans, so a payload cannot be nested into it —
    // the audit contract's own narrowness is doing the work here.
    expect(JSON.stringify(detail)).not.toMatch(/work_order\.created/);
  });

  it("scopes the escalation to the collective, not to the source tenant", () => {
    // A collective record scoped to one tenant would be readable as that
    // tenant's data, which is the leak arriving through the audit system.
    const collective = collectiveLedger();
    const r = collective.escalate(escalation());
    expect(r.written).toBe(true);
    if (!r.written) return;
    expect(r.sealed.record.tenant.organizationId).toBe("collective");
  });

  it("refuses raw tenant evidence without explicit incident authorization", () => {
    // The one place a tenant's actual records leave their instance, and the
    // one place this design demands a second authorization.
    const collective = collectiveLedger();
    const r = collective.escalate(escalation({ sanitizationStatus: "raw-authorized" }));
    expect(r.written).toBe(false);
    if (r.written) return;
    expect(r.reason).toMatch(/incident authorization/i);
  });

  it("permits raw evidence when an incident authorized it", () => {
    const collective = collectiveLedger();
    const r = collective.escalate(
      escalation({
        sanitizationStatus: "raw-authorized",
        incidentAuthorization: {
          incidentId: "inc.7",
          authorizedBy: "user.steven",
          authorizedAt: "2026-08-29T11:00:00.000Z",
        },
      }),
    );
    expect(r.written).toBe(true);
    if (!r.written) return;
    expect(r.sealed.record.detail?.["incidentId"]).toBe("inc.7");
  });

  it("refuses an escalation with no source entries", () => {
    // An escalation from nothing is an assertion, and it would arrive in the
    // collective ledger looking exactly like evidence.
    const r = escalationSchema.safeParse({ ...escalation(), sourceEntryRefs: [] });
    expect(r.success).toBe(false);
  });

  it("refuses an escalation that neither expires nor closes", () => {
    // §14 in a different costume: temporary authority shall not silently
    // become permanent, and an incident nobody closed is indistinguishable
    // from one nobody finished.
    const r = escalationSchema.safeParse({ ...escalation(), closedAt: undefined });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(JSON.stringify(r.error.flatten())).toMatch(/stays open by default/);
  });

  it("requires a reason, a scope and an approving policy", () => {
    for (const missing of ["reason", "scope", "approvingPolicyId"] as const) {
      const input = { ...escalation() } as Record<string, unknown>;
      delete input[missing];
      expect(escalationSchema.safeParse(input).success).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RECORD MODEL
// ─────────────────────────────────────────────────────────────────────────────

describe("the record model answers what an execution history is for", () => {
  it("classifies entries by kind, not by guessing at the action string", () => {
    // A taxonomy derived by pattern-matching free text silently reclassifies
    // itself when somebody renames an action.
    const ledger = instanceLedger();
    const rollback = ledger.append(entry({ actionType: "rollback", action: "work_order.reversed" }));
    expect(rollback.written).toBe(true);
    if (!rollback.written) return;
    expect(rollback.sealed.record.actionType).toBe("rollback");

    const unstated = ledger.append(entry({ actionType: undefined }));
    expect(unstated.written).toBe(true);
    if (!unstated.written) return;
    // The honest reading of an entry whose writer did not say.
    expect(unstated.sealed.record.actionType).toBe("event");
  });

  it("distinguishes compensated from failed", () => {
    // A compensated action DID happen and was deliberately reversed. Folding
    // it into `failed` would lose the fact that the effect existed for a time,
    // which is what an incident review needs to know.
    const ledger = instanceLedger();
    const r = ledger.append(
      entry({ outcome: "compensated", reason: "Reservation released after the order was cancelled." }),
    );
    expect(r.written).toBe(true);
    if (!r.written) return;
    expect(r.sealed.record.outcome).toBe("compensated");
  });

  it("stores digests rather than inputs and outputs", () => {
    const ledger = instanceLedger();
    const r = ledger.append(
      entry({ inputsDigest: "sha256:aaa", outputsDigest: "sha256:bbb" }),
    );
    expect(r.written).toBe(true);
    if (!r.written) return;
    expect(r.sealed.record.inputsDigest).toBe("sha256:aaa");
    // There is no field to put a payload in.
    expect(Object.keys(r.sealed.record)).not.toContain("inputs");
    expect(Object.keys(r.sealed.record)).not.toContain("outputs");
  });

  it("still refuses a denial with no decision behind it", () => {
    // Pre-existing invariant, re-asserted because this phase changed the
    // schema around it. A denial nobody can trace cannot be appealed or
    // distinguished from a fault.
    const ledger = instanceLedger();
    const r = ledger.append(entry({ outcome: "denied", reason: "refused" }));
    expect(r.written).toBe(false);
  });

  it("holds that reading a ledger entry authorizes nothing", () => {
    expect(ledgerEntryGrantsAuthority()).toBe(false);
  });
});
