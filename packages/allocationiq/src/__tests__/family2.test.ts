// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { rToDecimalString } from "@proworks-hub/contracts";

import {
  distributeLargestRemainder,
  solveReciprocal,
  stepDownOrderKey,
} from "../kernel.js";

describe("largest remainder — floor-first, one rule for credits and debits", () => {
  it("distributes exactly with quota held and ties recorded", () => {
    const outcome = distributeLargestRemainder(100n, [
      { recipientRef: "cc_a", driver: "1" },
      { recipientRef: "cc_b", driver: "1" },
      { recipientRef: "cc_c", driver: "1" },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const total = outcome.value.rows.reduce((a, r) => a + r.allocatedMinor, 0n);
    expect(total).toBe(100n);
    // Quota: every allocation is 33 or 34.
    for (const row of outcome.value.rows) {
      expect(row.allocatedMinor === 33n || row.allocatedMinor === 34n).toBe(true);
    }
    // The tie was resolved by byte order and RECORDED.
    expect(outcome.value.tieBreaksApplied.length).toBeGreaterThan(0);
    expect(outcome.value.identityHolds).toBe(true);
  });
  it("a NEGATIVE pool works through the same single path — no sign branch", () => {
    const outcome = distributeLargestRemainder(-100n, [
      { recipientRef: "cc_a", driver: "2" },
      { recipientRef: "cc_b", driver: "1" },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const total = outcome.value.rows.reduce((a, r) => a + r.allocatedMinor, 0n);
    expect(total).toBe(-100n);
    const byRef = new Map(outcome.value.rows.map((r) => [r.recipientRef, r.allocatedMinor]));
    // −100 × 2/3 = −66.67 → floor −67; −100 × 1/3 → floor −34; residual +1.
    expect((byRef.get("cc_a") ?? 0n) + (byRef.get("cc_b") ?? 0n)).toBe(-100n);
  });
  it("order independence: shuffled input produces identical allocations", () => {
    const drivers = [
      { recipientRef: "cc_a", driver: "3" },
      { recipientRef: "cc_b", driver: "5" },
      { recipientRef: "cc_c", driver: "7" },
    ];
    const forward = distributeLargestRemainder(1000n, drivers);
    const reversed = distributeLargestRemainder(1000n, [...drivers].reverse());
    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;
    const sort = (rows: typeof forward.value.rows) =>
      [...rows].sort((a, b) => a.recipientRef.localeCompare(b.recipientRef));
    expect(sort(forward.value.rows)).toEqual(sort(reversed.value.rows));
  });
  it("all-zero drivers refuse — an even split is a chosen method, never a fallback", () => {
    const outcome = distributeLargestRemainder(100n, [
      { recipientRef: "cc_a", driver: "0" },
      { recipientRef: "cc_b", driver: "0" },
    ]);
    expect(!outcome.ok && outcome.refusal.kind).toBe("NO_DRIVER_BASIS");
  });
});

describe("reciprocal allocation — exact solve, structural refusals", () => {
  it("solves the textbook two-service system exactly", () => {
    // S1 (primary 100) gives 20% to S2, 80% to P; S2 (primary 50) gives 10%
    // to S1, 90% to P. x1 = 100 + 0.1·x2 ; x2 = 50 + 0.2·x1.
    // x1 = 105/0.98 = 5250/49 ≈ 107.14; x2 = 50 + 21000/98 → check exact.
    const outcome = solveReciprocal([
      {
        centreRef: "s1",
        primaryMinor: 10000n,
        consumers: [
          { consumerRef: "s2", share: "0.2" },
          { consumerRef: "p", share: "0.8" },
        ],
      },
      {
        centreRef: "s2",
        primaryMinor: 5000n,
        consumers: [
          { consumerRef: "s1", share: "0.1" },
          { consumerRef: "p", share: "0.9" },
        ],
      },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const x1 = outcome.value.totals.get("s1")!;
    const x2 = outcome.value.totals.get("s2")!;
    // x1 = (100 + 0.1×(50 + 0.2 x1)) → x1 = 105/0.98 = 10500/98 = 5250/49 (in minor: ×100)
    expect(rToDecimalString(x1, 2)).toBe("10714.29");
    expect(rToDecimalString(x2, 2)).toBe("7142.86");
    // Everything lands on production: p receives x1×0.8 + x2×0.9 = total primaries.
    const p = outcome.value.toProduction.get("p")!;
    expect(rToDecimalString(p, 2)).toBe("15000.00");
  });
  it("a CLOSED system refuses naming every member — no epsilon leak, no damping", () => {
    const outcome = solveReciprocal([
      { centreRef: "s1", primaryMinor: 100n, consumers: [{ consumerRef: "s2", share: "1" }] },
      { centreRef: "s2", primaryMinor: 100n, consumers: [{ consumerRef: "s1", share: "1" }] },
    ]);
    expect(!outcome.ok && outcome.refusal.kind).toBe("RECIPROCAL_SYSTEM_CLOSED");
    expect(!outcome.ok && outcome.refusal.detail).toContain("s1");
    expect(!outcome.ok && outcome.refusal.detail).toContain("s2");
  });
  it("a self-share ≥ 1 refuses; a legal self-share renormalizes", () => {
    const invalid = solveReciprocal([
      { centreRef: "s1", primaryMinor: 100n, consumers: [{ consumerRef: "s1", share: "1" }] },
    ]);
    expect(!invalid.ok && invalid.refusal.kind).toBe("SELF_SERVICE_RATIO_INVALID");
    const legal = solveReciprocal([
      {
        centreRef: "s1",
        primaryMinor: 10000n,
        consumers: [
          { consumerRef: "s1", share: "0.2" },
          { consumerRef: "p", share: "0.8" },
        ],
      },
    ]);
    expect(legal.ok).toBe(true);
    if (!legal.ok) return;
    // Renormalized: everything reaches production.
    expect(rToDecimalString(legal.value.toProduction.get("p")!, 2)).toBe("10000.00");
  });
  it("a nearly-closed system trips the model-sanity guard — arithmetic right, model wrong", () => {
    const outcome = solveReciprocal(
      [
        {
          centreRef: "s1",
          primaryMinor: 10000n,
          consumers: [
            { consumerRef: "s2", share: "0.999" },
            { consumerRef: "p", share: "0.001" },
          ],
        },
        {
          centreRef: "s2",
          primaryMinor: 10000n,
          consumers: [
            { consumerRef: "s1", share: "0.999" },
            { consumerRef: "p", share: "0.001" },
          ],
        },
      ],
      100,
    );
    expect(!outcome.ok && outcome.refusal.kind).toBe("RECIPROCAL_SYSTEM_DEGENERATE");
  });
  it("step-down order is deterministic and recorded: descending service-to-service share, ref tie-break", () => {
    const order = stepDownOrderKey([
      { centreRef: "cc_b", serviceToServiceShare: "0.5" },
      { centreRef: "cc_a", serviceToServiceShare: "0.5" },
      { centreRef: "cc_c", serviceToServiceShare: "0.7" },
    ]);
    expect(order).toEqual(["cc_c", "cc_a", "cc_b"]);
  });
});

// ── Guards for all three Family 2 packages ──────────────────────────────────

import { readdirSync, readFileSync } from "node:fs";
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

describe("guards — allocationiq, profitabilityiq, projectfinanceiq", () => {
  const roots = ["allocationiq", "profitabilityiq", "projectfinanceiq"].map((p) =>
    join(process.cwd(), "packages", p, "src"),
  );
  const files = roots.flatMap((r) => sourceFiles(r)).map((path) => ({ path, text: readFileSync(path, "utf8") }));
  it("platform imports only; no clock; no floats; no iteration-to-tolerance", () => {
    for (const f of files) {
      expect(/(?:from|import)\s+"@proworks-hub\/(?!contracts|core-kit)[a-z-]+/.test(f.text), f.path).toBe(false);
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random|Math\.round|parseFloat|toFixed\(/.test(f.text), f.path).toBe(false);
      expect(/iterationCount|convergenceThreshold/.test(f.text), f.path).toBe(false);
    }
  });
});
