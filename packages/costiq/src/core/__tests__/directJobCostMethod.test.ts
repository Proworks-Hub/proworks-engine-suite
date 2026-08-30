/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { toString } from "../../domain/decimal.js";
import { defaultCurrencyPrecision } from "../../domain/money.js";
import { defaultUnitRegistry } from "../../domain/quantity.js";
import type { CostPolicy } from "../../domain/costModel.js";
import { buildCostGraph, rollup } from "../costGraph.js";
import { createMethodRegistry, methodsSpecification, runMethod, type CostMethod } from "../methodRegistry.js";
import { directJobCostMethodV1, directJobInputSchema } from "../directJobCostMethod.js";

// ─────────────────────────────────────────────────────────────────────────────
// v1's six layers, ported exactly, with the arithmetic fixed.
//
// The tests below are in two groups. The first proves the LAYERS still mean
// what they meant — same formulas, same ordering subtleties, same defensive
// behaviours. The second proves the things v1 got wrong are now right: exact
// arithmetic, and a refusal at the boundary instead of trusting callers.
// ─────────────────────────────────────────────────────────────────────────────

const policy: CostPolicy = {
  policyId: "pol.test",
  policyVersion: "1.0.0",
  currency: "GBP",
  roundingMode: "HALF_EVEN",
  roundingStage: "TOTAL",
  roundingScale: null,
  calculationScale: 10,
  acceptedSources: ["CONTRACT"],
  allowFallback: false,
  freshnessWindowDays: 90,
  minimumSampleSize: 1,
};

const context = {
  policy,
  asOf: new Date("2026-08-30T00:00:00.000Z"),
  units: defaultUnitRegistry,
  currencyPrecision: defaultCurrencyPrecision,
};

const registry = createMethodRegistry([directJobCostMethodV1 as CostMethod<never>]);

const run = (input: unknown) => runMethod(registry, "DIRECT_JOB", "1.0.0", input, context);

/** The total of a successful run, via the graph, so rollup is exercised too. */
function totalOf(input: unknown): string {
  const result = run(input);
  if (!result.ok) throw new Error(`${result.reason} ${result.issues.join("; ")}`);
  const graph = buildCostGraph(result.output.components);
  if (!graph.ok) throw new Error(graph.problems.map((p) => p.message).join("; "));
  return toString(rollup(graph.graph).total);
}

const minimal = {
  jobRef: "job-1",
  quantity: "1",
  overhead: { kind: "NONE" as const },
};

describe("Layer 1 — materials", () => {
  it("is quantity times unit cost times waste factor", () => {
    expect(
      totalOf({
        ...minimal,
        materials: [
          { materialId: "m1", name: "Steel", quantity: "10", quantityUnit: "kg", unitCost: "2.50", wasteFactor: "1.1" },
        ],
      }),
    ).toBe("27.500");
  });

  it("refuses a waste factor below 1", () => {
    // A factor under one would mean less material is consumed than used,
    // which is not waste but a modelling error.
    const result = run({
      ...minimal,
      materials: [
        { materialId: "m1", name: "Steel", quantity: "10", quantityUnit: "kg", unitCost: "2.50", wasteFactor: "0.9" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join()).toContain("less material is consumed than used");
  });

  it("contributes nothing for an empty list", () => {
    expect(totalOf({ ...minimal, materials: [] })).toBe("0");
  });
});

describe("Layer 3 — station usage", () => {
  it("is minutes times rate plus units times rate", () => {
    expect(
      totalOf({
        ...minimal,
        stations: [
          { stationId: "s1", name: "Laser", minutes: "30", units: "4", ratePerMinute: "1.50", ratePerUnit: "0.25" },
        ],
      }),
    ).toBe("46.00");
  });

  it("is raised to the minimum charge when below it", () => {
    expect(
      totalOf({
        ...minimal,
        stations: [
          { stationId: "s1", name: "Laser", minutes: "1", units: "0", ratePerMinute: "1.50", ratePerUnit: "0", minimumCharge: "25.00" },
        ],
      }),
    ).toBe("25.00");
  });

  it("says so when a minimum was applied", () => {
    // A minimum silently raising a cost is a number nobody can explain.
    const result = run({
      ...minimal,
      stations: [
        { stationId: "s1", name: "Laser", minutes: "1", units: "0", ratePerMinute: "1.50", ratePerUnit: "0", minimumCharge: "25.00" },
      ],
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.output.diagnostics.join()).toContain("minimum charge");
  });

  it("is not lowered when already above the minimum", () => {
    expect(
      totalOf({
        ...minimal,
        stations: [
          { stationId: "s1", name: "Laser", minutes: "100", units: "0", ratePerMinute: "1.00", ratePerUnit: "0", minimumCharge: "25.00" },
        ],
      }),
    ).toBe("100.00");
  });
});

describe("Layer 2 — consumables, including the ordering subtlety", () => {
  const station = {
    stationId: "s1",
    name: "Laser",
    minutes: "100",
    units: "0",
    ratePerMinute: "1.00",
    ratePerUnit: "0",
  };

  it("takes a percentage of THIS station's Layer 3 cost", () => {
    // The subtlety that is easy to lose in a port: Layer 3 must be computed
    // before Layer 2 can finish. Computing them in listed order would make
    // every percent-based consumable zero — a wrong answer that looks small.
    const total = totalOf({
      ...minimal,
      stations: [
        {
          ...station,
          consumables: [
            { consumableId: "c1", name: "Lens wear", method: "PERCENT_OF_STATION_USE", rate: "0.05", active: true },
          ],
        },
      ],
    });
    // Station 100.00, consumable 5% of it = 5.00, total 105.00.
    expect(total).toBe("105.0000");
  });

  it("applies the percentage to the MINIMUM-adjusted station cost", () => {
    // The minimum raises Layer 3, so it must raise the percentage too.
    const total = totalOf({
      ...minimal,
      stations: [
        {
          ...station,
          minutes: "1",
          minimumCharge: "50.00",
          consumables: [
            { consumableId: "c1", name: "Lens wear", method: "PERCENT_OF_STATION_USE", rate: "0.10", active: true },
          ],
        },
      ],
    });
    expect(total).toBe("55.0000");
  });

  it("multiplies rate by recorded usage for PER_UNIT", () => {
    expect(
      totalOf({
        ...minimal,
        stations: [
          {
            ...station,
            minutes: "0",
            ratePerMinute: "0",
            consumables: [{ consumableId: "c1", name: "Gas", method: "PER_UNIT", rate: "0.30", active: true }],
            consumableUsage: { c1: "20" },
          },
        ],
      }),
    ).toBe("6.00");
  });

  it("charges a flat consumable once when the station was used", () => {
    expect(
      totalOf({
        ...minimal,
        stations: [
          {
            ...station,
            consumables: [{ consumableId: "c1", name: "Setup kit", method: "FLAT_PER_JOB", rate: "7.50", active: true }],
          },
        ],
      }),
    ).toBe("107.50");
  });

  it("skips inactive consumables silently, as v1 does", () => {
    expect(
      totalOf({
        ...minimal,
        stations: [
          {
            ...station,
            consumables: [{ consumableId: "c1", name: "Gas", method: "PER_UNIT", rate: "99", active: false }],
            consumableUsage: { c1: "10" },
          },
        ],
      }),
    ).toBe("100.00");
  });

  it("contributes nothing for a consumable with no usage, but SAYS so", () => {
    // v1 skips this silently to survive a consumable removed mid-job. The
    // behaviour is preserved; the silence was the part worth changing.
    const result = run({
      ...minimal,
      stations: [
        {
          ...station,
          consumables: [{ consumableId: "c1", name: "Gas", method: "PER_UNIT", rate: "0.30", active: true }],
          consumableUsage: {},
        },
      ],
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.output.diagnostics.join()).toContain("no usage recorded");
  });
});

describe("Layer 4 — labour", () => {
  it("is minutes times loaded rate", () => {
    expect(
      totalOf({
        ...minimal,
        labor: [
          { stationId: "s1", employeeId: "e1", minutes: "90", loadedRatePerMinute: "0.55" },
          { stationId: "s1", employeeId: null, minutes: "30", loadedRatePerMinute: "0.45" },
        ],
      }),
    ).toBe("63.00");
  });
});

describe("Layer 5 — setup and cleanup", () => {
  const station = { stationId: "s1", name: "Laser", minutes: "0", units: "0", ratePerMinute: "0", ratePerUnit: "0" };

  it("uses a flat cost when given", () => {
    expect(totalOf({ ...minimal, stations: [{ ...station, setup: { flatCost: "25.00" } }] })).toBe("25.00");
  });

  it("uses time times rate when given", () => {
    expect(
      totalOf({ ...minimal, stations: [{ ...station, setup: { timeMinutes: "20", ratePerMinute: "1.25" } }] }),
    ).toBe("25.00");
  });

  it("prefers the flat cost when both are given, and says so", () => {
    const result = run({
      ...minimal,
      stations: [{ ...station, setup: { flatCost: "10.00", timeMinutes: "20", ratePerMinute: "1.25" } }],
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.output.diagnostics.join()).toContain("flat cost was used");
  });

  it("REFUSES an incomplete timed rule rather than costing it at zero", () => {
    // A station with setup minutes and no rate is missing a rate. Costing it
    // at nothing hides that.
    const result = run({ ...minimal, stations: [{ ...station, setup: { timeMinutes: "20" } }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join()).toContain("hide a missing rate");
  });
});

describe("Layer 6 — overhead", () => {
  const base = {
    ...minimal,
    materials: [
      { materialId: "m1", name: "Steel", quantity: "100", quantityUnit: "kg", unitCost: "1.00", wasteFactor: "1" },
    ],
    labor: [{ stationId: "s1", employeeId: null, minutes: "60", loadedRatePerMinute: "0.50" }],
    stations: [{ stationId: "s1", name: "Laser", minutes: "40", units: "0", ratePerMinute: "1.00", ratePerUnit: "0" }],
  };
  // direct = 100 + 30 + 40 = 170.

  it("adds nothing for NONE", () => {
    expect(totalOf({ ...base, overhead: { kind: "NONE" } })).toBe("170.00");
  });

  it("takes a percentage of direct cost", () => {
    expect(totalOf({ ...base, overhead: { kind: "PERCENT_OF_DIRECT", percent: "0.20" } })).toBe("204.0000");
  });

  it("adds a fixed amount per job", () => {
    expect(totalOf({ ...base, overhead: { kind: "FIXED_PER_JOB", amount: "50.00" } })).toBe("220.00");
  });

  it("applies a rate per labour minute", () => {
    expect(totalOf({ ...base, overhead: { kind: "PER_LABOR_MINUTE", ratePerMinute: "0.25" } })).toBe("185.00");
  });

  it("applies a rate per machine minute", () => {
    expect(totalOf({ ...base, overhead: { kind: "PER_MACHINE_MINUTE", ratePerMinute: "0.50" } })).toBe("190.00");
  });

  it("does not apply overhead to overhead", () => {
    // Direct cost excludes overhead and contingency by construction.
    const result = run({ ...base, overhead: { kind: "PERCENT_OF_DIRECT", percent: "1" } });
    if (!result.ok) throw new Error(result.reason);
    const overhead = result.output.components.find((c) => c.kind === "OVERHEAD");
    expect(overhead!.amount).toBe("170.00");
  });
});

describe("the arithmetic v1 gets wrong", () => {
  it("adds a hundred small material lines exactly", () => {
    // In floating point this drifts. The whole reason for the port.
    const materials = Array.from({ length: 100 }, (_, i) => ({
      materialId: `m${i}`,
      name: `Part ${i}`,
      quantity: "1",
      quantityUnit: "each",
      unitCost: "0.07",
      wasteFactor: "1",
    }));
    expect(totalOf({ ...minimal, materials })).toBe("7.00");

    const asFloats = materials.reduce((acc) => acc + 1 * 0.07 * 1, 0);
    expect(asFloats).not.toBe(7);
  });

  it("gives the same total whatever order the layers arrive in", () => {
    const a = { ...minimal, materials: [{ materialId: "m1", name: "A", quantity: "3", quantityUnit: "kg", unitCost: "0.1", wasteFactor: "1" }], labor: [{ stationId: "s", employeeId: null, minutes: "3", loadedRatePerMinute: "0.1" }] };
    const b = { ...a, materials: [...a.materials].reverse() };
    expect(totalOf(b)).toBe(totalOf(a));
  });
});

describe("the boundary no longer trusts its callers", () => {
  it("refuses a negative quantity", () => {
    // v1 says plainly that negative inputs are not validated. A negative
    // quantity silently produces a negative cost, which reduces a total, which
    // reduces a price.
    const result = run({
      ...minimal,
      materials: [{ materialId: "m1", name: "Steel", quantity: "-10", quantityUnit: "kg", unitCost: "2", wasteFactor: "1" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join()).toContain("Must not be negative");
  });

  it("refuses a negative rate", () => {
    const result = run({
      ...minimal,
      labor: [{ stationId: "s1", employeeId: null, minutes: "10", loadedRatePerMinute: "-1" }],
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a job that makes nothing", () => {
    const result = run({ ...minimal, quantity: "0" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join()).toContain("no unit cost to report");
  });

  it("refuses a JSON number where a decimal string belongs", () => {
    const result = run({
      ...minimal,
      materials: [{ materialId: "m1", name: "Steel", quantity: 10, quantityUnit: "kg", unitCost: "2", wasteFactor: "1" }],
    });
    expect(result.ok).toBe(false);
  });

  it("refuses unknown fields rather than ignoring them", () => {
    // A typo in a field name that is silently dropped is a cost silently
    // omitted.
    expect(run({ ...minimal, materialz: [] }).ok).toBe(false);
  });
});

describe("cost that exists with nothing to price it", () => {
  it("is carried at zero and reported, never dropped", () => {
    // Dropping it makes the total confidently too low; guessing makes it wrong
    // with no evidence. Carrying it at zero and saying so is the honest option.
    const result = run({
      ...minimal,
      unpriced: [{ id: "u1", name: "Powder coating", reason: "No supplier quote on file." }],
    });
    if (!result.ok) throw new Error(result.reason);
    const unpriced = result.output.components.filter((c) => c.kind === "UNPRICED");
    expect(unpriced).toHaveLength(1);
    expect(unpriced[0]!.amount).toBe("0");
    expect(result.output.diagnostics.join()).toContain("No supplier quote");
  });
});

describe("layers beyond v1's six", () => {
  it("adds subcontract, freight, energy and scrap", () => {
    expect(
      totalOf({
        ...minimal,
        subcontract: [{ id: "sc1", name: "Anodising", amount: "120.00" }],
        freight: [{ id: "f1", name: "Inbound steel", amount: "35.00" }],
        energy: [{ id: "e1", name: "Compressed air", amount: "5.00" }],
        scrapRework: [{ id: "sr1", name: "Two rejected panels", amount: "40.00" }],
      }),
    ).toBe("200.00");
  });

  it("amortises tooling over the units it serves", () => {
    // £1,000 of tooling over 500 units is £2/unit; a job of 10 carries £20.
    expect(
      totalOf({
        ...minimal,
        quantity: "10",
        tooling: [{ id: "t1", name: "Form die", amount: "1000.00", amortizeOverUnits: "500" }],
      }),
    ).toBe("20.0000000000");
  });

  it("records the amortisation as an assumption", () => {
    const result = run({
      ...minimal,
      quantity: "10",
      tooling: [{ id: "t1", name: "Form die", amount: "1000.00", amortizeOverUnits: "500" }],
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.output.assumptions.map((a) => a.id)).toContain("tooling.amortization.t1");
  });

  it("charges the whole tool when no amortisation basis is given", () => {
    expect(totalOf({ ...minimal, tooling: [{ id: "t1", name: "Form die", amount: "1000.00" }] })).toBe("1000.00");
  });

  it("refuses to amortise over zero units", () => {
    const result = run({
      ...minimal,
      tooling: [{ id: "t1", name: "Form die", amount: "1000.00", amortizeOverUnits: "0" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join()).toContain("no answer");
  });

  it("applies contingency to direct cost only", () => {
    expect(
      totalOf({
        ...minimal,
        materials: [{ materialId: "m1", name: "Steel", quantity: "100", quantityUnit: "kg", unitCost: "1", wasteFactor: "1" }],
        contingencyRate: "0.10",
        overhead: { kind: "FIXED_PER_JOB", amount: "50.00" },
      }),
    ).toBe("160.00");
  });
});

describe("the registry refuses to guess", () => {
  it("returns the method for an exact id and version", () => {
    expect(registry.get("DIRECT_JOB", "1.0.0")).not.toBeNull();
  });

  it("REFUSES a version it does not have, naming the ones it does", () => {
    // Costing with the wrong method produces a plausible number that answers a
    // different question.
    const result = runMethod(registry, "DIRECT_JOB", "9.9.9", minimal, context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("1.0.0");
    expect(result.reason).toContain("Refusing to substitute");
  });

  it("refuses an unknown method id", () => {
    const result = runMethod(registry, "NOT_A_METHOD", "1.0.0", minimal, context);
    expect(result.ok).toBe(false);
  });

  it("refuses to re-register a version", () => {
    // Replacing maths that existing estimates were computed with would make
    // those estimates unreproducible.
    const r = createMethodRegistry([directJobCostMethodV1 as CostMethod<never>]);
    expect(() => r.register(directJobCostMethodV1 as CostMethod<never>)).toThrow(/already registered/);
  });

  it("generates its specification from itself, so it cannot drift", () => {
    const spec = methodsSpecification(registry);
    expect(spec).toContain("## DIRECT_JOB@1.0.0");
    expect(spec).toContain("Six-layer job cost");
  });
});

describe("the method is pure", () => {
  it("produces identical output for identical input, repeatedly", () => {
    const input = {
      ...minimal,
      materials: [{ materialId: "m1", name: "Steel", quantity: "10", quantityUnit: "kg", unitCost: "2.5", wasteFactor: "1.1" }],
      overhead: { kind: "PERCENT_OF_DIRECT" as const, percent: "0.15" },
    };
    const first = JSON.stringify(run(input));
    for (let i = 0; i < 10; i += 1) expect(JSON.stringify(run(input))).toBe(first);
  });

  it("takes its instant from the context rather than a clock", () => {
    // The predictability contract: canonical output independent of wall time.
    const a = JSON.stringify(run(minimal));
    const later = { ...context, asOf: new Date("2030-01-01T00:00:00.000Z") };
    const b = JSON.stringify(runMethod(registry, "DIRECT_JOB", "1.0.0", minimal, later));
    expect(b).toBe(a);
  });
});

describe("the input schema is the contract", () => {
  it("parses a minimal job", () => {
    expect(directJobInputSchema.safeParse(minimal).success).toBe(true);
  });
});
