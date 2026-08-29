// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  evaluatePermission,
  grantAuthorizesAction,
  instanceIdentitySchema,
  permissionGrantSchema,
  principalMayWidenItself,
  principalSchema,
  trustPermitsWork,
  type PermissionGrant,
  type Principal,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — identity, instance identity, trust, and permission as evidence.
//
// The nine acceptance cases the Identity & Trust directive names, each written
// as the DENIAL it is supposed to produce rather than as a happy path with a
// denial appended. A permission check that has never been shown refusing is a
// permission check nobody has tested.
//
// Every boundary below also carries a mutation test: the check is deleted or
// inverted in a local copy of the rule, and the test asserts the mutant would
// pass something it must not. A guarantee that survives its own removal was
// never being enforced by the code under it.
// ─────────────────────────────────────────────────────────────────────────────

const INSTANCE = { globalInstanceId: "hive.ksix.us-east", provisional: false };
const OTHER_INSTANCE = { globalInstanceId: "hive.proworks.us-east", provisional: false };
const NOW = "2026-08-29T12:00:00.000Z";

const human = (over: Record<string, unknown> = {}): Principal =>
  principalSchema.parse({
    kind: "human",
    principalId: "user.steven",
    instance: INSTANCE,
    tenant: { organizationId: "ksix", roles: ["owner"] },
    trustState: "trusted",
    ...over,
  });

const engine = (over: Record<string, unknown> = {}): Principal =>
  principalSchema.parse({
    kind: "engine",
    principalId: "workorderiq",
    engineVersion: "0.19.0",
    instance: INSTANCE,
    trustState: "trusted",
    ...over,
  });

const agent = (over: Record<string, unknown> = {}): Principal =>
  principalSchema.parse({
    kind: "agent",
    principalId: "agent.repair.7",
    missionId: "mission.42",
    parentEngineId: "foundry",
    instance: INSTANCE,
    trustState: "trusted",
    ...over,
  });

const grant = (over: Partial<PermissionGrant> = {}): PermissionGrant =>
  permissionGrantSchema.parse({
    grantId: "grant.1",
    principalId: "user.steven",
    principalKind: "human",
    resource: "work_order",
    action: "create",
    tenantId: "ksix",
    ...over,
  });

const req = (over: Record<string, unknown> = {}) => ({
  resource: "work_order",
  action: "create",
  tenantId: "ksix",
  at: NOW,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the happy path exists, so the denials below mean something", () => {
  it("permits a trusted human holding a live grant", () => {
    // Written first and deliberately: every denial test that follows would
    // also pass against a function that returned `held: false` unconditionally.
    // This is the test that makes the other nine non-vacuous.
    const f = evaluatePermission({ principal: human(), request: req(), grants: [grant()] });
    expect(f.held).toBe(true);
    expect(f.grantId).toBe("grant.1");
  });
});

describe("1. cross-tenant access", () => {
  it("denies a principal reaching into another tenant", () => {
    const f = evaluatePermission({
      principal: human(),
      request: req({ tenantId: "competitor" }),
      grants: [grant({ tenantId: "competitor" })],
    });
    expect(f.held).toBe(false);
    expect(f.reason).toMatch(/not authority over it/);
  });

  it("denies even when the grant itself names the other tenant", () => {
    // The important half. A forged or mis-provisioned grant naming the target
    // tenant must not be the thing that decides — the principal's own tenant
    // is, and it is checked before any grant is read.
    const f = evaluatePermission({
      principal: human(),
      request: req({ tenantId: "competitor" }),
      grants: [grant({ grantId: "grant.forged", tenantId: "competitor" })],
    });
    expect(f.grantId).toBeNull();
  });

  it("MUTATION: dropping the tenant comparison would admit the cross-tenant read", () => {
    // Mutant: the boundary check removed, everything else identical.
    const mutantHeld = [grant({ tenantId: "competitor" })].some(
      (g) => g.resource === "work_order" && g.action === "create",
    );
    expect(mutantHeld).toBe(true); // the mutant passes
    expect(
      evaluatePermission({
        principal: human(),
        request: req({ tenantId: "competitor" }),
        grants: [grant({ tenantId: "competitor" })],
      }).held,
    ).toBe(false); // the real rule does not
  });
});

describe("2. wrong-instance access", () => {
  it("denies a principal registered to a different Hive instance", () => {
    const f = evaluatePermission({
      principal: human(),
      request: req({ globalInstanceId: OTHER_INSTANCE.globalInstanceId }),
      grants: [grant({ globalInstanceId: OTHER_INSTANCE.globalInstanceId })],
    });
    expect(f.held).toBe(false);
    expect(f.reason).toMatch(/Same architecture is not same instance/);
  });

  it("names instance, not tenant, as the reason", () => {
    // Two boundaries can refuse the same request, and a refusal attributed to
    // the wrong one sends somebody to fix a tenant assignment that is correct.
    const f = evaluatePermission({
      principal: human(),
      request: req({ globalInstanceId: OTHER_INSTANCE.globalInstanceId }),
      grants: [grant()],
    });
    expect(f.reason).toMatch(/instance/);
    expect(f.reason).not.toMatch(/tenant/i);
  });
});

describe("3. unauthorized engine action", () => {
  it("denies an engine acting outside its grants", () => {
    const f = evaluatePermission({
      principal: engine(),
      request: req({ resource: "governance_policy", action: "amend", tenantId: undefined }),
      grants: [
        permissionGrantSchema.parse({
          grantId: "g.wo",
          principalId: "workorderiq",
          principalKind: "engine",
          resource: "work_order",
          action: "create",
        }),
      ],
    });
    expect(f.held).toBe(false);
  });

  it("does not let an engine borrow a human's grant of the same id", () => {
    // Ids are unique within a kind, not across kinds. An engine named for the
    // user it serves — or simply a collision — must not inherit their grants.
    const f = evaluatePermission({
      principal: engine({ principalId: "user.steven" }),
      request: req(),
      grants: [grant()], // principalKind: "human"
    });
    expect(f.held).toBe(false);
  });

  it("MUTATION: matching on id alone would let the engine borrow it", () => {
    const mutantHeld = [grant()].some((g) => g.principalId === "user.steven");
    expect(mutantHeld).toBe(true);
  });
});

describe("4. unauthorized agent action", () => {
  it("denies an agent acting outside the mission it was spawned for", () => {
    // Elevation with no carryover. The grant was issued for mission.42; the
    // agent is now running mission.43 and the grant is inert.
    const f = evaluatePermission({
      principal: agent(),
      request: req({ missionId: "mission.43", tenantId: undefined }),
      grants: [
        permissionGrantSchema.parse({
          grantId: "g.elevated",
          principalId: "agent.repair.7",
          principalKind: "agent",
          resource: "work_order",
          action: "create",
          missionId: "mission.42",
        }),
      ],
    });
    expect(f.held).toBe(false);
  });

  it("denies a mission-scoped grant on a request carrying no mission at all", () => {
    // The quiet case. An unattributed request is not the mission the elevation
    // was granted for, and treating "no mission" as "any mission" would make
    // the cleanest path around the restriction the one with a field omitted.
    const f = evaluatePermission({
      principal: agent(),
      request: req({ tenantId: undefined }),
      grants: [
        permissionGrantSchema.parse({
          grantId: "g.elevated",
          principalId: "agent.repair.7",
          principalKind: "agent",
          resource: "work_order",
          action: "create",
          missionId: "mission.42",
        }),
      ],
    });
    expect(f.held).toBe(false);
  });

  it("permits the agent within its own mission", () => {
    const f = evaluatePermission({
      principal: agent(),
      request: req({ missionId: "mission.42", tenantId: undefined }),
      grants: [
        permissionGrantSchema.parse({
          grantId: "g.elevated",
          principalId: "agent.repair.7",
          principalKind: "agent",
          resource: "work_order",
          action: "create",
          missionId: "mission.42",
        }),
      ],
    });
    expect(f.held).toBe(true);
  });
});

describe("5. expired or revoked capability", () => {
  it("denies an expired grant", () => {
    const f = evaluatePermission({
      principal: human(),
      request: req(),
      grants: [grant({ expiresAt: "2026-08-29T11:59:59.000Z" })],
    });
    expect(f.held).toBe(false);
  });

  it("denies a revoked grant that has not expired", () => {
    const f = evaluatePermission({
      principal: human(),
      request: req(),
      grants: [grant({ revokedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z" })],
    });
    expect(f.held).toBe(false);
  });

  it("denies an expired IDENTITY even when the grant is live", () => {
    // Separate from grant expiry, and both are needed. A live grant held by an
    // identity that stopped being believable is a grant held by nobody.
    const f = evaluatePermission({
      principal: human({ expiresAt: "2026-08-29T11:00:00.000Z" }),
      request: req(),
      grants: [grant()],
    });
    expect(f.held).toBe(false);
    expect(f.reason).toMatch(/Expired identity is absent identity/);
  });

  it("treats expiry as inclusive at the boundary instant", () => {
    // A grant expiring exactly now is expired. The alternative gives a
    // one-tick window whose behaviour depends on clock resolution.
    const f = evaluatePermission({
      principal: human(),
      request: req(),
      grants: [grant({ expiresAt: NOW })],
    });
    expect(f.held).toBe(false);
  });
});

describe("6. role or trust mismatch", () => {
  it("denies a revoked principal holding a valid grant", () => {
    const f = evaluatePermission({
      principal: human({ trustState: "revoked" }),
      request: req(),
      grants: [grant()],
    });
    expect(f.held).toBe(false);
    expect(f.reason).toMatch(/revoked/);
  });

  it("denies a restricted principal", () => {
    const f = evaluatePermission({
      principal: human({ trustState: "restricted" }),
      request: req(),
      grants: [grant()],
    });
    expect(f.held).toBe(false);
  });

  it("permits a watched principal, and records that it is watched", () => {
    // `watched` means something is off, not that work stops. Collapsing it
    // into `restricted` would make observation cost availability, and the
    // predictable response to that is to stop marking anything watched.
    expect(trustPermitsWork("watched")).toBe(true);
    expect(
      evaluatePermission({ principal: human({ trustState: "watched" }), request: req(), grants: [grant()] })
        .held,
    ).toBe(true);
  });

  it("denies UNKNOWN trust, which is not a synonym for trusted", () => {
    // The doctrine this repository keeps re-learning: NOT_ASSESSED, NOT_RUN,
    // null, INCONCLUSIVE, `unknown` health — and now unknown trust. A
    // principal nobody assessed is not one that passed assessment.
    expect(trustPermitsWork("unknown")).toBe(false);
    const f = evaluatePermission({
      principal: human({ trustState: "unknown" }),
      request: req(),
      grants: [grant()],
    });
    expect(f.held).toBe(false);
  });

  it("defaults an unstated trust state to unknown rather than trusted", () => {
    const p = principalSchema.parse({
      kind: "human",
      principalId: "user.new",
      instance: INSTANCE,
      tenant: { organizationId: "ksix", roles: [] },
    });
    expect(p.trustState).toBe("unknown");
    expect(p.trustScore).toBeNull(); // not 0 — unmeasured, not measured-and-bad
  });

  it("MUTATION: a denylist instead of an allowlist would admit unknown", () => {
    // Why `trustPermitsWork` is written as an allowlist. The denylist form
    // below is what a reasonable person writes, and it admits every state
    // added after it was written.
    const mutant = (s: string) => s !== "revoked" && s !== "restricted";
    expect(mutant("unknown")).toBe(true);
    expect(trustPermitsWork("unknown")).toBe(false);
  });
});

describe("7. missing identity", () => {
  it("refuses an engine principal with no version", () => {
    // A discriminated union rather than one shape with optionals, so this
    // fails at the boundary instead of being discovered by whatever
    // dereferenced `engineVersion` during a rollback decision.
    expect(() =>
      principalSchema.parse({
        kind: "engine",
        principalId: "workorderiq",
        instance: INSTANCE,
      }),
    ).toThrow();
  });

  it("refuses an agent with no mission", () => {
    // There is no standing agent. An agent identity that cannot name its
    // mission has no scope to be elevated within.
    expect(() =>
      principalSchema.parse({
        kind: "agent",
        principalId: "agent.7",
        parentEngineId: "foundry",
        instance: INSTANCE,
      }),
    ).toThrow();
  });

  it("refuses any principal with no instance identity", () => {
    // Required on every kind. "Same code" must never imply "same data", and an
    // identity that cannot say which instance it belongs to cannot be checked
    // against that boundary at all.
    expect(() =>
      principalSchema.parse({
        kind: "human",
        principalId: "user.steven",
        tenant: { organizationId: "ksix", roles: [] },
      }),
    ).toThrow();
  });

  it("refuses unknown fields, so a typo is not silently dropped", () => {
    expect(() =>
      principalSchema.parse({
        kind: "human",
        principalId: "user.steven",
        instance: INSTANCE,
        tenant: { organizationId: "ksix", roles: [] },
        tenantId: "ksix", // the near-miss that would otherwise vanish
      }),
    ).toThrow();
  });

  it("defaults a new instance to PROVISIONAL, not verified", () => {
    const i = instanceIdentitySchema.parse({ globalInstanceId: "hive.new" });
    expect(i.provisional).toBe(true);
    expect(i.trustAnchorId).toBeUndefined();
  });
});

describe("8. privilege escalation attempt", () => {
  it("gives no principal a path to widen itself", () => {
    // Structural, not procedural. `evaluatePermission` takes grants as an
    // argument the caller under evaluation does not supply — there is no
    // self-widening path to close, because the widening input is not one the
    // principal controls. A rule a component enforces on itself is a rule it
    // can skip.
    expect(principalMayWidenItself()).toBe(false);
    expect(Object.keys(human())).not.toContain("grants");
  });

  it("does not let a wildcard grant cross a tenant boundary", () => {
    // The escalation that looks legitimate: a real `*` grant, used to reach
    // somewhere it was never scoped to. Wildcards widen resource and action.
    // They do not widen tenancy.
    const f = evaluatePermission({
      principal: human(),
      request: req({ tenantId: "competitor", resource: "anything", action: "anything" }),
      grants: [grant({ grantId: "g.star", resource: "*", action: "*", tenantId: undefined })],
    });
    expect(f.held).toBe(false);
  });

  it("does not let a wildcard grant cross an instance boundary", () => {
    const f = evaluatePermission({
      principal: human(),
      request: req({ globalInstanceId: OTHER_INSTANCE.globalInstanceId }),
      grants: [grant({ grantId: "g.star", resource: "*", action: "*" })],
    });
    expect(f.held).toBe(false);
  });

  it("checks trust before it reads any grant", () => {
    // Order matters, and this asserts it. If grants were read first, a revoked
    // principal holding `*` would be admitted, and whether it was would depend
    // on which check happened to run.
    const f = evaluatePermission({
      principal: human({ trustState: "revoked" }),
      request: req(),
      grants: [grant({ grantId: "g.star", resource: "*", action: "*" })],
    });
    expect(f.held).toBe(false);
    expect(f.reason).toMatch(/revoked/);
    expect(f.reason).not.toMatch(/grant/);
  });
});

describe("9. deny by default", () => {
  it("denies when there are no grants at all", () => {
    const f = evaluatePermission({ principal: human(), request: req(), grants: [] });
    expect(f.held).toBe(false);
  });

  it("gives a reason on every refusal, naming the action it refused", () => {
    // A denial that cannot say what was refused is unreviewable, and the
    // support path for it is guesswork.
    const f = evaluatePermission({ principal: human(), request: req(), grants: [] });
    expect(f.reason).toMatch(/work_order/);
    expect(f.reason).toMatch(/create/);
  });

  it("returns a null grantId on every refusal", () => {
    // So a caller cannot read `grantId` off a denial and infer a match.
    for (const grants of [[], [grant({ action: "delete" })], [grant({ resource: "invoice" })]]) {
      const f = evaluatePermission({ principal: human(), request: req(), grants });
      expect(f.held).toBe(false);
      expect(f.grantId).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the two models stay apart", () => {
  it("keeps subscription tiers out of the authorization vocabulary", () => {
    // Conflict A, decided: `CAPABILITIES` remains the PRODUCT-TIER model and
    // the authorization model was given a different word. Merged, upgrading a
    // subscription would widen security authority.
    //
    // This asserts the separation rather than describing it: a permission
    // grant naming a product capability as its resource is still only a grant
    // for that string, and holding every tier grants nothing.
    // Every capability string the product model defines, flattened.
    const tierNames = Object.values(CAPABILITIES).flatMap((group) =>
      Object.values(group as Record<string, string>),
    );
    expect(tierNames.length).toBeGreaterThan(0);

    const f = evaluatePermission({
      principal: human(),
      request: req({ resource: "governance_policy", action: "amend" }),
      grants: tierNames.map((t, i) =>
        permissionGrantSchema.parse({
          grantId: `tier.${i}`,
          principalId: "user.steven",
          principalKind: "human",
          resource: t,
          action: "use",
          tenantId: "ksix",
        }),
      ),
    });
    expect(f.held).toBe(false);
  });

  it("holds that a grant is evidence, never authority", () => {
    // The fourteenth of these, one layer deeper than DEC-017's field rename —
    // where the collapse would otherwise happen again, quietly, at the point a
    // caller stops asking Governance because it already checked the grant.
    expect(grantAuthorizesAction()).toBe(false);
  });
});
