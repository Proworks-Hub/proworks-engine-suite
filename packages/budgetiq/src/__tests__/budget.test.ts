// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  allocateExact,
  applyLiquidation,
  availability,
  carryForward,
  deriveTransfer,
  outstandingMinor,
  phase,
  releaseCommitment,
  type ChannelValue,
  type Commitment,
} from "../kernel.js";

const observed = (minor: bigint): ChannelValue => ({ state: "observed", minor });
const partial = (minor: bigint, reason: string): ChannelValue => ({ state: "partial", minor, reason });
const unavailable = (reason: string): ChannelValue => ({ state: "unavailable", reason });

const baseInputs = {
  scopeRef: "dept.engineering",
  asOf: "2026-08-30",
  authorizedMinor: 9_600_000n, // £96,000 authorized
  releasedMinor: 4_000_000n, // £40,000 released — the consumable base (F-2)
  actualConsumption: observed(1_200_000n),
  outstandingCommitments: observed(700_000n),
  transfersNet: observed(100_000n),
  carryForwardIn: observed(0n),
  pendingConsumption: observed(250_000n),
};

describe("§16.3 availability — unknown is never zero and never healthy", () => {
  it("complete: every channel observed produces the exact equation", () => {
    const r = availability(baseInputs);
    expect(r.completeness).toBe("complete");
    // 4,000,000 − 1,200,000 − 700,000 + 100,000 + 0
    expect(r.availableMinor).toBe(2_200_000n);
    expect(r.availableUpperBoundMinor).toBeNull();
    // Both numbers reported: authorized and released are materially different statements.
    expect(r.authorizedMinor).toBe(9_600_000n);
    expect(r.consumableBaseMinor).toBe(4_000_000n);
    // Pending is NEVER netted: the complete figure ignores ANTICIPATED.
    expect(r.pendingConsumption).toEqual(observed(250_000n));
  });
  it("partial consumption channel: available is NULL, the bound is NAMED an upper bound", () => {
    const r = availability({
      ...baseInputs,
      actualConsumption: partial(1_200_000n, "actuals feed cut off at 2026-08-15"),
    });
    expect(r.completeness).toBe("partial");
    expect(r.availableMinor).toBeNull();
    expect(r.availableUpperBoundMinor).toBe(2_200_000n);
    expect(r.channelReasons.join(" ")).toContain("2026-08-15");
  });
  it("partial ADDITION channel: not even an upper bound — the equation bounds nothing", () => {
    const r = availability({
      ...baseInputs,
      carryForwardIn: partial(0n, "carry-forward run not yet approved"),
    });
    expect(r.completeness).toBe("partial");
    expect(r.availableMinor).toBeNull();
    expect(r.availableUpperBoundMinor).toBeNull();
  });
  it("unavailable channel: undeterminable, both figures null, channel named — result still returned", () => {
    const r = availability({
      ...baseInputs,
      outstandingCommitments: unavailable("CommitmentPort unbound: ProcurementIQ does not exist"),
    });
    expect(r.completeness).toBe("undeterminable");
    expect(r.availableMinor).toBeNull();
    expect(r.availableUpperBoundMinor).toBeNull();
    expect(r.channelStates.outstandingCommitments).toBe("unavailable");
    expect(r.channelReasons.join(" ")).toContain("ProcurementIQ");
    // What IS known is still carried.
    expect(r.consumableBaseMinor).toBe(4_000_000n);
  });
  it("guard 12 property: for ALL inputs with any unavailable channel, available === null", () => {
    const channels = ["actualConsumption", "outstandingCommitments", "transfersNet", "carryForwardIn"] as const;
    for (const name of channels) {
      for (const amount of [0n, 1n, 999_999n]) {
        const inputs = { ...baseInputs, releasedMinor: amount, [name]: unavailable("gone") };
        const r = availability(inputs);
        expect(r.availableMinor, name).toBeNull();
        expect(r.availableUpperBoundMinor, name).toBeNull();
      }
    }
  });
});

const po = (originalMinor: bigint): Commitment => ({
  commitmentRef: "po-1001",
  effectivePeriod: "2026-Q4",
  state: "COMMITTED",
  originalMinor,
  liquidatedMinor: 0n,
  releasedMinor: 0n,
  unencumberedActualMinor: 0n,
  overLiquidated: false,
});

describe("§16.4 encumbrance lifecycle — I-4: liquidation is availability-neutral", () => {
  it("partial then final liquidation: outstanding falls exactly as actuals rise", () => {
    const first = applyLiquidation(po(1_000_000n), 300_000n);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.state).toBe("PARTIALLY_LIQUIDATED");
    expect(outstandingMinor(first.value)).toBe(700_000n);
    const second = applyLiquidation(first.value, 700_000n);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.state).toBe("LIQUIDATED");
    expect(outstandingMinor(second.value)).toBe(0n);
    expect(second.value.overLiquidated).toBe(false);
  });
  it("over-liquidation: applied to outstanding, excess recorded SEPARATELY, flagged, never absorbed", () => {
    const r = applyLiquidation(po(1_000_000n), 1_250_000n);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("LIQUIDATED");
    expect(r.value.liquidatedMinor).toBe(1_000_000n); // up to outstanding
    expect(r.value.unencumberedActualMinor).toBe(250_000n); // the excess, named
    expect(r.value.overLiquidated).toBe(true);
    // The commitment itself is NOT adjusted upward.
    expect(r.value.originalMinor).toBe(1_000_000n);
  });
  it("release restores exactly the outstanding; liquidated history stays", () => {
    const part = applyLiquidation(po(1_000_000n), 300_000n);
    if (!part.ok) return;
    const released = releaseCommitment(part.value);
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value.state).toBe("RELEASED");
    expect(released.value.releasedMinor).toBe(700_000n);
    expect(released.value.liquidatedMinor).toBe(300_000n);
    expect(outstandingMinor(released.value)).toBe(0n);
  });
  it("a LIQUIDATED commitment refuses further liquidation", () => {
    const done = applyLiquidation(po(100n), 100n);
    if (!done.ok) return;
    const again = applyLiquidation(done.value, 1n);
    expect(!again.ok && again.refusal.kind).toBe("LIQUIDATION_TARGET_INVALID");
  });
});

describe("§16.8 carry-forward — a required policy, never an edit", () => {
  const open = [po(1_000_000n), { ...po(500_000n), commitmentRef: "po-1002" }];
  it("an unselected policy refuses: an appropriations decision is not made silently", () => {
    const r = carryForward(open, "2026-Q4", "2027-Q1", undefined, 0n);
    expect(!r.ok && r.refusal.kind).toBe("CARRY_FORWARD_POLICY_UNSELECTED");
  });
  it("encumbrance-only: successors carry lineage and consume the NEXT envelope", () => {
    const r = carryForward(open, "2026-Q4", "2027-Q1", "encumbrance-only", 0n);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.successors).toHaveLength(2);
    expect(r.value.successors[0]!.effectivePeriod).toBe("2027-Q1");
    expect(r.value.successors[0]!.carriedFrom).toBe("po-1001");
    expect(r.value.successors[0]!.originalMinor).toBe(1_000_000n);
    // The closing period's records move to CARRIED_FORWARD; inputs untouched.
    expect(r.value.closingStates.every((c) => c.state === "CARRIED_FORWARD")).toBe(true);
    expect(open[0]!.state).toBe("COMMITTED");
    expect(r.value.lapsedMinor).toBe(0n);
  });
  it("lapse-all: outstanding restores to the closing period, no successors", () => {
    const r = carryForward(open, "2026-Q4", "2027-Q1", "lapse-all", 0n);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.successors).toHaveLength(0);
    expect(r.value.lapsedMinor).toBe(1_500_000n);
    expect(r.value.closingStates.every((c) => c.state === "LAPSED")).toBe(true);
  });
  it("full-appropriation additionally carries the unconsumed appropriation", () => {
    const r = carryForward(open, "2026-Q4", "2027-Q1", "full-appropriation", 750_000n);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.appropriationCarriedMinor).toBe(750_000n);
    expect(r.value.successors).toHaveLength(2);
  });
});

describe("§16.5/§16.6 allocation and phasing — exact-sum invariants I-3 and I-5", () => {
  it("adversarial: prime total over 7 children sums EXACTLY", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ childRef: `c${i}`, driver: "1" }));
    const r = allocateExact(1_000_003n, rows);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reduce((a, x) => a + x.allocatedMinor, 0n)).toBe(1_000_003n);
    // Quota: every child gets floor or floor+1.
    for (const x of r.value) {
      expect(x.allocatedMinor === 142_857n || x.allocatedMinor === 142_858n).toBe(true);
    }
  });
  it("a negative envelope reduction distributes through the same single path", () => {
    const r = allocateExact(-100n, [
      { childRef: "a", driver: "2" },
      { childRef: "b", driver: "1" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reduce((a, x) => a + x.allocatedMinor, 0n)).toBe(-100n);
  });
  it("all-zero drivers refuse — an even split is a chosen method", () => {
    const r = allocateExact(100n, [
      { childRef: "a", driver: "0" },
      { childRef: "b", driver: "0" },
    ]);
    expect(!r.ok && r.refusal.kind).toBe("NO_DRIVER_BASIS");
  });
  it("even phasing: Σ periods == annual exactly (I-5), JPY-style zero-scale amounts included", () => {
    const periods = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12"];
    const r = phase(1_000_001n, periods, "even");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reduce((a, p) => a + p.phasedMinor, 0n)).toBe(1_000_001n);
  });
  it("seasonal phasing without a supplied index refuses — deriving one is forecasting", () => {
    const r = phase(1_200n, ["Q1", "Q2"], "seasonal");
    expect(!r.ok && r.refusal.kind).toBe("SEASONAL_INDEX_NOT_SUPPLIED");
    const withIndex = phase(1_200n, ["Q1", "Q2"], "seasonal", ["1", "2"]);
    expect(withIndex.ok).toBe(true);
    if (!withIndex.ok) return;
    expect(withIndex.value).toEqual([
      { periodRef: "Q1", phasedMinor: 400n },
      { periodRef: "Q2", phasedMinor: 800n },
    ]);
  });
  it("an unselected phasing method refuses", () => {
    const r = phase(100n, ["Q1"], undefined);
    expect(!r.ok && r.refusal.kind).toBe("PHASING_METHOD_UNSELECTED");
  });
});

describe("§16.7 transfers — a VersionDerivation, with the cross-parent policy visible", () => {
  it("a same-parent transfer derives a DRAFT version", () => {
    const r = deriveTransfer({
      fromLineRef: "l1",
      toLineRef: "l2",
      amountMinor: 50_000n,
      fromParentRef: "p1",
      toParentRef: "p1",
      allowCrossParent: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.producesDraftVersion).toBe(true);
    expect(r.value.crossesParentBoundary).toBe(false);
  });
  it("a cross-parent transfer refuses when the policy in force forbids it", () => {
    const r = deriveTransfer({
      fromLineRef: "l1",
      toLineRef: "l9",
      amountMinor: 50_000n,
      fromParentRef: "p1",
      toParentRef: "p2",
      allowCrossParent: false,
    });
    expect(!r.ok && r.refusal.kind).toBe("TRANSFER_CROSSES_PARENT_BOUNDARY");
  });
});

// ── Guards for all three Family 3 packages ──────────────────────────────────

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("guards — budgetiq, scenarioiq, varianceiq", () => {
  const roots = ["budgetiq", "scenarioiq", "varianceiq"].map((p) => join(process.cwd(), "packages", p, "src"));
  const files = roots.flatMap((r) => sourceFiles(r)).map((path) => ({ path, text: readFileSync(path, "utf8") }));
  it("platform imports only; no clock; no floats-as-money; no iteration-to-tolerance", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      expect(/(?:from|import)\s+"@proworks-hub\/(?!contracts|core-kit)[a-z-]+/.test(f.text), f.path).toBe(false);
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random|Math\.round|parseFloat|toFixed\(/.test(f.text), f.path).toBe(false);
      expect(/iterationCount|convergenceThreshold/.test(f.text), f.path).toBe(false);
    }
  });
  it("GUARD-11: no convention default exists anywhere in varianceiq source", () => {
    const variance = files.filter((f) => f.path.includes("varianceiq"));
    for (const f of variance) {
      // No parameter default, assignment fallback, or nullish fallback to a
      // convention literal anywhere.
      expect(/convention\s*[:=]\s*CONVENTION|convention\s*\?\?|convention\s*=\s*["']convention\./.test(f.text), f.path).toBe(false);
    }
  });
  it("GUARD-13: no code path filters variances by materiality class", () => {
    const variance = files.filter((f) => f.path.includes("varianceiq"));
    for (const f of variance) {
      // `.filter(` followed on the same line by a class comparison — the
      // parameter list's own parens mean a [^)]* scan stops too early.
      expect(/\.filter\(.*class\s*===?\s*["'](?:material|below-threshold)/.test(f.text), f.path).toBe(false);
    }
  });
});
