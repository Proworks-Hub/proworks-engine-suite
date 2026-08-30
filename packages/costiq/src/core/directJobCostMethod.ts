/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/directJobCostMethod.ts
 * Module:   cost-iq-engine / core
 * Purpose:  DIRECT_JOB — what one job costs, layer by layer, exactly.
 */

import { z } from "zod";

import {
  type Decimal,
  ONE,
  ZERO,
  add,
  compare,
  divide,
  fromString,
  multiply,
  toString as decToString,
} from "../domain/decimal.js";
import { decimalStringSchema } from "../domain/costModel.js";
import type { CostComponent } from "../domain/costModel.js";
import type { CostAssumption } from "../domain/provenance.js";
import type { CostMethod, CostMethodContext, CostMethodResult } from "./methodRegistry.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE SAME SIX LAYERS v1 HAS, WITH THE ARITHMETIC FIXED
//
// v1's calculator is correct in its structure and wrong in its numbers: it
// computes materials, consumables, station usage, labour, setup and overhead
// in the right order and with the right formulas, using JavaScript `Number`
// throughout. This is a faithful port — every layer means what it meant — onto
// exact decimal arithmetic, plus the layers the directive adds.
//
// WHAT IS PRESERVED EXACTLY
//
//   L1 Materials   Σ quantity × unitCost × wasteFactor
//   L2 Consumables per station, per usage entry, including the
//                  percent-of-station-use method that takes a cut of L3
//   L3 Station     minutes × ratePerMinute + units × ratePerUnit,
//                  raised to minimumCharge if one is set
//   L4 Labour      Σ minutes × loadedRatePerMinute
//   L5 Setup       flat, or time × rate, per station that has a rule
//   L6 Overhead    from the overhead model against direct cost, labour
//                  minutes or machine minutes
//
// WHAT CHANGES, AND WHY
//
// v1 says plainly: "Negative inputs are NOT validated — the calculator trusts
// callers." That was a reasonable division of responsibility when the only
// caller was one internal service. It is not reasonable at a public boundary,
// where a negative quantity silently produces a negative cost, which flows
// into a total, which reduces a price. The directive requires it removed, and
// this refuses at intake with the offending field named.
//
// L2's ORDERING SUBTLETY
//
// `percent_of_station_use` consumables are a percentage of Layer 3's cost for
// that station — so Layer 3 must be computed per station BEFORE Layer 2 can
// finish. v1 does this correctly and it is easy to get wrong when porting;
// computing L2 first would silently make every percent-based consumable zero.
// ─────────────────────────────────────────────────────────────────────────────

const nonNegative = decimalStringSchema.refine((v) => !v.startsWith("-"), {
  message:
    "Must not be negative. A negative quantity or rate produces a negative cost that reduces a total and a price, and v1's practice of trusting callers is not safe at a public boundary.",
});

const consumableMethodSchema = z.enum([
  /** cost = rate × basisUnits. */
  "PER_UNIT",
  /** cost = rate, once, if the station was used at all. */
  "FLAT_PER_JOB",
  /** cost = rate × station minutes. */
  "PER_MINUTE",
  /** cost = percent × this station's Layer 3 cost. */
  "PERCENT_OF_STATION_USE",
]);

const consumableSchema = z
  .object({
    consumableId: z.string().min(1),
    name: z.string().min(1),
    method: consumableMethodSchema,
    /** Rate, or percent expressed as a fraction for PERCENT_OF_STATION_USE. */
    rate: nonNegative,
    active: z.boolean().default(true),
    basisId: z.string().min(1).optional(),
  })
  .strict();

const stationSchema = z
  .object({
    stationId: z.string().min(1),
    name: z.string().min(1),
    minutes: nonNegative,
    units: nonNegative,
    ratePerMinute: nonNegative,
    ratePerUnit: nonNegative,
    /** Floor for this station's Layer 3 cost, if the shop charges one. */
    minimumCharge: nonNegative.optional(),
    /** Layer 5. Flat cost, or time × rate. Not both. */
    setup: z
      .object({
        flatCost: nonNegative.optional(),
        timeMinutes: nonNegative.optional(),
        ratePerMinute: nonNegative.optional(),
      })
      .strict()
      .optional(),
    consumables: z.array(consumableSchema).default([]),
    /** Usage per consumable, by id. Entries with no matching consumable are ignored. */
    consumableUsage: z.record(z.string(), nonNegative).default({}),
    basisId: z.string().min(1).optional(),
  })
  .strict();

const materialSchema = z
  .object({
    materialId: z.string().min(1),
    name: z.string().min(1),
    quantity: nonNegative,
    quantityUnit: z.string().min(1),
    unitCost: nonNegative,
    /**
     * Multiplier for waste. 1 means none, 1.1 means ten percent extra.
     *
     * Refused below 1: a waste factor under one would mean less material is
     * consumed than used, which is not waste but a modelling error.
     */
    wasteFactor: decimalStringSchema,
    basisId: z.string().min(1).optional(),
  })
  .strict()
  .refine((m) => compare(fromString(m.wasteFactor), ONE) >= 0, {
    message: "wasteFactor must be at least 1. A factor below 1 would mean less material is consumed than used.",
    path: ["wasteFactor"],
  });

const laborSchema = z
  .object({
    stationId: z.string().min(1),
    employeeId: z.string().min(1).nullable(),
    minutes: nonNegative,
    loadedRatePerMinute: nonNegative,
    basisId: z.string().min(1).optional(),
  })
  .strict();

/** A flat line for the layers the directive adds beyond v1's six. */
const additionalSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    amount: nonNegative,
    basisId: z.string().min(1).optional(),
  })
  .strict();

const overheadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("NONE") }).strict(),
  z.object({ kind: z.literal("PERCENT_OF_DIRECT"), percent: nonNegative }).strict(),
  z.object({ kind: z.literal("FIXED_PER_JOB"), amount: nonNegative }).strict(),
  z.object({ kind: z.literal("PER_LABOR_MINUTE"), ratePerMinute: nonNegative }).strict(),
  z.object({ kind: z.literal("PER_MACHINE_MINUTE"), ratePerMinute: nonNegative }).strict(),
]);

export const directJobInputSchema = z
  .object({
    jobRef: z.string().min(1),
    quantity: nonNegative,
    quantityUnit: z.string().min(1).default("each"),
    materials: z.array(materialSchema).default([]),
    stations: z.array(stationSchema).default([]),
    labor: z.array(laborSchema).default([]),

    // ── Layers beyond v1's six ────────────────────────────────────────────
    subcontract: z.array(additionalSchema).default([]),
    freight: z.array(additionalSchema).default([]),
    energy: z.array(additionalSchema).default([]),
    /** Tooling and NRE. Amortised across `amortizeOverUnits` when given. */
    tooling: z
      .array(additionalSchema.extend({ amortizeOverUnits: nonNegative.optional() }).strict())
      .default([]),
    scrapRework: z.array(additionalSchema).default([]),
    /** A deliberate allowance, as a fraction of direct cost. */
    contingencyRate: nonNegative.optional(),

    /** Cost known to exist with nothing to price it. Reported, never zeroed. */
    unpriced: z
      .array(z.object({ id: z.string().min(1), name: z.string().min(1), reason: z.string().min(1) }).strict())
      .default([]),

    overhead: overheadSchema,
  })
  .strict()
  .refine((i) => compare(fromString(i.quantity), ZERO) > 0, {
    message: "Quantity must be greater than zero. A job that makes nothing has no unit cost to report.",
    path: ["quantity"],
  });

export type DirectJobInput = z.infer<typeof directJobInputSchema>;

/** `PERCENT_OF_STATION_USE` rates are fractions: 0.05 is five percent. */
const asFraction = (rate: string): Decimal => fromString(rate);

function component(
  id: string,
  kind: CostComponent["kind"],
  label: string,
  amount: Decimal,
  currency: string,
  extra: Partial<CostComponent> = {},
): CostComponent {
  return {
    componentId: id,
    kind,
    label,
    amount: decToString(amount),
    currency,
    included: true,
    notes: [],
    ...extra,
  } as CostComponent;
}

export const directJobCostMethodV1: CostMethod<DirectJobInput> = {
  id: "DIRECT_JOB",
  version: "1.0.0",
  summary:
    "Six-layer job cost — materials, consumables, station usage, labour, setup and overhead — extended with subcontract, freight, energy, tooling amortisation, scrap and contingency. Ported from CostIQ v1 with identical layer semantics and exact decimal arithmetic.",
  inputSchema: directJobInputSchema,

  compute(input: DirectJobInput, context: CostMethodContext): CostMethodResult {
    const currency = context.policy.currency;
    const scale = context.policy.calculationScale;
    const mode = context.policy.roundingMode;
    const components: CostComponent[] = [];
    const assumptions: CostAssumption[] = [];
    const diagnostics: string[] = [];

    // ── Layer 1: materials ────────────────────────────────────────────────
    for (const m of input.materials) {
      const amount = multiply(
        multiply(fromString(m.quantity), fromString(m.unitCost)),
        fromString(m.wasteFactor),
      );
      components.push(
        component(`material:${m.materialId}`, "MATERIAL", m.name, amount, currency, {
          quantity: m.quantity,
          quantityUnit: m.quantityUnit,
          basisId: m.basisId ?? "unspecified",
        }),
      );
      if (compare(fromString(m.wasteFactor), ONE) > 0) {
        diagnostics.push(`Material ${m.name} carries a waste factor of ${m.wasteFactor}.`);
      }
    }

    // ── Layer 3 FIRST, per station ────────────────────────────────────────
    //
    // Layer 2's percent-of-station-use consumables are a fraction of THIS
    // station's Layer 3 cost, so Layer 3 has to exist before Layer 2 can
    // finish. Computing them in listed order would silently make every
    // percent-based consumable zero — a wrong answer that looks like a small
    // one.
    const stationUsageCost = new Map<string, Decimal>();
    for (const s of input.stations) {
      const byTime = multiply(fromString(s.minutes), fromString(s.ratePerMinute));
      const byUnit = multiply(fromString(s.units), fromString(s.ratePerUnit));
      let usage = add(byTime, byUnit);

      if (s.minimumCharge !== undefined) {
        const minimum = fromString(s.minimumCharge);
        if (compare(usage, minimum) < 0) {
          diagnostics.push(
            `Station ${s.name} was raised to its minimum charge of ${s.minimumCharge} (computed usage was ${decToString(usage)}).`,
          );
          usage = minimum;
        }
      }

      stationUsageCost.set(s.stationId, usage);
      components.push(
        component(`station:${s.stationId}`, "MACHINE", s.name, usage, currency, {
          quantity: s.minutes,
          quantityUnit: "min",
          basisId: s.basisId ?? "unspecified",
        }),
      );
    }

    // ── Layer 2: consumables ──────────────────────────────────────────────
    for (const s of input.stations) {
      const stationCost = stationUsageCost.get(s.stationId) ?? ZERO;
      for (const c of s.consumables) {
        if (!c.active) continue;

        // v1 skips a usage entry with no matching consumable silently, to
        // survive a consumable being removed mid-job. Preserved, but recorded
        // — silence was the part worth changing, not the behaviour.
        const usedRaw = s.consumableUsage[c.consumableId];
        const used = usedRaw === undefined ? ZERO : fromString(usedRaw);

        let amount: Decimal;
        switch (c.method) {
          case "PER_UNIT":
            amount = multiply(fromString(c.rate), used);
            break;
          case "FLAT_PER_JOB":
            amount = compare(stationCost, ZERO) > 0 || compare(used, ZERO) > 0 ? fromString(c.rate) : ZERO;
            break;
          case "PER_MINUTE":
            amount = multiply(fromString(c.rate), fromString(s.minutes));
            break;
          case "PERCENT_OF_STATION_USE":
            amount = multiply(asFraction(c.rate), stationCost);
            break;
          default: {
            const unreachable: never = c.method;
            return {
              ok: false,
              reason: `Unknown consumable method ${String(unreachable)} on ${c.consumableId}.`,
              issues: [],
            };
          }
        }

        if (usedRaw === undefined && c.method === "PER_UNIT") {
          diagnostics.push(
            `Consumable ${c.name} at station ${s.name} has no usage recorded and contributed nothing.`,
          );
        }

        components.push(
          component(`consumable:${s.stationId}:${c.consumableId}`, "CONSUMABLE", c.name, amount, currency, {
            parentId: `station:${s.stationId}`,
            basisId: c.basisId ?? "unspecified",
          }),
        );
      }
    }

    // ── Layer 4: labour ───────────────────────────────────────────────────
    input.labor.forEach((l, index) => {
      const amount = multiply(fromString(l.minutes), fromString(l.loadedRatePerMinute));
      components.push(
        component(`labor:${l.stationId}:${index}`, "LABOR", `Labour at ${l.stationId}`, amount, currency, {
          quantity: l.minutes,
          quantityUnit: "min",
          basisId: l.basisId ?? "unspecified",
        }),
      );
    });

    // ── Layer 5: setup and cleanup ────────────────────────────────────────
    for (const s of input.stations) {
      if (!s.setup) continue;
      const { flatCost, timeMinutes, ratePerMinute } = s.setup;

      let amount: Decimal;
      if (flatCost !== undefined) {
        amount = fromString(flatCost);
        if (timeMinutes !== undefined || ratePerMinute !== undefined) {
          // Both forms present. v1 prefers the flat cost; recorded rather than
          // resolved silently, because a station configured both ways is a
          // configuration somebody should look at.
          diagnostics.push(
            `Station ${s.name} has both a flat setup cost and a timed one; the flat cost was used, matching v1.`,
          );
        }
      } else if (timeMinutes !== undefined && ratePerMinute !== undefined) {
        amount = multiply(fromString(timeMinutes), fromString(ratePerMinute));
      } else {
        // Half a timed rule. Refused rather than treated as zero: a station
        // with setup minutes and no rate is missing a rate, and costing it at
        // nothing hides that.
        return {
          ok: false,
          reason: `Station ${s.name} has an incomplete setup rule.`,
          issues: [
            `setup needs either flatCost, or both timeMinutes and ratePerMinute. Costing an incomplete rule at zero would hide a missing rate.`,
          ],
        };
      }

      components.push(
        component(`setup:${s.stationId}`, "SETUP", `Setup — ${s.name}`, amount, currency, {
          basisId: s.basisId ?? "unspecified",
        }),
      );
    }

    // ── Additional layers ─────────────────────────────────────────────────
    const flatLayers: ReadonlyArray<[readonly { id: string; name: string; amount: string; basisId?: string }[], CostComponent["kind"], string]> = [
      [input.subcontract, "SUBCONTRACT", "subcontract"],
      [input.freight, "FREIGHT", "freight"],
      [input.energy, "ENERGY", "energy"],
      [input.scrapRework, "SCRAP", "scrap"],
    ];
    for (const [items, kind, prefix] of flatLayers) {
      for (const item of items) {
        components.push(
          component(`${prefix}:${item.id}`, kind, item.name, fromString(item.amount), currency, {
            basisId: item.basisId ?? "unspecified",
          }),
        );
      }
    }

    // Tooling, amortised where the caller says over how many units.
    for (const t of input.tooling) {
      const total = fromString(t.amount);
      let amount = total;
      if (t.amortizeOverUnits !== undefined) {
        const over = fromString(t.amortizeOverUnits);
        if (compare(over, ZERO) <= 0) {
          return {
            ok: false,
            reason: `Tooling ${t.name} amortises over ${t.amortizeOverUnits} units.`,
            issues: ["amortizeOverUnits must be greater than zero; dividing by it otherwise has no answer."],
          };
        }
        // Per-unit share times this job's quantity: the part of the tool this
        // job is responsible for, not the whole tool.
        const perUnit = divide(total, over, scale, mode);
        amount = multiply(perUnit, fromString(input.quantity));
        assumptions.push({
          id: `tooling.amortization.${t.id}`,
          statement: `Tooling "${t.name}" is amortised over ${t.amortizeOverUnits} units.`,
          because: "The caller supplied an amortisation basis; without one the whole tool would land on this job.",
          affectsComponentIds: [`tooling:${t.id}`],
        });
      }
      components.push(
        component(`tooling:${t.id}`, "TOOLING", t.name, amount, currency, {
          basisId: t.basisId ?? "unspecified",
        }),
      );
    }

    // ── Unpriced ──────────────────────────────────────────────────────────
    //
    // Zero amount, but PRESENT. An estimate that dropped these would be
    // confidently too low; one that guessed at them would be wrong with no
    // evidence. Carrying them at zero and reporting them separately is the
    // only honest option.
    for (const u of input.unpriced) {
      components.push(
        component(`unpriced:${u.id}`, "UNPRICED", u.name, ZERO, currency, { notes: [u.reason] }),
      );
      diagnostics.push(`${u.name} has no basis and is not priced: ${u.reason}`);
    }

    // ── Direct cost ───────────────────────────────────────────────────────
    // Direct cost is everything computed SO FAR — overhead and contingency are
    // pushed after this line, so at this point the list cannot contain them.
    //
    // The kind filter is therefore DEFENCE IN DEPTH and currently unreachable:
    // a mutation removing it survives the suite, which is recorded here rather
    // than papered over with a test that exists only to kill it.
    //
    // It stays because it makes the rule local. Without it, "overhead is not
    // applied to overhead" would be a property of statement ORDER in this
    // function, and a later reordering would compound overhead silently.
    const directCost = components
      .filter((c) => c.included && c.kind !== "OVERHEAD" && c.kind !== "CONTINGENCY")
      .reduce<Decimal>((acc, c) => add(acc, fromString(c.amount)), ZERO);

    // ── Layer 6: overhead ─────────────────────────────────────────────────
    const laborMinutes = input.labor.reduce<Decimal>((acc, l) => add(acc, fromString(l.minutes)), ZERO);
    const machineMinutes = input.stations.reduce<Decimal>((acc, s) => add(acc, fromString(s.minutes)), ZERO);

    let overheadAmount = ZERO;
    let overheadLabel = "";
    switch (input.overhead.kind) {
      case "NONE":
        overheadLabel = "";
        break;
      case "PERCENT_OF_DIRECT":
        overheadAmount = multiply(directCost, fromString(input.overhead.percent));
        overheadLabel = `Overhead (${input.overhead.percent} of direct)`;
        break;
      case "FIXED_PER_JOB":
        overheadAmount = fromString(input.overhead.amount);
        overheadLabel = "Overhead (fixed per job)";
        break;
      case "PER_LABOR_MINUTE":
        overheadAmount = multiply(laborMinutes, fromString(input.overhead.ratePerMinute));
        overheadLabel = "Overhead (per labour minute)";
        break;
      case "PER_MACHINE_MINUTE":
        overheadAmount = multiply(machineMinutes, fromString(input.overhead.ratePerMinute));
        overheadLabel = "Overhead (per machine minute)";
        break;
      default: {
        const unreachable: never = input.overhead;
        return { ok: false, reason: `Unknown overhead model ${JSON.stringify(unreachable)}.`, issues: [] };
      }
    }

    if (input.overhead.kind !== "NONE") {
      components.push(
        component("overhead", "OVERHEAD", overheadLabel, overheadAmount, currency, {
          basisId: "overhead-model",
        }),
      );
    }

    // ── Contingency ───────────────────────────────────────────────────────
    if (input.contingencyRate !== undefined) {
      const amount = multiply(directCost, fromString(input.contingencyRate));
      components.push(component("contingency", "CONTINGENCY", "Contingency", amount, currency));
      assumptions.push({
        id: "contingency",
        statement: `A contingency of ${input.contingencyRate} of direct cost was added.`,
        because: "The caller's policy allows for what is not yet known.",
        affectsComponentIds: ["contingency"],
      });
    }

    return { ok: true, output: { components, assumptions, diagnostics } };
  },
};
