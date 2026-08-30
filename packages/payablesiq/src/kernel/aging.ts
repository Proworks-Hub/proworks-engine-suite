// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  exactMinorUnits,
  exactMoneyFromMinorUnits,
  type ExactMoney,
} from "@proworks-hub/contracts";

import type { AgingScheme, AgingSnapshot, PayableObligation } from "../model.js";
import { ok, refuse, type Result } from "../refusals.js";
import { daysBetween, type ISODate } from "./dates.js";
import { PAYABLES_METHODS } from "./methods.js";

// ─────────────────────────────────────────────────────────────────────────────
// aging.* — §16.5. Buckets hold the OPEN amount, never the original.
// An obligation with no derivable basis date lands in `terms-unknown` —
// NEVER in "current", because "current" is a claim and unknown is not.
// Partially settled items age from their ORIGINAL basis date
// (open-amount-original-basis, the ERP convention); residual-rebase exists
// as a distinct versioned method, never as the default.
// ─────────────────────────────────────────────────────────────────────────────

export type AgingMethod = "open-amount-original-basis" | "residual-rebase";

export interface AgingInputs {
  readonly obligations: readonly PayableObligation[];
  readonly scheme: AgingScheme;
  readonly asOf: ISODate;
  readonly method: AgingMethod;
  /** Required by residual-rebase: last application date per obligation. */
  readonly lastApplicationDates?: Readonly<Record<string, ISODate>>;
  readonly agingRunId: string;
}

export function agePayables(inputs: AgingInputs): Result<AgingSnapshot> {
  const methodRef =
    inputs.method === "open-amount-original-basis"
      ? PAYABLES_METHODS.agingOpenAmountOriginalBasis
      : PAYABLES_METHODS.agingResidualRebase;

  // bucketName -> currency -> { units, ids }
  const totals = new Map<string, Map<string, { units: bigint; ids: string[] }>>();
  const add = (bucket: string, currency: string, scale: number, units: bigint, id: string) => {
    const perCurrency = totals.get(bucket) ?? new Map();
    const cell = perCurrency.get(currency) ?? { units: 0n, ids: [], scale };
    cell.units += units;
    cell.ids.push(id);
    perCurrency.set(currency, cell);
    totals.set(bucket, perCurrency);
  };

  const scales = new Map<string, number>();
  for (const o of inputs.obligations) {
    if (o.status === "settled" || o.status === "reversed" || o.status === "written-off") continue;
    const open = exactMinorUnits(o.openAmount);
    if (open === 0n) continue;
    scales.set(o.currency, o.openAmount.scale);

    let basisDate: ISODate | undefined;
    switch (inputs.scheme.basis) {
      case "due-date":
        basisDate = o.dueDate;
        break;
      case "terms-date":
        basisDate = o.termsDate;
        break;
      case "document-date":
        // The document date is not stored on the obligation (the document is
        // InvoiceIQ's); the terms date is the recorded basis fact.
        basisDate = o.termsDate;
        break;
    }
    if (
      basisDate === undefined ||
      o.termsResolution === "unresolved" ||
      o.termsResolution === "candidate-pending"
    ) {
      add(inputs.scheme.termsUnknownBucket, o.currency, o.openAmount.scale, open, o.obligationId);
      continue;
    }
    if (inputs.method === "residual-rebase" && o.status === "partially-settled") {
      const rebase = inputs.lastApplicationDates?.[o.obligationId];
      if (rebase === undefined) {
        return refuse(
          "missing-evidence",
          methodRef,
          `residual-rebase needs the last application date for ${o.obligationId}; none was supplied.`,
        );
      }
      basisDate = rebase;
    }
    const daysPastDue = daysBetween(basisDate, inputs.asOf);
    if (daysPastDue < 0) {
      add(inputs.scheme.futureBucket, o.currency, o.openAmount.scale, open, o.obligationId);
      continue;
    }
    const bucket = inputs.scheme.buckets.find(
      (b) => b.lowerDays <= daysPastDue && daysPastDue < b.upperDays,
    );
    if (!bucket) {
      // Structurally unreachable when the scheme passed registration
      // validation; surfaced rather than swallowed if a raw scheme leaks in.
      return refuse(
        "invariant-violated",
        methodRef,
        `No bucket covers ${daysPastDue} days — the scheme was never registration-validated.`,
      );
    }
    add(bucket.name, o.currency, o.openAmount.scale, open, o.obligationId);
  }

  const buckets: AgingSnapshot["buckets"][number][] = [];
  for (const [name, perCurrency] of [...totals.entries()].sort()) {
    for (const [currency, cell] of [...perCurrency.entries()].sort()) {
      buckets.push({
        name,
        currency,
        total: exactMoneyFromMinorUnits(cell.units, currency, scales.get(currency) ?? 2),
        obligationIds: cell.ids.sort(),
      });
    }
  }

  const resultFingerprint = [
    inputs.agingRunId,
    inputs.asOf,
    inputs.scheme.methodRef.methodId,
    inputs.scheme.methodRef.semanticVersion,
    methodRef.methodId,
    ...buckets.map((b) => `${b.name}:${b.currency}:${b.total.amount}`),
  ].join("|");

  return ok({
    agingRunId: inputs.agingRunId,
    asOf: inputs.asOf,
    schemeRef: inputs.scheme.methodRef,
    methodRef,
    buckets,
    resultFingerprint,
    generatedFrom: inputs.obligations.map((o) => `${o.obligationId}@v${o.version}`).sort(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// balance.vendor-balance.v1 — §16.6. A per-currency PARTITION, never a sum:
// cross-currency totalling requires an explicit ExchangeRateRef and until one
// is supplied it refuses. Credits and debits are reported separately, never
// netted into a single figure that hides a debit balance.
// ─────────────────────────────────────────────────────────────────────────────

export interface VendorBalanceResult {
  readonly vendorRef: string;
  readonly asOf: ISODate;
  readonly vendorIdentityResolution: "resolved" | "unresolved";
  readonly perCurrency: readonly {
    readonly currency: string;
    readonly credit: ExactMoney;
    readonly debit: ExactMoney;
  }[];
}

export function computeVendorBalance(
  obligations: readonly PayableObligation[],
  vendorRef: string,
  asOf: ISODate,
  resolverBound: boolean,
): Result<VendorBalanceResult> {
  const M = PAYABLES_METHODS.vendorBalance;
  const mine = obligations.filter((o) => o.vendorRef === vendorRef);
  const perCurrency = new Map<string, { credit: bigint; debit: bigint; scale: number }>();
  for (const o of mine) {
    if (o.status === "settled" || o.status === "reversed" || o.status === "written-off") continue;
    const units = exactMinorUnits(o.openAmount);
    if (units === 0n) continue;
    const cell = perCurrency.get(o.currency) ?? { credit: 0n, debit: 0n, scale: o.openAmount.scale };
    if (units > 0n) cell.credit += units;
    else cell.debit += -units;
    perCurrency.set(o.currency, cell);
  }
  return ok({
    vendorRef,
    asOf,
    vendorIdentityResolution: resolverBound ? "resolved" : "unresolved",
    perCurrency: [...perCurrency.entries()].sort().map(([currency, cell]) => ({
      currency,
      credit: exactMoneyFromMinorUnits(cell.credit, currency, cell.scale),
      debit: exactMoneyFromMinorUnits(cell.debit, currency, cell.scale),
    })),
  });
}

/** Merging two vendorRefs is a REFUSAL unless a bound resolver asserts they are one vendor. */
export function mergeVendorBalances(
  resolverAssertsSame: boolean | undefined,
): Result<"merge-permitted"> {
  if (resolverAssertsSame !== true) {
    return refuse(
      "missing-port",
      PAYABLES_METHODS.vendorBalance,
      resolverAssertsSame === undefined
        ? "VendorReferenceResolver is unbound; two vendorRefs cannot be merged on similarity."
        : "The resolver did not assert the two references are one vendor.",
    );
  }
  return ok("merge-permitted");
}
