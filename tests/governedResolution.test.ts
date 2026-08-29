// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";

import {
  createAllowAllGovernanceForTests,
  createDenyAllGovernance,
  governanceDecisionSchema,
  isConstitutionallyProhibited,
  isPermitted,
  type Governance,
  type GovernanceDecision,
  type RequestContext,
} from "@proworks-hub/contracts";
import {
  createCoordinator,
  createSpecialistRegistry,
  defaultAuthorityFor,
  type Specialist,
} from "@proworks-hub/core-kit";

// ─────────────────────────────────────────────────────────────────────────────
// "Capability does not imply permission." — Constitution §1.9
//
// The first constitutional doctrine the runtime enforces. Before this, resolving
// a capability WAS authorizing it: reaching a Core meant being allowed to use
// it, and the only gate was a bearer token at a router.
// ─────────────────────────────────────────────────────────────────────────────

type Cap = "calculate" | "destroy";

const context = {
  requestId: "req-1",
  tenant: { organizationId: "acme", roles: [] },
  identity: { subject: "steven", kind: "user", roles: ["operator"], assertedCapabilities: [] },
  trace: { correlationId: "cor-1" },
  apiVersion: "v1",
  receivedAt: "2026-08-28T00:00:00.000Z",
} as unknown as RequestContext;

const ask = (capability: Cap, ctx: RequestContext = context) => ({
  capability,
  input: {},
  context: ctx,
  correlationId: "cor-1",
});

const worker = (): Specialist<Cap> => ({
  id: "worker",
  capabilities: ["calculate", "destroy"],
  handle: async () => ({ done: true }),
});

const build = (governance: Governance, specialists = [worker()]) =>
  createCoordinator<Cap>({
    core: "test",
    registry: createSpecialistRegistry(specialists),
    governance,
    authorityFor: defaultAuthorityFor,
  });

const allowAll = createAllowAllGovernanceForTests({
  reason: "positive-path assertions in the governance tests themselves",
  env: {},
});

describe("Governance decides before the registry is consulted", () => {
  it("permits a capability when Governance allows it", async () => {
    const outcome = await build(allowAll).ask(ask("calculate"));
    expect(outcome.ok).toBe(true);
  });

  it("refuses with not_permitted when Governance denies", async () => {
    const outcome = await build(createDenyAllGovernance()).ask(ask("calculate"));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.failure).toBe("not_permitted");
  });

  it("never reaches the specialist when denied", async () => {
    // The assertion that matters. A denial that still executes is not a denial.
    const handle = vi.fn(async () => ({ done: true }));
    const outcome = await build(createDenyAllGovernance(), [
      { id: "worker", capabilities: ["calculate"], handle },
    ]).ask(ask("calculate"));

    expect(outcome.ok).toBe(false);
    expect(handle).not.toHaveBeenCalled();
  });

  it("asks Governance before asking the registry", async () => {
    // Ordering, proven rather than assumed. Resolving first would leak which
    // capabilities exist to a caller who may not use them.
    const order: string[] = [];
    const registry = createSpecialistRegistry<Cap>([worker()]);
    const spy = vi.spyOn(registry, "candidates");
    spy.mockImplementation((c) => {
      order.push("resolve");
      return [worker()].filter((s) => s.capabilities.includes(c));
    });

    const governance: Governance = {
      async authorize() {
        order.push("authorize");
        return { decision: "DENIED", reason: "no", conditions: [], decidedAt: "now" };
      },
    };

    await createCoordinator<Cap>({
      core: "test", registry, governance, authorityFor: defaultAuthorityFor,
    }).ask(ask("calculate"));

    expect(order).toEqual(["authorize"]);
  });

  it("distinguishes not_permitted from no_specialist", async () => {
    // "You may not" and "it does not exist" need different responses. Reporting
    // one as the other sends an operator to install an engine they already have.
    const denied = await build(createDenyAllGovernance()).ask(ask("calculate"));
    const missing = await build(allowAll, [
      { id: "worker", capabilities: ["calculate"], handle: async () => ({}) },
    ]).ask(ask("destroy"));

    expect(denied.ok || missing.ok).toBe(false);
    if (!denied.ok) expect(denied.refusal.failure).toBe("not_permitted");
    if (!missing.ok) expect(missing.refusal.failure).toBe("no_specialist");
  });
});

describe("failing closed", () => {
  it("denies when Governance itself throws", async () => {
    // Governance being unavailable is not permission.
    const broken: Governance = {
      async authorize() {
        throw new Error("policy store unreachable");
      },
    };
    const outcome = await build(broken).ask(ask("calculate"));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.failure).toBe("not_permitted");
      // Names which of the two happened. "Governance is down" and "you may not"
      // need different responses from an operator.
      expect(outcome.refusal.reason).toMatch(/could not decide/);
    }
  });

  it("denies a request whose context carries no identity", async () => {
    const outcome = await build(allowAll).ask(
      ask("calculate", { requestId: "r" } as unknown as RequestContext),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.reason).toMatch(/no identity or no tenant/);
  });

  it("treats an unconfigured Governance as denying everything", async () => {
    const outcome = await build(createDenyAllGovernance()).ask(ask("calculate"));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.reason).toMatch(/nobody is authorized/);
  });
});

describe("caller claims are evidence, never authority", () => {
  it("does not permit merely because the caller claims the capability", async () => {
    // DEC-017 in one assertion. A caller asserting `destroy` does not obtain it.
    const claiming = {
      ...context,
      identity: { ...(context as never as { identity: object }).identity, assertedCapabilities: ["destroy"] },
    } as unknown as RequestContext;

    const outcome = await build(createDenyAllGovernance()).ask(ask("destroy", claiming));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.failure).toBe("not_permitted");
  });

  it("passes claims to Governance as claims", async () => {
    // They are evidence and must reach the decision-maker — in their own field,
    // where they cannot be mistaken for a decision.
    let seen: string[] | undefined;
    const governance: Governance = {
      async authorize(envelope) {
        seen = [...(envelope.claims?.assertedCapabilities ?? [])];
        return { decision: "DENIED", reason: "recorded", conditions: [], decidedAt: "now" };
      },
    };
    const claiming = {
      ...context,
      identity: { subject: "s", kind: "user", roles: [], assertedCapabilities: ["calculate"] },
    } as unknown as RequestContext;

    await build(governance).ask(ask("calculate", claiming));
    expect(seen).toEqual(["calculate"]);
  });
});

describe("the decision vocabulary", () => {
  it("permits only PERMITTED and PERMITTED_WITH_CONDITIONS", async () => {
    // The five non-permissive outcomes include ones that mean "not yet", which
    // are the likeliest to be mistaken for success.
    const kinds = [
      "REQUIRES_ADDITIONAL_AUTHORITY",
      "REQUIRES_HUMAN_APPROVAL",
      "REQUIRES_CONSTITUTIONAL_DELIBERATION",
      "DENIED",
      "PROHIBITED",
    ] as const;

    for (const kind of kinds) {
      const outcome = await build({
        async authorize() {
          return { decision: kind, reason: kind, conditions: [], decidedAt: "now" };
        },
      }).ask(ask("calculate"));
      expect(outcome.ok, kind).toBe(false);
    }

    expect(isPermitted({ decision: "PERMITTED", reason: "y", conditions: [], decidedAt: "n" })).toBe(true);
  });

  it("separates a policy denial from a constitutional prohibition", async () => {
    // No grant or override can make a PROHIBITED action permitted. A caller must
    // not respond to it by asking for a broader policy.
    const denied: GovernanceDecision = {
      decision: "DENIED", reason: "policy", conditions: [], decidedAt: "n",
    };
    const prohibited: GovernanceDecision = {
      decision: "PROHIBITED", reason: "core protection", conditions: [], decidedAt: "n",
    };

    expect(isConstitutionallyProhibited(denied)).toBe(false);
    expect(isConstitutionallyProhibited(prohibited)).toBe(true);
  });

  it("refuses a conditional permission that states no conditions", () => {
    const parsed = governanceDecisionSchema.safeParse({
      decision: "PERMITTED_WITH_CONDITIONS",
      reason: "ok",
      conditions: [],
      decidedAt: "now",
    });
    expect(parsed.success).toBe(false);
  });

  it("requires a reason on every decision, including a permit", () => {
    // A decision nobody can explain is one nobody can audit.
    expect(
      governanceDecisionSchema.safeParse({ decision: "PERMITTED", conditions: [], decidedAt: "n" }).success,
    ).toBe(false);
  });
});

describe("permissiveness must be chosen", () => {
  it("refuses allow-all Governance in production", () => {
    expect(() =>
      createAllowAllGovernanceForTests({ reason: "x", env: { NODE_ENV: "production" } }),
    ).toThrow(/production/);
  });

  it("requires a written reason", () => {
    expect(() => createAllowAllGovernanceForTests({ reason: "  ", env: {} })).toThrow(/written reason/);
  });
});
