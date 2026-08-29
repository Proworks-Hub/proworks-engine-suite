// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";

import {
  AuthorizationError,
  permissionGrantSchema,
  requirePermission,
  type PermissionGrant,
  type RequestContext,
} from "@proworks-hub/contracts";

import { createPrincipalAuthorizer, defaultResolvePrincipal } from "../principalAuthorizer.js";

// ─────────────────────────────────────────────────────────────────────────────
// The identity plane, actually consulted.
//
// The other half of Phase 1. `principalIdentity.test.ts` proves the rule
// refuses correctly; these prove something CALLS it — which is the difference
// between a model and a boundary, and the difference every one of this
// repository's seven declared-but-unread fields failed to make.
// ─────────────────────────────────────────────────────────────────────────────

const INSTANCE = { globalInstanceId: "hive.ksix.us-east", provisional: false };

const ctx = (over: Partial<RequestContext> = {}): RequestContext =>
  ({
    requestId: "req.1",
    tenant: { organizationId: "ksix", roles: ["owner"] },
    identity: { subject: "user.steven", kind: "user", roles: ["owner"], assertedCapabilities: [] },
    trace: { correlationId: "corr.1" },
    apiVersion: "v1",
    receivedAt: "2026-08-29T12:00:00.000Z",
    ...over,
  }) as RequestContext;

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

const authorizer = (over: Record<string, unknown> = {}) =>
  createPrincipalAuthorizer({
    instance: INSTANCE,
    grantsFor: () => [grant()],
    trustFor: () => "trusted",
    now: () => new Date("2026-08-29T12:00:00.000Z"),
    ...over,
  });

describe("an unwired host denies rather than defaulting open", () => {
  it("denies when no trust source is bound, because unknown is not trusted", () => {
    // No `trustFor`. The default is `unknown`, and unknown denies — so a host
    // that never wired a trust source finds out at wiring time instead of
    // running for a year with everything implicitly trusted.
    const a = createPrincipalAuthorizer({ instance: INSTANCE, grantsFor: () => [grant()] });
    return expect(a.can(ctx(), "create", { type: "work_order", id: "1" })).resolves.toBe(false);
  });

  it("denies when the grant store is empty", async () => {
    const a = authorizer({ grantsFor: () => [] });
    await expect(a.can(ctx(), "create", { type: "work_order", id: "1" })).resolves.toBe(false);
  });

  it("permits once trust and a grant are both present", async () => {
    // The non-vacuity check for everything above.
    const a = authorizer();
    await expect(a.can(ctx(), "create", { type: "work_order", id: "1" })).resolves.toBe(true);
  });
});

describe("what the default resolver refuses to invent", () => {
  it("builds a human principal from a user request", () => {
    const p = defaultResolvePrincipal(ctx(), INSTANCE, "trusted");
    expect(p?.kind).toBe("human");
    expect(p?.principalId).toBe("user.steven");
    expect(p?.instance.globalInstanceId).toBe("hive.ksix.us-east");
  });

  it("carries identity expiry through rather than dropping it", async () => {
    // A read of a field that would otherwise be declared and unread. An
    // expired token that still authorizes is the whole point of having expiry.
    const a = authorizer();
    const expired = ctx({
      identity: {
        subject: "user.steven",
        kind: "user",
        roles: [],
        assertedCapabilities: [],
        expiresAt: "2026-08-29T11:00:00.000Z",
      },
    });
    await expect(a.can(expired, "create", { type: "work_order", id: "1" })).resolves.toBe(false);
  });

  it("refuses to build a principal for a service caller", async () => {
    // The important refusal. An engine identity needs a version, an agent
    // needs a mission, a connector needs a provider — and the request carries
    // none of them. A default that guessed would produce a principal that
    // passes checks while naming nothing real.
    expect(
      defaultResolvePrincipal(
        ctx({ identity: { subject: "svc", kind: "service", roles: [], assertedCapabilities: [] } }),
        INSTANCE,
        "trusted",
      ),
    ).toBeNull();

    const seen: string[] = [];
    const a = authorizer({ onFinding: (e: { finding: { reason: string } }) => seen.push(e.finding.reason) });
    await expect(
      a.can(
        ctx({ identity: { subject: "svc", kind: "service", roles: [], assertedCapabilities: [] } }),
        "create",
        { type: "work_order", id: "1" },
      ),
    ).resolves.toBe(false);
    expect(seen[0]).toMatch(/inventing one would produce a principal that passes checks/);
  });

  it("refuses anonymous callers", () => {
    expect(
      defaultResolvePrincipal(
        ctx({ identity: { subject: "anon", kind: "anonymous", roles: [], assertedCapabilities: [] } }),
        INSTANCE,
        "trusted",
      ),
    ).toBeNull();
  });

  it("lets a host that knows better supply its own resolver", async () => {
    // The escape hatch, exercised — otherwise the refusal above would be a
    // wall rather than a default.
    const a = authorizer({
      resolvePrincipal: () => ({
        kind: "engine" as const,
        principalId: "workorderiq",
        engineVersion: "0.19.0",
        instance: INSTANCE,
        trustState: "trusted" as const,
        trustScore: null,
      }),
      grantsFor: () => [grant({ principalId: "workorderiq", principalKind: "engine" })],
    });
    await expect(
      a.can(
        ctx({ identity: { subject: "workorderiq", kind: "service", roles: [], assertedCapabilities: [] } }),
        "create",
        { type: "work_order", id: "1" },
      ),
    ).resolves.toBe(true);
  });
});

describe("the instance boundary is the host's, never the caller's", () => {
  it("uses the host's instance, so a request cannot name its own", async () => {
    // A caller that names its own instance names its own boundary. The
    // authorizer takes it from construction; `RequestContext` has no field for
    // it, and this asserts that stays true rather than trusting it does.
    expect(Object.keys(ctx())).not.toContain("globalInstanceId");

    const a = authorizer({ grantsFor: () => [grant({ globalInstanceId: "hive.someone-else" })] });
    await expect(a.can(ctx(), "create", { type: "work_order", id: "1" })).resolves.toBe(false);
  });
});

describe("a failed grant lookup is not an empty one", () => {
  it("denies, and says which of the two happened", async () => {
    // Both deny. Only one is somebody's outage, and the reason is the only
    // place that distinction survives — the same rule the ForgeIQ checkout
    // lookup needed, where a failed read was reporting a deleted design.
    const seen: string[] = [];
    const a = authorizer({
      grantsFor: () => {
        throw new Error("grant store unreachable");
      },
      onFinding: (e: { finding: { reason: string } }) => seen.push(e.finding.reason),
    });
    await expect(a.can(ctx(), "create", { type: "work_order", id: "1" })).resolves.toBe(false);
    expect(seen[0]).toMatch(/A failed lookup is not an empty one/);
  });

  it("does not throw out of can()", async () => {
    // `requirePermission` is what throws. An authorizer that threw would make
    // an unreachable store indistinguishable from a denial at the call site.
    const a = authorizer({
      grantsFor: () => Promise.reject(new Error("boom")),
    });
    await expect(a.can(ctx(), "create")).resolves.toBe(false);
  });
});

describe("findings are observable", () => {
  it("reports allowed decisions as well as denied ones", async () => {
    // A hook that fired only on denial could not answer "was this check even
    // running", and a check nobody can prove ran is not a check.
    const onFinding = vi.fn();
    const a = authorizer({ onFinding });
    await a.can(ctx(), "create", { type: "work_order", id: "1" });
    expect(onFinding).toHaveBeenCalledTimes(1);
    expect(onFinding.mock.calls[0]?.[0]?.finding?.held).toBe(true);
    expect(onFinding.mock.calls[0]?.[0]?.permission).toBe("create");
  });
});

describe("it plugs into the enforcement point that already exists", () => {
  it("throws AuthorizationError through requirePermission", async () => {
    // No new enforcement path. `requirePermission` is the existing throw, and
    // this is one implementation of the port it already takes.
    const a = authorizer({ grantsFor: () => [] });
    await expect(
      requirePermission(a, ctx(), "create", { type: "work_order", id: "1" }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("passes when the grant is held", async () => {
    await expect(
      requirePermission(authorizer(), ctx(), "create", { type: "work_order", id: "1" }),
    ).resolves.toBeUndefined();
  });
});

describe("a permission with no resource is not a permission over everything", () => {
  it("scopes an unresourced check to the permission string itself", async () => {
    // The quiet widening. If a missing `resource` fell back to a wildcard, the
    // laziest call site would be the most powerful one.
    const a = authorizer({ grantsFor: () => [grant({ resource: "work_order" })] });
    await expect(a.can(ctx(), "create")).resolves.toBe(false);

    const b = authorizer({ grantsFor: () => [grant({ resource: "create" })] });
    await expect(b.can(ctx(), "create")).resolves.toBe(true);
  });
});
