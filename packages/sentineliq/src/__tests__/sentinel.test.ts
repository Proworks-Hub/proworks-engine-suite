// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { tierFor } from "@proworks-hub/contracts";

import {
  DEFENSIVE_LADDER,
  absorbsAuthorityFrom,
  createSentinelIq,
  disruptionOf,
  emergencyInForce,
  emergencyProtectiveStateSchema,
  findingSchema,
  outstandingRecovery,
  protectiveRestrictionSchema,
  restrictionActive,
  selectResponse,
  type Finding,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Charter §2: "Is the Hive actually behaving the way it is authorized and
// expected to behave?"
// Charter §18: "Sentinel protects without ruling."
// ─────────────────────────────────────────────────────────────────────────────

const finding = (over: Record<string, unknown> = {}): Finding =>
  findingSchema.parse({
    findingId: "fnd_1",
    kind: "privilege_abuse",
    severity: "high",
    confidence: "confirmed",
    subject: { kind: "engine", id: "hive.costiq", tenant: { organizationId: "ksix", roles: [] } },
    summary: "CostIQ requested an authority envelope naming a tenant it does not serve.",
    evidence: [
      { sourceKind: "audit_record", locator: "auditiq://aud_41", observedAt: "2026-08-29T10:00:00.000Z" },
    ],
    observedAt: "2026-08-29T10:00:01.000Z",
    correlatedWith: [],
    ...over,
  });

const sentinel = () => createSentinelIq({ now: () => new Date("2026-08-29T10:00:00.000Z") });

describe("Sentinel is constitutional plane, not a tier", () => {
  it("has no capability tier", () => {
    // The two-plane architecture: constitutional systems sit outside the
    // five-tier dependency matrix. null is the answer, not a fallback.
    expect(tierFor("CONSTITUTIONAL_SENTINEL")).toBeNull();
  });
});

describe("a finding preserves confidence and uncertainty", () => {
  it("requires anything short of confirmed to state what is not known", () => {
    // Common Overwatch Protections: distinguish confirmed compromise from
    // suspected. Unstated uncertainty is read as certainty by whoever acts on
    // the finding at three in the morning.
    const suspected = findingSchema.safeParse({ ...finding(), confidence: "suspected" });
    expect(suspected.success).toBe(false);

    const stated = findingSchema.safeParse({
      ...finding(),
      confidence: "suspected",
      uncertainty: "The envelope may be a replay of a legitimate earlier request.",
    });
    expect(stated.success).toBe(true);
  });

  it("requires at least one piece of evidence", () => {
    // A finding with no evidence is an assertion, and §17 gives every other
    // constitutional system the right to challenge a conclusion — which needs
    // something to challenge.
    expect(findingSchema.safeParse({ ...finding(), evidence: [] }).success).toBe(false);
  });

  it("keeps severity and confidence as separate axes", () => {
    // Collapsing them is how a suspicious signal acquires the weight of a
    // confirmed breach on its way up the chain.
    const f = finding({
      severity: "catastrophic",
      confidence: "suspected",
      uncertainty: "Single sensor, not corroborated.",
    });
    expect(f.severity).toBe("catastrophic");
    expect(f.confidence).toBe("suspected");
  });

  it("references evidence rather than carrying it", () => {
    // §12: AuditIQ preserves the evidence; Sentinel consumes and interprets it.
    // Copying evidence in would make Sentinel a second source of truth for it.
    const keys = Object.keys(finding().evidence[0]!);
    expect(keys).toContain("locator");
    expect(keys).not.toContain("payload");
    expect(keys).not.toContain("content");
  });
});

describe("findings cannot be silently suppressed", () => {
  it("exposes no suppress, dismiss or delete method", () => {
    // §17, first invariant. Not "they refuse" — they do not exist. The method
    // that exists is the one somebody reaches for during an incident.
    expect(Object.keys(sentinel()).sort()).toEqual(["count", "disposition", "find", "health", "observe"]);
  });

  it("keeps a false positive in the record", () => {
    // Being wrong in public is the point. A finding that disappears when it
    // turns out to be wrong is indistinguishable from one suppressed because it
    // was inconvenient.
    const s = sentinel();
    s.observe(finding());
    s.disposition("fnd_1", {
      disposition: "resolved_false_positive",
      by: "steven",
      at: "2026-08-29T11:00:00.000Z",
      reason: "Envelope was a replay from a stale client, not privilege abuse.",
    });

    expect(s.count()).toBe(1);
    expect(s.find()).toHaveLength(1);
    expect(s.find()[0]!.disposition).toBe("resolved_false_positive");
  });

  it("requires a named person and a reason for every disposition", () => {
    const s = sentinel();
    s.observe(finding());
    expect(s.disposition("fnd_1", { disposition: "acknowledged", at: "x" }).applied).toBe(false);
    expect(
      s.disposition("fnd_1", {
        disposition: "acknowledged",
        by: "steven",
        at: "2026-08-29T10:30:00.000Z",
        reason: "Investigating.",
      }).applied,
    ).toBe(true);
  });

  it("grows the history rather than replacing it", () => {
    const s = sentinel();
    s.observe(finding());
    s.disposition("fnd_1", {
      disposition: "acknowledged",
      by: "steven",
      at: "2026-08-29T10:30:00.000Z",
      reason: "Investigating.",
    });
    const after = s.disposition("fnd_1", {
      disposition: "resolved_addressed",
      by: "steven",
      at: "2026-08-29T12:00:00.000Z",
      reason: "Credential rotated and the grant narrowed.",
    });

    expect(after.applied).toBe(true);
    if (after.applied) expect(after.finding.history).toHaveLength(2);
  });

  it("refuses to rewind a finding to open", () => {
    // Rewinding would erase that somebody had already judged it. A reopened
    // investigation is a new finding correlated with this one.
    const s = sentinel();
    s.observe(finding());
    s.disposition("fnd_1", {
      disposition: "resolved_addressed",
      by: "steven",
      at: "2026-08-29T12:00:00.000Z",
      reason: "Fixed.",
    });
    const rewind = s.disposition("fnd_1", {
      disposition: "open",
      by: "steven",
      at: "2026-08-29T13:00:00.000Z",
      reason: "Actually not fixed.",
    });
    expect(rewind.applied).toBe(false);
  });

  it("refuses to overwrite an existing finding id", () => {
    // Re-observing under the same id would replace the original record, which
    // is suppression with extra steps.
    const s = sentinel();
    expect(s.observe(finding()).recorded).toBe(true);
    expect(s.observe(finding({ summary: "Something else entirely." })).recorded).toBe(false);
  });

  it("emits every finding to a sink at the moment it is recorded", () => {
    // A finding that only exists inside this process can be lost with it, and
    // then suppression is indistinguishable from nothing having happened.
    const seen: string[] = [];
    const s = createSentinelIq({ onFinding: (f) => seen.push(f.finding.findingId) });
    s.observe(finding());
    expect(seen).toEqual(["fnd_1"]);
  });

  it("refuses a malformed observation rather than throwing", () => {
    const rejected: string[] = [];
    const s = createSentinelIq({ onRejected: (r) => rejected.push(r) });
    expect(() => s.observe({ nonsense: true })).not.toThrow();
    expect(s.count()).toBe(0);
    expect(rejected).toHaveLength(1);
  });
});

describe("minimum necessary disruption", () => {
  it("orders the ladder from warning to stopping the whole Hive", () => {
    expect(DEFENSIVE_LADDER[0]).toBe("warn");
    expect(DEFENSIVE_LADDER[DEFENSIVE_LADDER.length - 1]).toBe("emergency_protective_state");
    expect(disruptionOf("warn")).toBeLessThan(disruptionOf("quarantine_engine"));
  });

  it("takes the gentlest response the detector declared adequate", () => {
    // §7: "prefer the least disruptive defensive response capable of adequately
    // protecting the Hive."
    const selection = selectResponse({
      finding: finding({ severity: "high" }),
      adequate: ["quarantine_engine", "restrict_access", "stop_automation"],
    });
    expect(selection.selected).toBe("restrict_access");
  });

  it("records what it passed over", () => {
    // The evidence that §7 was actually applied rather than merely intended.
    const selection = selectResponse({
      finding: finding({ severity: "high" }),
      adequate: ["quarantine_engine", "restrict_access"],
    });
    expect(selection.rejected.map((r) => r.response)).toContain("quarantine_engine");
    expect(selection.rejected[0]!.because).toContain("least disruptive");
  });

  it("will stop the whole when nothing lesser is adequate", () => {
    // §7's second sentence: "When lesser action cannot protect users or the
    // Hive, Sentinel may protect the whole by stopping the whole."
    const selection = selectResponse({
      finding: finding({ severity: "catastrophic" }),
      adequate: ["emergency_protective_state"],
    });
    expect(selection.selected).toBe("emergency_protective_state");
  });

  it("refuses a response the severity does not justify", () => {
    // The ceiling. §13 puts Emergency Protective State behind catastrophic
    // compromise explicitly.
    const selection = selectResponse({
      finding: finding({ severity: "moderate" }),
      adequate: ["emergency_protective_state"],
    });
    expect(selection.selected).toBeNull();
    if (selection.selected === null) expect(selection.reason).toContain("exceeds what a moderate finding");
  });

  it("invents no response when none was declared adequate", () => {
    // Disruption without protection is the worst of both.
    const selection = selectResponse({ finding: finding(), adequate: [] });
    expect(selection.selected).toBeNull();
  });

  it("carries the fact that it acted on suspicion", () => {
    // Not a refusal — waiting for certainty while data leaves the building is
    // its own failure, and §18 puts protection ahead of availability. But the
    // suspicion has to travel with the action, because it is the thing a
    // reviewer needs and the easiest thing to lose.
    const selection = selectResponse({
      finding: finding({
        severity: "high",
        confidence: "suspected",
        uncertainty: "Single sensor, not corroborated.",
      }),
      adequate: ["restrict_access"],
    });
    expect(selection.selected).toBe("restrict_access");
    if (selection.selected !== null) {
      expect(selection.actedOnSuspicion?.confidence).toBe("suspected");
      expect(selection.actedOnSuspicion?.uncertainty).toContain("Single sensor");
    }
  });

  it("says nothing about suspicion when the finding is confirmed", () => {
    const selection = selectResponse({ finding: finding(), adequate: ["restrict_access"] });
    if (selection.selected !== null) expect(selection.actedOnSuspicion).toBeUndefined();
  });

  it("is defensive, never retaliatory", () => {
    // §17. Every rung acts on the Hive's own sessions, engines, integrations,
    // deployments and automation. None reaches outward at a suspected attacker.
    for (const forbidden of [
      "retaliate",
      "counter",
      "attack",
      "probe",
      "trace_back",
      "takedown",
      "disable_source",
      "report_to",
    ]) {
      expect(DEFENSIVE_LADDER as readonly string[], forbidden).not.toContain(forbidden);
    }
  });
});

describe("restrictions are temporary by construction", () => {
  const restriction = (over: Record<string, unknown> = {}) => ({
    restrictionId: "res_1",
    response: "restrict_access",
    findingId: "fnd_1",
    subjectId: "hive.costiq",
    declaredAt: "2026-08-29T10:00:00.000Z",
    expiresAt: "2026-08-29T14:00:00.000Z",
    reason: "Containing a confirmed privilege abuse while the grant is reviewed.",
    ...over,
  });

  it("requires an expiry", () => {
    // §8: a Governance-approved action may be TEMPORARILY restricted, and
    // "Sentinel shall not permanently rewrite Governance policy." A restriction
    // with no expiry rewrites policy by outlasting it.
    const { expiresAt: _dropped, ...withoutExpiry } = restriction();
    expect(protectiveRestrictionSchema.safeParse(withoutExpiry).success).toBe(false);
  });

  it("refuses an expiry that precedes the declaration", () => {
    expect(
      protectiveRestrictionSchema.safeParse(restriction({ expiresAt: "2026-08-29T09:00:00.000Z" })).success,
    ).toBe(false);
  });

  it("lapses on its own", () => {
    const r = protectiveRestrictionSchema.parse(restriction());
    expect(restrictionActive(r, new Date("2026-08-29T13:00:00.000Z"))).toBe(true);
    expect(restrictionActive(r, new Date("2026-08-29T14:00:00.000Z"))).toBe(false);
  });
});

describe("emergency power does not become ordinary power", () => {
  const emergency = (over: Record<string, unknown> = {}) => ({
    emergencyId: "eme_1",
    declaredAt: "2026-08-29T10:00:00.000Z",
    decaysAt: "2026-08-29T16:00:00.000Z",
    findingId: "fnd_1",
    threatens: "protected_data",
    reason: "Confirmed exfiltration of tenant-confidential material to an unknown endpoint.",
    recoveryRequires: ["root_of_trust", "credential_rotation", "engine_integrity"],
    ...over,
  });

  it("requires a decay time", () => {
    // §13: "Emergency authority shall decay when the emergency ends." §17:
    // "Emergency power does not become ordinary power."
    const { decaysAt: _dropped, ...withoutDecay } = emergency();
    expect(emergencyProtectiveStateSchema.safeParse(withoutDecay).success).toBe(false);
  });

  it("decays on a clock rather than on somebody remembering", () => {
    // An emergency that has to be actively ended is one that quietly becomes
    // the new normal.
    const e = emergencyProtectiveStateSchema.parse(emergency());
    expect(emergencyInForce(e, new Date("2026-08-29T15:59:00.000Z"))).toBe(true);
    expect(emergencyInForce(e, new Date("2026-08-29T16:00:00.000Z"))).toBe(false);
  });

  it("names what recovery requires before trust returns", () => {
    // §16: "Restoration of service is not equivalent to restoration of trust."
    const e = emergencyProtectiveStateSchema.parse(emergency());
    expect(outstandingRecovery(e, [])).toHaveLength(3);
    expect(outstandingRecovery(e, ["root_of_trust", "credential_rotation"])).toEqual([
      "engine_integrity",
    ]);
    expect(
      outstandingRecovery(e, ["root_of_trust", "credential_rotation", "engine_integrity"]),
    ).toHaveLength(0);
  });

  it("separates decay from recovery", () => {
    // The clock running out is not the same event as trust being re-earned.
    // Conflating them welcomes a compromised system back because time passed.
    const e = emergencyProtectiveStateSchema.parse(emergency());
    const decayed = !emergencyInForce(e, new Date("2026-08-30T00:00:00.000Z"));
    expect(decayed).toBe(true);
    expect(outstandingRecovery(e, [])).toHaveLength(3);
  });

  it("demands at least one recovery requirement", () => {
    expect(emergencyProtectiveStateSchema.safeParse(emergency({ recoveryRequires: [] })).success).toBe(
      false,
    );
  });
});

describe("Sentinel does not become sovereign by protecting the Hive", () => {
  it("absorbs no authority from a system that has failed", () => {
    // Overwatch No-Authority-Accumulation: failure of another constitutional
    // system "shall not permit a surviving system to permanently absorb the
    // missing system's powers." The dangerous inference is the one nobody
    // wrote down, so it is written down.
    expect(absorbsAuthorityFrom("hive.governance")).toBe(false);
    expect(absorbsAuthorityFrom("hive.prime")).toBe(false);
  });

  it("writes no policy, grant or authorization", () => {
    // §8: "Sentinel shall not permanently rewrite Governance policy."
    // Governance authorizes; Sentinel verifies behaviour.
    for (const method of Object.keys(sentinel())) {
      expect(/policy|grant|authoriz|permit|approve/i.test(method), method).toBe(false);
    }
  });

  it("repairs nothing", () => {
    // §9: "Foundry may repair conditions Sentinel discovers... Sentinel shall
    // not become the architecture designer merely because it identified the
    // problem."
    for (const method of Object.keys(sentinel())) {
      expect(/repair|fix|remediate|redesign|refactor/i.test(method), method).toBe(false);
    }
  });

  it("owns no business-domain truth", () => {
    // §4. Watching a work order does not make Sentinel a holder of work orders.
    const source = [
      readFileSync(fileURLToPath(new URL("../finding.ts", import.meta.url)), "utf8"),
      readFileSync(fileURLToPath(new URL("../sentinel.ts", import.meta.url)), "utf8"),
    ]
      .join("\n")
      .split("\n")
      .filter((line) => {
        const t = line.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n")
      .toLowerCase();

    for (const domain of ["invoice", "workorder", "customer", "quote", "inventory", "price"]) {
      expect(source.includes(domain), domain).toBe(false);
    }
  });
});

describe("Sentinel is itself observable", () => {
  it("reports unknown, never healthy, when nothing has assessed it", () => {
    // Constitutional Heartbeat. The whole point of the five-state vocabulary is
    // that an unanswered heartbeat is not a healthy one.
    expect(sentinel().health().state).toBe("unknown");
  });

  it("reports what the host assessed", () => {
    // Sentinel cannot honestly judge its own reachability from inside itself —
    // a process that has lost the network still believes it is fine.
    const s = createSentinelIq({
      selfAssessment: () => ({ state: "isolated", detail: "No route to the audit store." }),
    });
    expect(s.health().state).toBe("isolated");
  });

  it("surfaces unresolved catastrophic findings in its own health", () => {
    const s = sentinel();
    s.observe(finding({ severity: "catastrophic" }));
    s.observe(finding({ findingId: "fnd_2", severity: "low" }));
    expect(s.health().openFindings).toBe(2);
    expect(s.health().unresolvedCatastrophic).toBe(1);
  });

  it("stops counting a finding once it is resolved", () => {
    const s = sentinel();
    s.observe(finding({ severity: "catastrophic" }));
    s.disposition("fnd_1", {
      disposition: "resolved_addressed",
      by: "steven",
      at: "2026-08-29T12:00:00.000Z",
      reason: "Contained and verified.",
    });
    expect(s.health().unresolvedCatastrophic).toBe(0);
    // Resolved, not gone.
    expect(s.count()).toBe(1);
  });
});

describe("finding a needle", () => {
  const populated = () => {
    const s = sentinel();
    s.observe(finding());
    s.observe(finding({ findingId: "fnd_2", kind: "data_exfiltration", severity: "catastrophic" }));
    s.observe(
      finding({
        findingId: "fnd_3",
        severity: "low",
        subject: { kind: "actor", id: "steven", tenant: { organizationId: "other", roles: [] } },
      }),
    );
    return s;
  };

  it("filters by kind, severity, subject and tenant", () => {
    const s = populated();
    expect(s.find({ kind: "data_exfiltration" })).toHaveLength(1);
    expect(s.find({ severity: "low" })).toHaveLength(1);
    expect(s.find({ subjectId: "hive.costiq" })).toHaveLength(2);
    expect(s.find({ tenant: "other" })).toHaveLength(1);
  });

  it("filters by severity floor, for what actually matters", () => {
    expect(populated().find({ atLeastSeverity: "high" })).toHaveLength(2);
    expect(populated().find({ atLeastSeverity: "catastrophic" })).toHaveLength(1);
  });

  it("returns everything when unfiltered", () => {
    expect(populated().find()).toHaveLength(3);
  });
});
