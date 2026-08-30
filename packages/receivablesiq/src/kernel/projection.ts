// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  exactMinorUnits,
  exactMoneyFromMinorUnits,
  exactMoneySchema,
  type ExactMoney,
} from "@proworks-hub/contracts";

import type {
  Application,
  CashReceipt,
  ItemComponent,
  OpenItem,
  ReceivableJournalEntry,
} from "../model.js";

// ─────────────────────────────────────────────────────────────────────────────
// The projection reducer — §14. The journal is the truth; this fold is how
// open items, receipts and applications come to exist. `replayTo(asOf)` cuts
// by effectiveAt, which is what makes "the balance was X on that date" a
// DERIVABLE statement rather than a remembered one.
//
// Invariant I-1: openAmount = originalAmount − Σ applications − Σ adjustments
// − Σ writeOffs, exact decimal, transaction currency, NO rounding.
// Invariant I-2: state is a pure function of the entries. A stored projection
// that disagrees with a replay loses.
// ─────────────────────────────────────────────────────────────────────────────

interface MutableItem {
  item: Omit<OpenItem, "openAmount" | "state" | "freshness">;
  originalUnits: bigint;
  consumedUnits: bigint;
  writtenOff: boolean;
  assigned: boolean;
  superseded: boolean;
}

interface MutableReceipt {
  receipt: Omit<CashReceipt, "state" | "unappliedAmount">;
  amountUnits: bigint;
  appliedUnits: bigint;
  identified: boolean;
  onAccount: boolean;
  returned: boolean;
}

export interface ProjectionState {
  readonly openItems: ReadonlyMap<string, OpenItem>;
  readonly receipts: ReadonlyMap<string, CashReceipt>;
  readonly applications: ReadonlyMap<string, Application>;
}

const money = (value: unknown): ExactMoney => exactMoneySchema.parse(value);

export function replayTo(
  entries: readonly ReceivableJournalEntry[],
  asOf: string,
): ProjectionState {
  const items = new Map<string, MutableItem>();
  const receipts = new Map<string, MutableReceipt>();
  const applications = new Map<string, Application>();

  const ordered = [...entries].sort((a, b) => a.sequence - b.sequence);
  for (const entry of ordered) {
    if (entry.effectiveAt > asOf) continue;
    const p = entry.payload as Record<string, unknown>;
    switch (entry.kind) {
      case "receivable.recorded": {
        const original = money(p.originalAmount);
        items.set(String(p.openItemId), {
          item: {
            openItemId: String(p.openItemId),
            customerRef: String(p.customerRef),
            documentRef: String(p.documentRef),
            itemKind: p.itemKind as OpenItem["itemKind"],
            sign: p.sign as OpenItem["sign"],
            originalAmount: original,
            documentDate: String(p.documentDate),
            ...(p.dueDate !== undefined ? { dueDate: String(p.dueDate) } : {}),
            discountTerms: (p.discountTerms as OpenItem["discountTerms"]) ?? [],
            disputePresence: false,
            components: (p.components as ItemComponent[]) ?? [],
            sourceEntryIds: [entry.entryId],
          },
          originalUnits: exactMinorUnits(original),
          consumedUnits: 0n,
          writtenOff: false,
          assigned: false,
          superseded: false,
        });
        break;
      }
      case "cash.received": {
        const amount = money(p.amount);
        receipts.set(String(p.cashReceiptId), {
          receipt: {
            cashReceiptId: String(p.cashReceiptId),
            ...(p.customerRef !== undefined ? { customerRef: String(p.customerRef) } : {}),
            amount,
            valueDate: String(p.valueDate),
            receivedDate: String(p.receivedDate),
            instrument: String(p.instrument),
            ...(p.payerReference !== undefined ? { payerReference: String(p.payerReference) } : {}),
            sourceMessageRef: String(p.sourceMessageRef),
            remittanceRefs: (p.remittanceRefs as string[]) ?? [],
          },
          amountUnits: exactMinorUnits(amount),
          appliedUnits: 0n,
          identified: p.customerRef !== undefined,
          onAccount: false,
          returned: false,
        });
        break;
      }
      case "cash.identified": {
        const receipt = receipts.get(String(p.cashReceiptId));
        if (receipt) {
          receipt.identified = true;
          receipt.receipt = { ...receipt.receipt, customerRef: String(p.customerRef) };
        }
        break;
      }
      case "cash.placed-on-account": {
        const receipt = receipts.get(String(p.cashReceiptId));
        if (receipt) receipt.onAccount = true;
        break;
      }
      case "application.made": {
        const application: Application = {
          applicationId: String(p.applicationId),
          cashReceiptId: String(p.cashReceiptId),
          openItemId: String(p.openItemId),
          appliedAmount: money(p.appliedAmount),
          strategy: (p.strategy as Application["strategy"]) ?? "partial",
          matcherRef: entry.methodRef,
        };
        applications.set(application.applicationId, application);
        const item = items.get(application.openItemId);
        if (item) item.consumedUnits += exactMinorUnits(money(p.appliedAmount));
        const receipt = receipts.get(application.cashReceiptId);
        if (receipt) receipt.appliedUnits += exactMinorUnits(money(p.appliedAmount));
        break;
      }
      case "application.reversed": {
        const target = applications.get(String(p.applicationId));
        if (target && target.reversedBy === undefined) {
          applications.set(target.applicationId, { ...target, reversedBy: entry.entryId });
          const units = exactMinorUnits(
            exactMoneySchema.parse(target.appliedAmount),
          );
          const item = items.get(target.openItemId);
          if (item) item.consumedUnits -= units;
          const receipt = receipts.get(target.cashReceiptId);
          if (receipt) receipt.appliedUnits -= units;
        }
        break;
      }
      case "adjustment.recorded":
      case "writeoff.recorded": {
        const item = items.get(String(p.openItemId));
        if (item) {
          item.consumedUnits += exactMinorUnits(money(p.amount));
          if (entry.kind === "writeoff.recorded") item.writtenOff = true;
        }
        break;
      }
      case "shortpay.classified":
      case "receivable.amended":
        // Facts consumed by explanation and policy paths; no balance effect.
        break;
    }
  }

  const openItems = new Map<string, OpenItem>();
  for (const [id, m] of items) {
    const openUnits = m.originalUnits - m.consumedUnits;
    const { currency, scale } = m.item.originalAmount as ExactMoney;
    const state: OpenItem["state"] = m.superseded
      ? "superseded"
      : m.writtenOff
        ? "written-off"
        : m.assigned
          ? "assigned"
          : openUnits === 0n
            ? "cleared"
            : openUnits < m.originalUnits
              ? "partially-applied"
              : "open";
    openItems.set(id, {
      ...m.item,
      openAmount: exactMoneyFromMinorUnits(openUnits, currency, scale),
      state,
      freshness: "current",
    });
  }

  const cashReceipts = new Map<string, CashReceipt>();
  for (const [id, m] of receipts) {
    const unappliedUnits = m.amountUnits - m.appliedUnits;
    const { currency, scale } = m.receipt.amount as ExactMoney;
    const state: CashReceipt["state"] = m.returned
      ? "returned"
      : !m.identified
        ? "unidentified"
        : unappliedUnits === 0n
          ? "fully-applied"
          : m.appliedUnits > 0n
            ? "partially-applied"
            : m.onAccount
              ? "on-account"
              : "identified-unapplied";
    cashReceipts.set(id, {
      ...m.receipt,
      state,
      unappliedAmount: exactMoneyFromMinorUnits(unappliedUnits, currency, scale),
    });
  }

  return { openItems, receipts: cashReceipts, applications };
}
