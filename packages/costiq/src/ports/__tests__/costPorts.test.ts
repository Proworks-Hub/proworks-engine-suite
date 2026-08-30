/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { COSTIQ_DOES_NOT_OWN } from "../../charter.js";
import { fromString } from "../../domain/decimal.js";
import {
  CONSEQUENCE_CONTRACTS,
  COST_EVENT_TYPES,
  NULL_OBSERVABILITY,
  consequenceContractFor,
  costEventSchema,
  decimalMayBeALabel,
  sanitizeLabels,
} from "../costPorts.js";
import {
  COSTIQ_OFFERS,
  INBOUND_REQUEST_KINDS,
  OUT_OF_SCOPE_SIGNALS,
  acceptInbound,
  assessScope,
  capabilityFor,
  exclusionById,
  findContractGaps,
  inboundRequestSchema,
} from "../costIntegration.js";

// ─────────────────────────────────────────────────────────────────────────────
// The boundary is only a boundary if something checks it. These tests are that
// something.
// ─────────────────────────────────────────────────────────────────────────────

const request = (over: Record<string, unknown> = {}) => ({
  requestId: "r1",
  kind: "COMPUTE_ESTIMATE",
  tenantId: "t1",
  requestedBy: "ForgeIQ",
  subjectId: "estimate-1",
  isTest: false,
  parameters: {},
  ...over,
});

describe("events say what they do NOT entitle a consumer to conclude", () => {
  it("has a consequence contract for every event type", () => {
    for (const type of COST_EVENT_TYPES) {
      expect(CONSEQUENCE_CONTRACTS[type]).toBeDefined();
    }
  });

  it("states a prohibition for every one of them", () => {
    // The half that gets forgotten. Nothing fails when a downstream engine
    // infers the wrong thing — it just quietly starts making decisions.
    for (const type of COST_EVENT_TYPES) {
      expect(consequenceContractFor(type).doesNotEntitle.length).toBeGreaterThan(0);
    }
  });

  it("keeps the ledger posting out of a standard-cost change", () => {
    // The single most likely boundary crossing in this engine. The standard
    // cost moved; the revaluation is Finance IQ's to post.
    const contract = consequenceContractFor("costiq.standard_cost.changed");
    expect(contract.doesNotEntitle.join()).toContain("Finance IQ's to decide and post");
    expect(contract.expectedActors).toContain("Finance IQ");
  });

  it("refuses to let a computed estimate be read as approved, or as a price", () => {
    const contract = consequenceContractFor("costiq.estimate.computed");
    expect(contract.doesNotEntitle.join()).toContain("never a decision about what to charge");
    expect(contract.doesNotEntitle.join()).toContain("Computation is not approval");
  });

  it("keeps a stale rate in use rather than discarding it", () => {
    // Replacing weak evidence with no evidence is worse, and the alternative
    // gets chosen surprisingly often because it feels safer.
    expect(consequenceContractFor("costiq.basis.went_stale").doesNotEntitle.join()).toContain(
      "replacing it with nothing is worse",
    );
  });

  it("forbids adjusting a standard to make a variance disappear", () => {
    expect(consequenceContractFor("costiq.variance.detected").doesNotEntitle.join()).toContain(
      "destroys the signal",
    );
  });

  it("keeps superseded estimates readable", () => {
    expect(consequenceContractFor("costiq.estimate.superseded").doesNotEntitle.join()).toContain(
      "stays readable",
    );
  });
});

describe("the event envelope fails closed on identity", () => {
  const event = (over: Record<string, unknown> = {}) => ({
    eventId: "e1",
    type: "costiq.estimate.computed",
    occurredAt: "2026-08-30T00:00:00.000Z",
    tenantId: "t1",
    subjectId: "estimate-1",
    causationId: null,
    correlationId: "c1",
    isTest: false,
    payload: {},
    ...over,
  });

  it("accepts a complete event", () => {
    expect(costEventSchema.safeParse(event()).success).toBe(true);
  });

  it("REFUSES an event that does not say whether it is a test", () => {
    // No default. An event that forgets to say is an event that lands in
    // production data, which is exactly the defect that put four test work
    // orders into a live database earlier in this project.
    const { isTest, ...withoutTestIdentity } = event();
    expect(costEventSchema.safeParse(withoutTestIdentity).success).toBe(false);
  });

  it("refuses an event with no tenant", () => {
    const { tenantId, ...withoutTenant } = event();
    expect(costEventSchema.safeParse(withoutTenant).success).toBe(false);
  });

  it("requires causationId to be present even when it is null", () => {
    // Nullable, not optional. "There was no cause" and "nobody recorded the
    // cause" are different facts, and a chain that cannot distinguish them
    // cannot be traced back.
    const { causationId, ...withoutCausation } = event();
    expect(costEventSchema.safeParse(withoutCausation).success).toBe(false);
    expect(costEventSchema.safeParse(event({ causationId: null })).success).toBe(true);
  });

  it("refuses an unknown event type", () => {
    expect(costEventSchema.safeParse(event({ type: "costiq.price.decided" })).success).toBe(false);
  });

  it("refuses extra fields", () => {
    expect(costEventSchema.safeParse(event({ authoritative: true })).success).toBe(false);
  });
});

describe("metric labels are a publication surface", () => {
  it("drops anything that is not a known label key", () => {
    const result = sanitizeLabels({ tenantId: "t1", customerName: "Acme Ltd", unitCost: "412.80" });
    expect(result.labels).toEqual({ tenantId: "t1" });
    expect([...result.dropped].sort()).toEqual(["customerName", "unitCost"]);
  });

  it("reports what it dropped rather than dropping it silently", () => {
    // A caller who added a label in good faith should find out it did not
    // survive, instead of wondering why their dashboard is empty.
    expect(sanitizeLabels({ nope: "x" }).dropped).toEqual(["nope"]);
  });

  it("stringifies known keys given a boolean or a number", () => {
    expect(sanitizeLabels({ isTest: true }).labels).toEqual({ isTest: "true" });
  });

  it("drops a known key carrying an object, rather than stringifying it", () => {
    expect(sanitizeLabels({ tenantId: { id: "t1" } }).dropped).toEqual(["tenantId"]);
  });

  it("never allows a cost figure to be a label", () => {
    // A unit cost on a dashboard is a unit cost published to everybody who can
    // see the dashboard. Asserted rather than commented.
    expect(decimalMayBeALabel(fromString("412.80"))).toBe(false);
  });

  it("offers a null port so a host that binds none still runs", () => {
    expect(() => {
      NULL_OBSERVABILITY.count("x", {});
      NULL_OBSERVABILITY.observeDuration("x", 1, {});
      NULL_OBSERVABILITY.note("x", {});
    }).not.toThrow();
  });
});

describe("the charter is enforced at the door, not just documented", () => {
  it("accepts an ordinary request", () => {
    const outcome = acceptInbound(request({ statedIntent: "Cost this fire pit for a quote." }));
    expect(outcome.accepted).toBe(true);
  });

  it("accepts a request with no stated intent", () => {
    // Not stating an intent is normal, and it cannot be made mandatory without
    // teaching callers to type something meaningless.
    expect(acceptInbound(request()).accepted).toBe(true);
  });

  it("REFUSES a request to pick the cheapest supplier", () => {
    const outcome = acceptInbound(
      request({ kind: "COMPARE_ALTERNATIVES", statedIntent: "Compare the three suppliers and pick the cheapest." }),
    );
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) {
      expect(outcome.refusedBecause).toBe("OUT_OF_SCOPE");
      expect(outcome.refusal).toContain("Procurement");
    }
  });

  it("REFUSES a request to post an inventory revaluation", () => {
    const outcome = acceptInbound(request({ statedIntent: "The standard changed, so revalue the stock." }));
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.refusal).toContain("Finance IQ");
  });

  it("REFUSES a request to optimise the margin", () => {
    const outcome = acceptInbound(
      request({ kind: "DERIVE_PRICE_FROM_COST", statedIntent: "Optimise the margin against what the market will bear." }),
    );
    expect(outcome.accepted).toBe(false);
  });

  it("REFUSES a request to approve something because it is cheaper", () => {
    const outcome = acceptInbound(request({ statedIntent: "Proceed automatically if it is cheaper." }));
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.refusedBecause).toBe("OUT_OF_SCOPE");
  });

  it("names the owning engine so the caller knows where to go instead", () => {
    // A refusal that does not route the caller somewhere is a dead end, and a
    // dead end is what makes people work around the boundary.
    const outcome = acceptInbound(request({ statedIntent: "Work out product line profitability." }));
    if (!outcome.accepted) {
      expect(outcome.refusal).toContain("This is ProfitabilityIQ's to answer, not CostIQ's");
      expect(outcome.refusal).toContain("CostIQ will supply the cost figures that ProfitabilityIQ needs");
    } else {
      throw new Error("should have been refused");
    }
  });

  it("matches case-insensitively", () => {
    expect(acceptInbound(request({ statedIntent: "PICK THE CHEAPEST" })).accepted).toBe(false);
  });

  it("refuses a malformed request separately from an out-of-scope one", () => {
    const outcome = acceptInbound({ requestId: "r1" });
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.refusedBecause).toBe("MALFORMED");
  });

  it("refuses a request that does not say whether it is a test", () => {
    const { isTest, ...withoutTestIdentity } = request();
    expect(acceptInbound(withoutTestIdentity).accepted).toBe(false);
  });

  it("refuses an unknown request kind rather than passing it through", () => {
    expect(acceptInbound(request({ kind: "SELECT_SUPPLIER" })).accepted).toBe(false);
  });

  it("caps stated intent, because it is untrusted free text", () => {
    expect(inboundRequestSchema.safeParse(request({ statedIntent: "x".repeat(501) })).success).toBe(false);
  });

  it("returns the charter exclusion behind a refusal, for a host to render", () => {
    expect(exclusionById("ledger")?.ownedBy).toContain("Finance IQ");
    expect(exclusionById("not-a-real-exclusion")).toBeNull();
  });

  it("treats scope assessment as pure, so the same request always decides the same way", () => {
    const r = request({ statedIntent: "pick the cheapest" });
    expect(assessScope(inboundRequestSchema.parse(r))).toEqual(assessScope(inboundRequestSchema.parse(r)));
  });
});

describe("what CostIQ offers is declared, not inferred from the implementation", () => {
  it("declares a capability for every request kind it accepts", () => {
    for (const kind of INBOUND_REQUEST_KINDS) {
      expect(() => capabilityFor(kind)).not.toThrow();
    }
  });

  it("throws a useful error for an undeclared kind", () => {
    expect(() => capabilityFor("SELECT_SUPPLIER" as never)).toThrow(/Every request kind must be declared/);
  });

  it("states the limit of every capability before somebody builds on it", () => {
    for (const offer of COSTIQ_OFFERS) {
      expect(offer.caveat.length).toBeGreaterThan(0);
    }
  });

  it("says explicitly that ranking is not choosing", () => {
    expect(capabilityFor("COMPARE_ALTERNATIVES").caveat).toContain("Ranking is not choosing");
  });

  it("says explicitly that a cost-derived price is not a commercial decision", () => {
    expect(capabilityFor("DERIVE_PRICE_FROM_COST").caveat).toContain("commercial decision CostIQ does not own");
  });

  it("says frozen estimates are never recomputed", () => {
    expect(capabilityFor("RECOMPUTE_ESTIMATE").caveat).toContain("That is the point of freezing them");
  });
});

describe("contract completeness is checked, because the gap is silent", () => {
  it("finds no gaps in the shipped contracts", () => {
    const gaps = findContractGaps(CONSEQUENCE_CONTRACTS);
    // Printed rather than counted, so a failure says what to fix.
    expect(gaps.map((g) => `${g.what}: missing ${g.missing}`)).toEqual([]);
  });

  it("detects an event type with no consequence contract", () => {
    // The drift this guards against: somebody adds an event and forgets the
    // half that says what it does not entitle a consumer to conclude.
    const incomplete = { ...CONSEQUENCE_CONTRACTS } as Record<string, unknown>;
    delete incomplete["costiq.variance.detected"];
    const gaps = findContractGaps(incomplete);
    expect(gaps.some((g) => g.what.includes("costiq.variance.detected"))).toBe(true);
    expect(gaps[0]!.consequence).toContain("inferred wrongly");
  });

  it("detects a charter exclusion with no signals behind it", () => {
    // Documented but not enforced: the request still reaches the engine and is
    // served. Injected rather than shipped, because the shipped table is
    // complete — which is why this branch needed a way to be exercised at all.
    const gaps = findContractGaps(CONSEQUENCE_CONTRACTS, { ledger: [] });
    expect(gaps.some((g) => g.what.includes("ledger") && g.missing.includes("out-of-scope signals"))).toBe(true);
    expect(gaps.find((g) => g.what.includes("ledger"))!.consequence).toContain("accepted and served");
  });

  it("detects a BLANK signal, which would refuse everything", () => {
    // The opposite failure and a nastier one: a blank string is a substring of
    // every intent, so the engine would refuse every request as out of scope.
    const gaps = findContractGaps(CONSEQUENCE_CONTRACTS, { ledger: ["revalu", "  "] });
    expect(gaps.some((g) => g.missing.includes("one of them is blank"))).toBe(true);
  });

  it("detects a request kind with no declared capability", () => {
    const gaps = findContractGaps(CONSEQUENCE_CONTRACTS, OUT_OF_SCOPE_SIGNALS, [
      ...COSTIQ_OFFERS.filter((o) => o.kind !== "COMPUTE_VARIANCE"),
    ]);
    expect(gaps.some((g) => g.what.includes("COMPUTE_VARIANCE"))).toBe(true);
    expect(gaps.find((g) => g.what.includes("COMPUTE_VARIANCE"))!.consequence).toContain(
      "cannot find out what comes back",
    );
  });

  it("detects a capability claiming an event that does not exist", () => {
    const gaps = findContractGaps(CONSEQUENCE_CONTRACTS, OUT_OF_SCOPE_SIGNALS, [
      { ...COSTIQ_OFFERS[0]!, mayEmit: ["costiq.price.decided" as never] },
    ]);
    expect(gaps.some((g) => g.missing.includes("costiq.price.decided"))).toBe(true);
  });

  it("detects a capability with no caveat", () => {
    const gaps = findContractGaps(CONSEQUENCE_CONTRACTS, OUT_OF_SCOPE_SIGNALS, [
      { ...COSTIQ_OFFERS[0]!, caveat: "  " },
    ]);
    expect(gaps.some((g) => g.missing === "a caveat")).toBe(true);
  });

  it("has signals behind every charter exclusion", () => {
    // An exclusion with no signals is documented but not enforced.
    for (const excluded of COSTIQ_DOES_NOT_OWN) {
      expect(OUT_OF_SCOPE_SIGNALS[excluded.id]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("keeps every exclusion's `arrivesAs`, which is the part a reviewer needs", () => {
    for (const excluded of COSTIQ_DOES_NOT_OWN) {
      expect(excluded.arrivesAs.trim().length).toBeGreaterThan(0);
    }
  });

  it("declares only events that actually exist", () => {
    for (const offer of COSTIQ_OFFERS) {
      for (const event of offer.mayEmit) {
        expect(COST_EVENT_TYPES).toContain(event);
      }
    }
  });
});
