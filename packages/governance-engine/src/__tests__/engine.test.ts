// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import type { AuthorityEnvelope } from "@proworks-hub/contracts";

import { createGovernanceEngine } from "../engine.js";
import { CONSTITUTIONAL_CORE_PROTECTIONS, policyGrantSchema, type PolicySet } from "../policy.js";

// ─────────────────────────────────────────────────────────────────────────────
// Charter §18 — the invariants this engine exists to hold:
//
//   "Missing permission does not create permission."
//   "Uncertainty does not create authority."
//
// Both are the same shape: every path that cannot establish authority must end
// in a denial rather than a fall-through. Most of these tests are that one
// sentence, asked in a different way each time.
// ─────────────────────────────────────────────────────────────────────────────

const envelope = (over: Partial<AuthorityEnvelope> = {}): AuthorityEnvelope => ({
  requestId: "req-1",
  actorId: "steven",
  tenant: { organizationId: "ksix", roles: [] },
  purpose: "quote a customer",
  requestedAction: "price_job",
  delegationChain: [],
  riskClass: "routine",
  issuedAt: "2026-08-28T00:00:00.000Z",
  ...over,
});

const policy = (over: Partial<PolicySet> = {}): PolicySet => ({
  policyId: "policy.test",
  version: "1.0.0",
  protections: [],
  grants: [],
  ...over,
});

const grant = (over: Record<string, unknown> = {}) =>
  policyGrantSchema.parse({
    grantId: "grant.pricing",
    reason: "operators price jobs",
    actors: ["steven"],
    actions: ["price_job"],
    tenants: ["ksix"],
    purposes: ["quote a customer"],
    maxRiskClass: "routine",
    conditions: [],
    ...over,
  });

const engine = (p: PolicySet) => createGovernanceEngine({ policy: p });

describe("missing permission does not create permission", () => {
  it("denies when no grants are configured", async () => {
    const d = await engine(policy()).authorize(envelope());
    expect(d.decision).toBe("DENIED");
    expect(d.reason).toContain("No grants are configured");
  });

  it("permits when a grant matches on every dimension", async () => {
    const d = await engine(policy({ grants: [grant()] })).authorize(envelope());
    expect(d.decision).toBe("PERMITTED");
    expect(d.reason).toContain("grant.pricing");
  });

  it("denies on any single dimension mismatch", async () => {
    const g = engine(policy({ grants: [grant()] }));
    const cases: Array<[string, Partial<AuthorityEnvelope>]> = [
      ["actor", { actorId: "someone-else" }],
      ["action", { requestedAction: "delete_everything" }],
      ["tenant", { tenant: { organizationId: "other", roles: [] } }],
      ["purpose", { purpose: "something else" }],
    ];
    for (const [label, over] of cases) {
      const d = await g.authorize(envelope(over));
      expect(d.decision, label).toBe("DENIED");
      expect(d.reason, label).toContain(label);
    }
  });

  it("does not match by prefix", async () => {
    // `steven` must not grant `steven2`. A prefix match reads as correct in
    // review and authorizes an actor nobody meant to.
    const d = await engine(policy({ grants: [grant()] })).authorize(
      envelope({ actorId: "steven2" }),
    );
    expect(d.decision).toBe("DENIED");
  });

  it("honours an explicit wildcard, which must be written not omitted", async () => {
    const d = await engine(
      policy({ grants: [grant({ actors: ["*"], purposes: ["*"] })] }),
    ).authorize(envelope({ actorId: "anyone", purpose: "anything" }));
    expect(d.decision).toBe("PERMITTED");
  });
});

describe("uncertainty does not create authority", () => {
  it("denies a request with no actor", async () => {
    const d = await engine(policy({ grants: [grant({ actors: ["*"] })] })).authorize(
      envelope({ actorId: "" }),
    );
    expect(d.decision).toBe("DENIED");
    expect(d.reason).toContain("No actor");
  });

  it("denies a request with no tenant", async () => {
    const d = await engine(policy({ grants: [grant({ tenants: ["*"] })] })).authorize(
      envelope({ tenant: { organizationId: "", roles: [] } }),
    );
    expect(d.decision).toBe("DENIED");
    expect(d.reason).toContain("No tenant");
  });

  it("denies a request with no purpose, even under a wildcard grant", async () => {
    // Constitution §1.7. A wildcard on purposes means "any stated purpose",
    // not "no purpose needed".
    const d = await engine(policy({ grants: [grant({ purposes: ["*"] })] })).authorize(
      envelope({ purpose: "" }),
    );
    expect(d.decision).toBe("DENIED");
    expect(d.reason).toContain("purpose-bound");
  });
});

describe("expiry", () => {
  const at = () => new Date("2026-08-28T12:00:00.000Z");

  it("denies when the request's own authority has expired", async () => {
    const g = createGovernanceEngine({ policy: policy({ grants: [grant()] }), now: at });
    const d = await g.authorize(envelope({ expiresAt: "2026-08-28T11:00:00.000Z" }));
    expect(d.decision).toBe("DENIED");
    expect(d.reason).toContain("Expired authority is absent authority");
  });

  it("denies when the grant has expired, and says so", async () => {
    const g = createGovernanceEngine({
      policy: policy({
        grants: [grant({ expiresAt: "2026-08-28T09:00:00.000Z", temporaryReason: "migration window" })],
      }),
      now: at,
    });
    const d = await g.authorize(envelope());
    expect(d.decision).toBe("DENIED");
    expect(d.reason).toContain("have expired");
  });

  it("denies before a grant's start time", async () => {
    const g = createGovernanceEngine({
      policy: policy({ grants: [grant({ notBefore: "2026-08-29T00:00:00.000Z" })] }),
      now: at,
    });
    expect((await g.authorize(envelope())).decision).toBe("DENIED");
  });

  it("checks expiry against the engine clock, not the caller's", async () => {
    // A caller that could supply "now" could outlive its own grant.
    const g = createGovernanceEngine({
      policy: policy({
        grants: [grant({ expiresAt: "2026-08-28T09:00:00.000Z", temporaryReason: "window" })],
      }),
      now: at,
    });
    const d = await g.authorize(envelope({ issuedAt: "2020-01-01T00:00:00.000Z" }));
    expect(d.decision).toBe("DENIED");
  });

  it("requires a temporary grant to say why it is temporary", () => {
    // Charter §14: temporary authority shall not silently become permanent. An
    // unexplained expiry gets renewed rather than reviewed.
    expect(() => grant({ expiresAt: "2026-09-01T00:00:00.000Z" })).toThrow(/why it is temporary/);
  });
});

describe("Core Protections cannot be out-voted", () => {
  it("prohibits a protected action even under a total wildcard grant", async () => {
    // The ordering assertion. A protection evaluated after grants would be a
    // protection any broad grant could defeat.
    const d = await engine(
      policy({ grants: [grant({ actors: ["*"], actions: ["*"], tenants: ["*"], purposes: ["*"] })] }),
    ).authorize(envelope({ requestedAction: "governance.expand_own_authority" }));

    expect(d.decision).toBe("PROHIBITED");
    expect(d.reason).toContain("No policy, grant or override can permit this");
  });

  it("prohibits every constitutional protection", async () => {
    const g = engine(policy({ grants: [grant({ actions: ["*"], actors: ["*"], purposes: ["*"], tenants: ["*"] })] }));
    for (const protection of CONSTITUTIONAL_CORE_PROTECTIONS) {
      for (const action of protection.actions) {
        const d = await g.authorize(envelope({ requestedAction: action }));
        expect(d.decision, action).toBe("PROHIBITED");
      }
    }
  });

  it("cites a constitutional basis on every prohibition", async () => {
    // A prohibition without a basis is just a denial with a stronger word.
    const d = await engine(policy()).authorize(
      envelope({ requestedAction: "audit.destroy_evidence" }),
    );
    expect(d.reason).toMatch(/Decision Record|Constitution|Charter/);
  });

  it("cannot have a constitutional protection configured away", async () => {
    // A policy that omits protections does not remove them: they are added to,
    // never substituted. A protection that configuration can remove is not one.
    const d = await engine(policy({ protections: [] })).authorize(
      envelope({ requestedAction: "sentinel.disable_permanently" }),
    );
    expect(d.decision).toBe("PROHIBITED");
  });
});

describe("conditions and risk", () => {
  it("returns PERMITTED_WITH_CONDITIONS and states them", async () => {
    const d = await engine(
      policy({ grants: [grant({ conditions: ["two-person approval", "audit within 24h"] })] }),
    ).authorize(envelope());
    expect(d.decision).toBe("PERMITTED_WITH_CONDITIONS");
    expect(d.conditions).toEqual(["two-person approval", "audit within 24h"]);
  });

  it("denies a request above the grant's risk ceiling", async () => {
    const d = await engine(
      policy({ grants: [grant({ maxRiskClass: "routine" })] }),
    ).authorize(envelope({ riskClass: "critical" }));
    expect(d.decision).toBe("DENIED");
    expect(d.reason).toContain("riskClass");
  });

  it("permits at or below the ceiling", async () => {
    const g = engine(policy({ grants: [grant({ maxRiskClass: "high" })] }));
    for (const riskClass of ["routine", "elevated", "high"] as const) {
      expect((await g.authorize(envelope({ riskClass }))).decision, riskClass).toBe("PERMITTED");
    }
  });
});

describe("explainability — Charter §17", () => {
  it("identifies actor, tenant, action and purpose in a denial", async () => {
    const d = await engine(policy()).authorize(envelope());
    for (const fragment of ["price_job", "steven", "ksix", "quote a customer"]) {
      expect(d.reason).toContain(fragment);
    }
  });

  it("names which dimension the closest grant failed on", async () => {
    // "Denied" alone sends an operator to read the policy file.
    const d = await engine(
      policy({ grants: [grant({ tenants: ["other-org"] })] }),
    ).authorize(envelope());
    expect(d.reason).toContain("tenant");
  });

  it("carries policy id, version and a distinct decision id", async () => {
    const g = engine(policy({ grants: [grant()] }));
    const a = await g.authorize(envelope());
    const b = await g.authorize(envelope());
    expect(a.policyId).toBe("policy.test");
    expect(a.policyVersion).toBe("1.0.0");
    expect(a.decisionId).not.toBe(b.decisionId);
  });

  it("reports every decision to the observer, denials included", async () => {
    const seen: string[] = [];
    const g = createGovernanceEngine({
      policy: policy(),
      onDecision: (d) => seen.push(d.decision),
    });
    await g.authorize(envelope());
    await g.authorize(envelope({ requestedAction: "audit.suppress" }));
    expect(seen).toEqual(["DENIED", "PROHIBITED"]);
  });

  it("describes the policy in force", async () => {
    const d = engine(policy({ grants: [grant()] })).describe();
    expect(d).toMatchObject({ policyId: "policy.test", version: "1.0.0", grants: 1 });
    // Constitutional protections are always counted, even with none configured.
    expect(d.protections).toBeGreaterThanOrEqual(CONSTITUTIONAL_CORE_PROTECTIONS.length);
  });
});

describe("Governance owns no domain state — Charter §4", () => {
  it("decides without touching any domain concept", async () => {
    // The boundary made structural: this package imports no domain type, and a
    // decision is reached from actor, action, tenant, purpose and risk alone.
    const d = await engine(policy({ grants: [grant({ actions: ["*"] })] })).authorize(
      envelope({ requestedAction: "anything_at_all" }),
    );
    expect(d.decision).toBe("PERMITTED");
    expect(Object.keys(d).sort()).toEqual(
      ["conditions", "decidedAt", "decision", "decisionId", "policyId", "policyVersion", "reason"].sort(),
    );
  });
});
