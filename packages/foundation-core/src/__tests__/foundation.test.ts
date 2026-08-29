// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import {
  acceptsConsequentialWork,
  actorId,
  createAllowAllGovernanceForTests,
  engineId,
  healthGrantsAuthority,
  healthStateSchema,
  tenantId,
  type RequestContext,
} from "@proworks-hub/contracts";

import {
  buildReference,
  createFoundationCoordinator,
  createFoundationRegistry,
  foundationCapabilitySchema,
  mintIdentifier,
  parseHealthState,
  relate,
  validateIdentifier,
  versionsCompatible,
  type FoundationSpecialist,
} from "../foundation.js";

// ─────────────────────────────────────────────────────────────────────────────
// Charter: "Foundation describes structures. It does not manufacture
// authority." Most of these tests are that sentence, asked differently.
// ─────────────────────────────────────────────────────────────────────────────

const testGovernance = createAllowAllGovernanceForTests({
  env: {},
  reason: "foundation coordination tests; authorization tested in governance-engine",
});

const context = {
  requestId: "req-1",
  tenant: { organizationId: "ksix", roles: [] },
  identity: { subject: "steven", kind: "user", roles: [], assertedCapabilities: [] },
  trace: { correlationId: "cor-1" },
  apiVersion: "v1",
  receivedAt: "2026-08-28T00:00:00.000Z",
} as unknown as RequestContext;

const ref = (over: Record<string, unknown> = {}) =>
  buildReference({ kind: "entity", id: "ent_1", ownedBy: "inventoryiq", ...over });

describe("identifiers are structure, not existence and not permission", () => {
  it("accepts a well-formed identifier", () => {
    expect(validateIdentifier("eng_costiq").ok).toBe(true);
    expect(validateIdentifier("hive.customeriq").ok).toBe(true);
  });

  it("refuses malformed identifiers", () => {
    for (const bad of ["", " ", "has space", "-leading", "a".repeat(129), "semi;colon"]) {
      expect(validateIdentifier(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("says plainly that validity is not existence or permission", () => {
    // The single likeliest misreading: `ok: false` meaning "not found" or
    // "not allowed". The reason text has to close that off.
    const outcome = validateIdentifier("has space");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("nothing about existence or permission");
  });

  it("mints identifiers prefixed by kind", () => {
    // A misplaced `eng_` in a tenant field is visible on sight; a bare UUID is
    // not. Branded types do this at compile time; the prefix does it on a wire.
    expect(mintIdentifier({ kind: "engine", random: () => "abc123" })).toBe("engine_abc123");
    expect(validateIdentifier(mintIdentifier({ kind: "actor" })).ok).toBe(true);
  });

  it("refuses to mint an unkinded identifier", () => {
    expect(() => mintIdentifier({ kind: "  " })).toThrow(/needs a kind/);
  });

  it("keeps branded ids from being interchanged", () => {
    // Both are strings. Without branding, passing a tenant where an engine
    // belongs compiles — and that is a tenancy bug that typechecks.
    const e = engineId("costiq");
    const t = tenantId("ksix");
    const a = actorId("steven");
    expect([e, t, a]).toEqual(["costiq", "ksix", "steven"]);
    // @ts-expect-error a TenantId is not an EngineId, even though both are strings
    const wrong: ReturnType<typeof engineId> = t;
    void wrong;
  });
});

describe("references name their owner", () => {
  it("builds a valid reference", () => {
    expect(ref()).toMatchObject({ kind: "entity", id: "ent_1", ownedBy: "inventoryiq" });
  });

  it("refuses a reference with no owner", () => {
    // A reference that does not say who is authoritative is the beginning of
    // two engines both believing they are.
    expect(() => buildReference({ kind: "entity", id: "ent_1" })).toThrow(/which engine owns it/);
  });

  it("refuses an unknown reference kind", () => {
    // An open vocabulary lets a reference point at "whatever", and a reference
    // nobody can resolve is a broken link that reads as a working one.
    expect(() => buildReference({ kind: "whatever", id: "x", ownedBy: "y" })).toThrow();
  });

  it("refuses unknown fields", () => {
    expect(() =>
      buildReference({ kind: "entity", id: "e", ownedBy: "o", ownerBy: "typo" }),
    ).toThrow();
  });
});

describe("relationships do not create authority", () => {
  it("records a relationship and nothing resembling a grant", () => {
    // Charter: Foundation may not "infer authority from relationships." A
    // relationship carries no permission, no capability list, no access.
    const r = relate(
      ref({ kind: "actor", id: "steven", ownedBy: "identityiq" }),
      "belongs_to",
      ref({ kind: "tenant", id: "ksix", ownedBy: "foundation" }),
      "2026-08-28T00:00:00.000Z",
    );

    expect(Object.keys(r).sort()).toEqual(["from", "kind", "recordedAt", "to"]);
    const serialized = JSON.stringify(r);
    for (const forbidden of ["permission", "capabilit", "grant", "allow", "authoriz"]) {
      expect(serialized.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it("keeps the relationship vocabulary closed", () => {
    expect(() =>
      relate(ref(), "may_access" as never, ref(), "2026-08-28T00:00:00.000Z"),
    ).toThrow();
  });
});

describe("version compatibility", () => {
  it("accepts equal majors", () => {
    expect(
      versionsCompatible(
        { implementationVersion: "1.2.0", contractVersion: "3.0.0" },
        { implementationVersion: "1.9.4", contractVersion: "3.7.1" },
      ).ok,
    ).toBe(true);
  });

  it("refuses differing majors and names the dimension", () => {
    const outcome = versionsCompatible(
      { implementationVersion: "1.0.0", charterVersion: "1.0" },
      { implementationVersion: "1.0.0", charterVersion: "2.0" },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("charter");
  });

  it("ignores a dimension either side leaves unstated", () => {
    // A consumer stating no charter requirement is not claiming compatibility
    // with every charter — it is declining to constrain that dimension.
    // Treating silence as a constraint would reject working pairs.
    expect(
      versionsCompatible(
        { implementationVersion: "1.0.0" },
        { implementationVersion: "1.4.0", charterVersion: "9.0" },
      ).ok,
    ).toBe(true);
  });
});

describe("health states", () => {
  it("carries all six, including isolated and unknown", () => {
    // `isolated` is the one most easily omitted, and Sentinel containment is
    // meaningless without it: an isolated component would otherwise report as
    // unavailable, which reads as a fault to fix rather than a decision to
    // respect.
    //
    // `unknown` was added after SentinelIQ was found returning it through an
    // `as HealthState` cast — with no host self-assessment it refuses to claim
    // health, and the vocabulary had no way to say so. The doctrine was
    // already everywhere else (NOT_ASSESSED, NOT_RUN, INCONCLUSIVE); health
    // was the one place that could not express it, which is the place it
    // matters most.
    expect(healthStateSchema.options).toEqual([
      "healthy", "degraded", "recovering", "unavailable", "isolated", "unknown",
    ]);
  });

  it("accepts consequential work only when healthy or degraded", () => {
    expect(acceptsConsequentialWork("healthy")).toBe(true);
    expect(acceptsConsequentialWork("degraded")).toBe(true);
    // `unknown` included, and it needed no change to the function: the gate is
    // an allowlist, so a state nobody has assessed is refused work by default
    // rather than by remembering to add it.
    for (const s of ["recovering", "unavailable", "isolated", "unknown"] as const) {
      expect(acceptsConsequentialWork(s), s).toBe(false);
    }
  });

  it("grants no authority in any state", () => {
    // Charter §23.10: "Degraded operation shall never increase authority."
    for (const s of healthStateSchema.options) {
      expect(healthGrantsAuthority(s), s).toBe(false);
    }
  });

  it("returns null for an unrecognized state rather than guessing", () => {
    // Mapping an unknown state to `unavailable` would invent information about
    // a component nobody should assume anything about.
    expect(parseHealthState("healthy")).toBe("healthy");
    expect(parseHealthState("on fire")).toBeNull();
    expect(parseHealthState(undefined)).toBeNull();
  });
});

describe("Foundation coordinates like every other Core", () => {
  const specialist = (): FoundationSpecialist => ({
    id: "structural",
    capabilities: ["validate_identifier", "mint_identifier"],
    handle: async (request) =>
      request.capability === "mint_identifier"
        ? { id: mintIdentifier({ kind: "entity", random: () => "fixed" }) }
        : validateIdentifier((request.input as { value: string }).value),
  });

  const coordinator = () =>
    createFoundationCoordinator({
      governance: testGovernance,
      registry: createFoundationRegistry([specialist()]),
    });

  it("answers through a registered specialist", async () => {
    const outcome = await coordinator().ask({
      capability: "mint_identifier", input: {}, context, correlationId: "c1",
    });
    expect(outcome.ok && (outcome.answer.output as { id: string }).id).toBe("entity_fixed");
  });

  it("refuses a capability nobody implements", async () => {
    const outcome = await coordinator().ask({
      capability: "relate_entities", input: {}, context, correlationId: "c1",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.failure).toBe("no_specialist");
  });

  it("reports its own domain", async () => {
    expect((await coordinator().status()).core).toBe("foundation");
  });

  it("keeps its capability vocabulary small", () => {
    // Core Stability Principle: capabilities are not added to a Core because
    // they are useful. Five is a decision, and growing it should be one too.
    expect(foundationCapabilitySchema.options).toHaveLength(5);
  });
});
