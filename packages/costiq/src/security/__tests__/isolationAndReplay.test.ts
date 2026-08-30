/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { fromString } from "../../domain/decimal.js";
import { computeShouldCost, type ShouldCostInput } from "../../core/shouldCostAndLanded.js";
import { nonCryptographicHash } from "../../core/costGraph.js";
import type { CostEvent } from "../../ports/costPorts.js";
import {
  DEFAULT_LIMITS,
  ResourceLimitError,
  TenantIsolationError,
  assertAccessible,
  assertAllOwned,
  assertSameRealm,
  assertWithinLimits,
  boundText,
  eventVisibleTo,
  redactMoney,
  safeErrorMessage,
  type TenantScope,
} from "../isolation.js";
import {
  canonicalBundleForm,
  canonicalizeDecimals,
  certifySelfConsistency,
  verifyReplay,
  type ReplayBundle,
} from "../replayCertification.js";

const scope: TenantScope = { tenantId: "acme", isTest: false };
const record = (over: Partial<{ id: string; tenantId: string; isTest: boolean }> = {}) => ({
  id: "r1",
  tenantId: "acme",
  isTest: false,
  ...over,
});

describe("one tenant's costs never reach another", () => {
  it("passes records that all belong to the caller", () => {
    expect(assertAllOwned(scope, [record(), record({ id: "r2" })], "cost bases")).toHaveLength(2);
  });

  it("REFUSES the whole request when one record is foreign", () => {
    // Not "returns the ones you own". A cost total computed from three of five
    // components is wrong without looking wrong.
    expect(() =>
      assertAllOwned(scope, [record(), record({ id: "r2", tenantId: "other" })], "cost bases"),
    ).toThrow(TenantIsolationError);
  });

  it("says how many were foreign without saying what they contained", () => {
    // An isolation error that quoted the offending row would leak exactly what
    // it exists to protect.
    try {
      assertAllOwned(scope, [record({ id: "secret-rate-2026" , tenantId: "other" })], "cost bases");
      throw new Error("should have refused");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("1 of 1");
      expect(message).not.toContain("secret-rate-2026");
      expect(message).not.toContain("other");
    }
  });

  it("explains why a partial answer is not offered", () => {
    expect(() => assertAllOwned(scope, [record({ tenantId: "other" })], "cost bases")).toThrow(
      /wrong without looking wrong/,
    );
  });

  it("REFUSES test data in a production request", () => {
    expect(() => assertSameRealm(scope, [record({ isTest: true })], "estimates")).toThrow(
      TenantIsolationError,
    );
  });

  it("REFUSES production data in a test request, which is the leak direction", () => {
    // Both directions matter and only one of them is obvious.
    const testScope: TenantScope = { tenantId: "acme", isTest: true };
    expect(() => assertSameRealm(testScope, [record({ isTest: false })], "estimates")).toThrow(
      /real data in a test is a leak/,
    );
  });

  it("checks tenant before realm, so the more serious error is the one reported", () => {
    expect(() =>
      assertAccessible(scope, [record({ tenantId: "other", isTest: true })], "estimates"),
    ).toThrow(/do not belong to this tenant/);
  });

  it("accepts an empty set without complaint", () => {
    expect(assertAccessible(scope, [], "estimates")).toEqual([]);
  });

  const event = (over: Partial<CostEvent> = {}): CostEvent => ({
    eventId: "e1",
    type: "costiq.estimate.computed",
    occurredAt: "2026-08-30T00:00:00.000Z",
    tenantId: "acme",
    subjectId: "est-1",
    causationId: null,
    correlationId: "c1",
    isTest: false,
    payload: {},
    ...over,
  });

  it("delivers an event only to its own tenant and realm", () => {
    expect(eventVisibleTo(scope, event())).toBe(true);
    expect(eventVisibleTo(scope, event({ tenantId: "other" }))).toBe(false);
    expect(eventVisibleTo(scope, event({ isTest: true }))).toBe(false);
  });
});

describe("cost figures do not end up in logs", () => {
  it("redacts currency amounts", () => {
    expect(redactMoney("Unit cost £412.80 exceeded the floor")).toBe("Unit cost [redacted] exceeded the floor");
    expect(redactMoney("$1,299.00 and €99.99")).toBe("[redacted] and [redacted]");
  });

  it("redacts bare decimals that look like rates", () => {
    // Two or more decimal places with no currency symbol is still a rate.
    expect(redactMoney("rate was 2.4075 per minute")).toBe("rate was [redacted] per minute");
  });

  it("leaves ordinary integers and single-decimal numbers alone", () => {
    // Redacting "5" would make every message useless. The eagerness is aimed
    // at things shaped like money, not at all digits.
    expect(redactMoney("5 of 12 components, at level 3.1")).toBe("5 of 12 components, at level 3.1");
  });

  it("redacts money inside an error message", () => {
    expect(safeErrorMessage(new Error("Price £51.25 is below cost £60.00"))).toBe(
      "Price [redacted] is below cost [redacted]",
    );
  });

  it("does NOT stringify a thrown non-Error", () => {
    // An arbitrary thrown value can carry a whole cost model, and `String(x)`
    // on an object with a toString is how it reaches a log.
    const hostile = { toString: () => "unit cost 412.80 for customer Acme" };
    const message = safeErrorMessage(hostile);
    expect(message).not.toContain("412.80");
    expect(message).not.toContain("Acme");
    expect(message).toContain("not logged");
  });

  it("describes the type of a thrown primitive without quoting it", () => {
    expect(safeErrorMessage("412.80")).toContain("type string");
    expect(safeErrorMessage("412.80")).not.toContain("412.80");
  });
});

describe("a caller cannot occupy a worker with one oversized request", () => {
  it("accepts a normal-sized model", () => {
    expect(() => assertWithinLimits({ nodes: 400, depth: 6, componentsInLargestNode: 30, batchSize: 50 })).not.toThrow();
  });

  it("refuses too many nodes and says what to do instead", () => {
    try {
      assertWithinLimits({ nodes: DEFAULT_LIMITS.maxNodes + 1 });
      throw new Error("should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ResourceLimitError);
      expect((error as Error).message).toContain("roll sub-assemblies up");
      expect((error as Error).message).toContain("while every other tenant waits");
    }
  });

  it("treats the limit as inclusive — exactly at it is fine", () => {
    // Off-by-one here refuses a model that is exactly at a documented limit,
    // which reads as a bug to whoever hits it.
    expect(() => assertWithinLimits({ nodes: DEFAULT_LIMITS.maxNodes })).not.toThrow();
    expect(() => assertWithinLimits({ nodes: DEFAULT_LIMITS.maxNodes + 1 })).toThrow();
  });

  it("suggests a cycle when a model is implausibly deep", () => {
    expect(() => assertWithinLimits({ depth: DEFAULT_LIMITS.maxDepth + 1 })).toThrow(/usually a cycle/);
  });

  it("refuses too many components on one node", () => {
    expect(() => assertWithinLimits({ componentsInLargestNode: DEFAULT_LIMITS.maxComponentsPerNode + 1 })).toThrow(
      /components on a single node/,
    );
  });

  it("refuses an oversized batch", () => {
    expect(() => assertWithinLimits({ batchSize: DEFAULT_LIMITS.maxBatchSize + 1 })).toThrow(/Page the request/);
  });

  it("ignores dimensions the caller did not measure", () => {
    expect(() => assertWithinLimits({})).not.toThrow();
  });

  it("truncates long free text rather than refusing it", () => {
    // Unlike a cost graph, a caveat that is too long is still worth most of.
    const long = "x".repeat(DEFAULT_LIMITS.maxTextLength + 100);
    const bounded = boundText(long);
    expect(bounded).toContain("truncated at 10000 characters");
    expect(bounded.startsWith("x".repeat(100))).toBe(true);
  });

  it("leaves text within the limit exactly as it was", () => {
    expect(boundText("a caveat")).toBe("a caveat");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const shouldCostInput: ShouldCostInput = {
  materialCost: fromString("10.00"),
  processMinutes: fromString("5"),
  processRatePerMinute: fromString("1.00"),
  setupCost: fromString("100.00"),
  setupAmortizedOverUnits: fromString("100"),
  overheadFraction: fromString("0.2"),
  supplierMarginFraction: fromString("0.15"),
  quantity: fromString("10"),
  scale: 6,
  mode: "HALF_EVEN",
  rateSource: "survey",
};

const bundle = (over: Partial<ReplayBundle> = {}): ReplayBundle => {
  const base = {
    methodId: "should-cost",
    methodVersion: "1.0.0",
    inputs: canonicalizeDecimals({ materialCost: shouldCostInput.materialCost, quantity: shouldCostInput.quantity }),
    asOf: "2026-08-30T00:00:00.000Z",
    outputs: canonicalizeDecimals({ shouldCostPrice: computeShouldCost(shouldCostInput).shouldCostPrice }),
    ...over,
  };
  return {
    bundleId: "b1",
    capturedAt: "2026-08-30T00:00:00.000Z",
    ...base,
    digest: over.digest ?? nonCryptographicHash.digest(canonicalBundleForm(base)),
  };
};

describe("determinism is certified, not claimed", () => {
  it("reproduces an unchanged computation", () => {
    const verdict = verifyReplay(bundle(), bundle());
    expect(verdict.reproduced).toBe(true);
  });

  it("digests the same regardless of the order fields were built in", () => {
    // Otherwise a refactor that reorders two assignments looks like a
    // determinism failure, and people learn to ignore the check.
    const a = canonicalBundleForm({
      methodId: "m", methodVersion: "1", asOf: "t",
      inputs: { b: "2", a: "1" }, outputs: { y: "2", x: "1" },
    });
    const b = canonicalBundleForm({
      methodId: "m", methodVersion: "1", asOf: "t",
      inputs: { a: "1", b: "2" }, outputs: { x: "1", y: "2" },
    });
    expect(a).toBe(b);
  });

  it("blames a version change on the version, not on the arithmetic", () => {
    const verdict = verifyReplay(bundle(), bundle({ methodVersion: "2.0.0" }));
    expect(verdict.reproduced).toBe(false);
    if (!verdict.reproduced) {
      expect(verdict.cause).toBe("METHOD_VERSION_CHANGED");
      expect(verdict.explanation).toContain("expected when a method is versioned");
    }
  });

  it("blames a changed input on the input", () => {
    const verdict = verifyReplay(bundle(), bundle({ inputs: { materialCost: "99.00", quantity: "10" } }));
    if (!verdict.reproduced) {
      expect(verdict.cause).toBe("INPUTS_CHANGED");
      expect(verdict.inputDivergences.map((d) => d.field)).toEqual(["materialCost"]);
      expect(verdict.explanation).toContain("The engine is behaving correctly");
    } else {
      throw new Error("should not have reproduced");
    }
  });

  it("treats a different as-of time as a changed input, because time IS one", () => {
    const verdict = verifyReplay(bundle(), bundle({ asOf: "2026-09-30T00:00:00.000Z" }));
    if (!verdict.reproduced) {
      expect(verdict.cause).toBe("INPUTS_CHANGED");
      expect(verdict.explanation).toContain("Time is an input here");
    } else {
      throw new Error("should not have reproduced");
    }
  });

  it("calls it UNEXPLAINED when nothing changed and the answer did", () => {
    // The real defect, and the whole reason the other two causes are separated
    // out — so this one is not lost among the expected differences.
    const verdict = verifyReplay(bundle(), bundle({ outputs: { shouldCostPrice: "999" } }));
    if (!verdict.reproduced) {
      expect(verdict.cause).toBe("UNEXPLAINED");
      expect(verdict.explanation).toContain("a real determinism defect");
      expect(verdict.explanation).toContain("a clock read inside the calculation");
      expect(verdict.explanation).toContain("shouldCostPrice");
    } else {
      throw new Error("should not have reproduced");
    }
  });

  it("reports divergences in a stable order", () => {
    // A determinism check whose own report reorders itself is a poor joke.
    const verdict = verifyReplay(bundle(), bundle({ inputs: { zeta: "1", alpha: "2" } }));
    if (!verdict.reproduced) {
      expect(verdict.inputDivergences.map((d) => d.field)).toEqual(["alpha", "materialCost", "quantity", "zeta"]);
    }
  });

  it("reports a field that is absent on one side", () => {
    const verdict = verifyReplay(bundle(), bundle({ inputs: { materialCost: "10.00" } }));
    if (!verdict.reproduced) {
      const missing = verdict.inputDivergences.find((d) => d.field === "quantity")!;
      expect(missing.recorded).toBe("10");
      expect(missing.replayed).toBeUndefined();
    }
  });

  it("certifies the real should-cost calculation as self-consistent", () => {
    const result = certifySelfConsistency(
      () => computeShouldCost(shouldCostInput),
      (r) => canonicalBundleForm({
        methodId: "should-cost", methodVersion: "1.0.0", asOf: "fixed",
        inputs: {}, outputs: canonicalizeDecimals({ price: r.shouldCostPrice, cost: r.supplierCost }),
      }),
    );
    expect(result.consistent).toBe(true);
    expect(result.note).toContain("does not rule out drift between versions");
  });

  it("catches a calculation that reads something changing between calls", () => {
    // The control for this whole module: a deliberately non-deterministic
    // computation must be caught, or the certification proves nothing.
    let counter = 0;
    const result = certifySelfConsistency(
      () => (counter += 1),
      (n) => String(n),
    );
    expect(result.consistent).toBe(false);
    expect(result.note).toContain("Run 2 of 3 disagreed");
    expect(result.note).toContain("most likely a clock");
  });
});
