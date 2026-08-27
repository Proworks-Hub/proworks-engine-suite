// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import {
  assertNoIdentityFields,
  causedBy,
  newBackgroundTrace,
  newCorrelationId,
  ownerRefFor,
  tenantContextSchema,
  traceContextSchema,
  type Canonical,
  type TenantContext,
} from "../index.js";

describe("tenant context", () => {
  it("requires an organization", () => {
    // Optional tenancy cannot distinguish "not applicable" from "somebody
    // forgot", and one of those is a data leak.
    expect(() => tenantContextSchema.parse({ shopId: "s1" })).toThrow();
  });

  it("rejects unknown fields rather than carrying them along", () => {
    expect(() =>
      tenantContextSchema.parse({ organizationId: "o1", sneaky: "value" }),
    ).toThrow();
  });

  it("defaults roles to empty rather than undefined", () => {
    expect(tenantContextSchema.parse({ organizationId: "o1" }).roles).toEqual([]);
  });

  it("derives a stable, greppable owner reference", () => {
    const ctx: TenantContext = { organizationId: "acme", shopId: "denver", roles: [] };
    expect(ownerRefFor(ctx)).toBe("org:acme/shop:denver");
    expect(ownerRefFor({ organizationId: "acme", roles: [] })).toBe("org:acme");
  });

  it("gives the same owner reference for the same context", () => {
    const a = ownerRefFor({ organizationId: "acme", roles: [] });
    const b = ownerRefFor({ organizationId: "acme", roles: ["admin"] });
    // Roles are authorization, not identity — they must not change ownership.
    expect(a).toBe(b);
  });
});

describe("the canonical boundary", () => {
  it("refuses an organization id", () => {
    expect(() => assertNoIdentityFields({ organizationId: "acme" })).toThrow(/must not identify/i);
  });

  it("refuses a shop id", () => {
    expect(() => assertNoIdentityFields({ shopId: "denver" })).toThrow();
  });

  it("refuses one buried in metadata", () => {
    expect(() => assertNoIdentityFields({ meta: { deep: { userId: "u1" } } })).toThrow();
  });

  it("refuses one hidden in an array", () => {
    expect(() => assertNoIdentityFields({ rows: [{ ok: 1 }, { ownerRef: "x" }] })).toThrow();
  });

  it("allows an ordinary canonical record", () => {
    expect(() =>
      assertNoIdentityFields({ itemKey: "steel bar", merchantKey: "homedepot", region: "US-CO" }),
    ).not.toThrow();
  });

  it("does not cry wolf on words that merely contain a banned one", () => {
    // `ownership` contains `owner`; `personalization` contains `person`. A
    // guard that fires on these gets switched off, which is worse than none.
    expect(() =>
      assertNoIdentityFields({ ownership: "canonical", personalization: "none" }),
    ).not.toThrow();
  });

  it("makes tenancy on a canonical record a compile error", () => {
    type SharedPrice = Canonical<{ itemKey: string; cents: number }>;
    const good: SharedPrice = { ownership: "canonical", itemKey: "steel", cents: 1897 };
    expect(good.itemKey).toBe("steel");

    // @ts-expect-error — a canonical record cannot carry an organizationId.
    const bad: SharedPrice = { ownership: "canonical", itemKey: "steel", cents: 1, organizationId: "acme" };
    // The runtime guard agrees with the type system.
    expect(() => assertNoIdentityFields(bad)).toThrow();
  });
});

describe("trace context", () => {
  it("mints distinct correlation ids", () => {
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });

  it("keeps the correlation while advancing causation", () => {
    const root = { correlationId: newCorrelationId() };
    const step = causedBy(root, "plan-generated");
    expect(step.correlationId).toBe(root.correlationId);
    expect(step.causationId).toBe("plan-generated");
  });

  it("carries an OpenTelemetry trace id through the chain when the host supplies one", () => {
    const root = { correlationId: "cor_1", traceId: "trace_abc", spanId: "span_1" };
    const step = causedBy(root, "cost-calculated");
    expect(step.traceId).toBe("trace_abc");
    expect(step.spanId).toBe("span_1");
  });

  it("names background work so it is obvious in a log", () => {
    expect(newBackgroundTrace("nightly-reprice").correlationId).toMatch(/^bg-nightly-reprice_/);
  });

  it("requires a correlation id and refuses unknown fields", () => {
    expect(() => traceContextSchema.parse({})).toThrow();
    expect(() => traceContextSchema.parse({ correlationId: "c", extra: 1 })).toThrow();
  });
});
