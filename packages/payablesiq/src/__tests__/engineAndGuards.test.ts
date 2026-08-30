// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createPayablesIqEngine, type CallContext } from "../engine.js";
import { createInMemoryPayablesRepositories } from "../memory.js";
import type { AgingScheme, PayableObligation } from "../model.js";

const usd = (amount: string) => ({ amount, currency: "USD", scale: 2 });

const quality = {
  coverage: "adequate",
  freshness: "adequate",
  sourceStrength: "observed-local",
  sampleSufficiency: "adequate",
  normalizationQuality: "adequate",
  assumptionLoad: "light",
  historicalReliability: "unknown",
} as const;

function obligation(overrides?: Partial<PayableObligation>): PayableObligation {
  return {
    obligationId: "ob-1",
    ownership: "tenant-private",
    ownerRef: "org-1",
    version: 1,
    vendorRef: "vendor-A",
    vendorIdentityResolution: "unresolved",
    originKind: "invoice-asserted",
    sourceDocumentKey: "inv-100",
    originalAmount: usd("1000.00"),
    currency: "USD",
    installmentSequence: 1,
    termsResolution: "derived",
    termsDate: "2026-08-01",
    dueDate: "2026-08-31",
    discountSchedule: [{ days: 10, percentage: "2" }],
    status: "open",
    openAmount: usd("1000.00"),
    applications: [],
    fundingRoute: "direct",
    assumedMoneyScale: 2,
    ledgerAcknowledgement: "unknown",
    evidence: quality,
    freshness: "current",
    trace: { correlationId: "c-1" },
    ...overrides,
  };
}

const ctx = (asOf = "2026-08-05", org = "org-1"): CallContext => ({
  tenant: { organizationId: org, roles: [] },
  trace: { correlationId: "c-1" },
  asOf,
});

function engine() {
  const repos = createInMemoryPayablesRepositories();
  return { engine: createPayablesIqEngine({ ...repos }), repos };
}

const SCHEME: AgingScheme = {
  methodRef: { methodId: "scheme.standard", semanticVersion: "1.0.0", effectiveFrom: "2026-01-01" },
  basis: "due-date",
  buckets: [
    { name: "0-30", lowerDays: 0, upperDays: 31 },
    { name: "31+", lowerDays: 31, upperDays: Number.MAX_SAFE_INTEGER },
  ],
  futureBucket: "not-yet-due",
  termsUnknownBucket: "terms-unknown",
};

describe("the engine surface", () => {
  it("records once and suppresses the duplicate assertion by fingerprint (idempotency scope 1)", async () => {
    const { engine: e } = engine();
    const first = await e.recordObligation({ obligation: obligation() }, ctx());
    expect(first.ok).toBe(true);
    const duplicate = await e.recordObligation({ obligation: obligation() }, ctx());
    expect(duplicate.ok).toBe(true);
    if (duplicate.ok) expect(duplicate.value.duplicateOf).toBe("ob-1");
    // A DIFFERENT tenant's identical assertion is NOT a duplicate — isolation.
    const otherTenant = await e.recordObligation({ obligation: obligation() }, ctx("2026-08-05", "org-2"));
    expect(otherTenant.ok && !("duplicateOf" in otherTenant.value && otherTenant.value.duplicateOf)).toBe(true);
  });

  it("evaluates the discount only with a named yield method — no default (GC-34)", async () => {
    const { engine: e } = engine();
    await e.recordObligation({ obligation: obligation() }, ctx());
    const missing = await e.evaluateEarlyPaymentDiscount({ obligationId: "ob-1", paymentLeadDays: 2 }, ctx());
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.refusal.kind).toBe("missing-method-argument");
      expect(missing.refusal.detail).toContain("7.85");
    }
    const evaluated = await e.evaluateEarlyPaymentDiscount(
      { obligationId: "ob-1", yieldMethod: "simple-360", paymentLeadDays: 2 },
      ctx("2026-08-05"),
    );
    expect(evaluated.ok).toBe(true);
    if (evaluated.ok) {
      expect(evaluated.value.verdict).toBe("capturable");
      expect(evaluated.value.discountAmount.amount).toBe("20.00");
      expect(evaluated.value.annualizedYield.percent).toBe("36.7347");
      expect(evaluated.value.discountDate).toBe("2026-08-11");
    }
  });

  it("ages through the engine with the read-path reconciliation in force", async () => {
    const { engine: e } = engine();
    await e.recordObligation({ obligation: obligation() }, ctx());
    const snapshot = await e.agePayables(
      { scheme: SCHEME, method: "open-amount-original-basis", agingRunId: "run-1" },
      ctx("2026-09-05"),
    );
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.buckets[0]?.name).toBe("0-30"); // 5 days past due
      expect(snapshot.value.buckets[0]?.total.amount).toBe("1000.00");
    }
  });

  it("applies a settlement end to end, then a replay converges", async () => {
    const { engine: e } = engine();
    await e.recordObligation({ obligation: obligation() }, ctx());
    const application = {
      applicationId: "app-1",
      obligationId: "ob-1",
      appliedAmount: usd("1000.00"),
      applicationDate: "2026-08-10",
      kind: "settlement",
      sourceRef: "pay-1",
      idempotencyKey: "k-1",
    };
    const applied = await e.applySettlement({ application }, ctx());
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.value.status).toBe("settled");
    const replay = await e.applySettlement({ application }, ctx());
    expect(replay.ok && replay.value.replayed).toBe(true);
  });

  it("prioritizes deterministically: discount tier first, then due date, total order", async () => {
    const { engine: e } = engine();
    // Distinct source documents: identical fingerprints would (correctly)
    // suppress the later three as duplicate assertions of the first.
    await e.recordObligation({ obligation: obligation({ obligationId: "late", sourceDocumentKey: "inv-101", dueDate: "2026-08-10", discountSchedule: [] }) }, ctx());
    await e.recordObligation({ obligation: obligation({ obligationId: "disc", sourceDocumentKey: "inv-102", termsDate: "2026-08-01", dueDate: "2026-08-31" }) }, ctx());
    await e.recordObligation(
      { obligation: obligation({ obligationId: "held-1", sourceDocumentKey: "inv-103", status: "held", discountSchedule: [] }) },
      ctx(),
    );
    await e.recordObligation(
      { obligation: obligation({ obligationId: "scf", sourceDocumentKey: "inv-104", fundingRoute: "supplier-finance", discountSchedule: [] }) },
      ctx(),
    );
    const outcome = await e.prioritizeObligations(
      { yieldMethod: "simple-360", paymentLeadDays: 2, costOfCapital: { percent: "10" } },
      ctx("2026-08-05"),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.candidates.map((c) => c.obligationId)).toEqual(["disc", "late"]);
    expect(outcome.value.excluded.map((x) => `${x.obligationId}:${x.reason}`).sort()).toEqual([
      "held-1:status:held",
      "scf:funding:supplier-finance",
    ]);
  });

  it("builds a deterministic PostingProposal and refuses while recalculation-required", async () => {
    const { engine: e } = engine();
    await e.recordObligation({ obligation: obligation() }, ctx());
    const input = {
      obligationId: "ob-1",
      kind: "liability-recognition" as const,
      bookId: "book-usd",
      effectiveDate: "2026-08-15",
      periodRef: { fiscalYear: 2026, periodNumber: 8 },
      mapping: { expenseOrClearingAccount: "5000", payablesControlAccount: "2000" },
    };
    const p1 = await e.proposePostings(input, ctx());
    const p2 = await e.proposePostings(input, ctx());
    expect(p1.ok && p2.ok).toBe(true);
    if (p1.ok && p2.ok) {
      // Byte-identical for unchanged facts, same key (idempotency scope 3).
      expect(JSON.stringify(p1.value)).toBe(JSON.stringify(p2.value));
      expect(p1.value.proposedBy).toBe("hive.payablesiq");
      expect(p1.value.idempotencyKey).toContain("ob-1|v1|liability-recognition");
    }
    // Stale blocks the accounting consequence.
    const { engine: e2 } = engine();
    await e2.recordObligation({ obligation: obligation({ freshness: "recalculation-required" }) }, ctx());
    const stale = await e2.proposePostings(input, ctx());
    expect(!stale.ok && stale.refusal.kind).toBe("stale-result");
  });

  it("refuses 'accounted for' while the ledger acknowledgement is unknown", async () => {
    const { engine: e } = engine();
    await e.recordObligation({ obligation: obligation() }, ctx());
    const outcome = await e.reportAccountedFor({ obligationId: "ob-1" }, ctx());
    expect(outcome.ok).toBe(false);
    const { engine: e2 } = engine();
    await e2.recordObligation({ obligation: obligation({ ledgerAcknowledgement: "posted" }) }, ctx());
    const posted = await e2.reportAccountedFor({ obligationId: "ob-1" }, ctx());
    expect(posted.ok).toBe(true);
  });

  it("explains L0/L1 deterministically and refuses unbuilt levels honestly", async () => {
    const { engine: e } = engine();
    await e.recordObligation({ obligation: obligation() }, ctx());
    const l1 = await e.explain({ obligationId: "ob-1", level: "L1" }, ctx());
    expect(l1.ok).toBe(true);
    const l4 = await e.explain({ obligationId: "ob-1", level: "L4" }, ctx());
    expect(l4.ok).toBe(false);
  });

  it("isolates tenants: org-2 cannot see org-1's obligations", async () => {
    const { engine: e } = engine();
    await e.recordObligation({ obligation: obligation() }, ctx());
    const foreign = await e.computeVendorBalance({ vendorRef: "vendor-A" }, ctx("2026-08-05", "org-2"));
    expect(foreign.ok && foreign.value.perCurrency).toHaveLength(0);
    const missing = await e.evaluateEarlyPaymentDiscount(
      { obligationId: "ob-1", yieldMethod: "simple-360", paymentLeadDays: 1 },
      ctx("2026-08-05", "org-2"),
    );
    expect(missing.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Architecture guards — §29. Each proven to fail by injection during the
// build (violation added, guard observed red, violation reverted).
// ─────────────────────────────────────────────────────────────────────────────

const SRC = join(process.cwd(), "packages/payablesiq/src");

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

const files = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("guards — imports, purity, no vendor data, no journal writer, no defaults", () => {
  it("G-1..G-4: imports only contracts, core-kit and zod (both import forms)", () => {
    for (const f of files) {
      expect(
        /(?:from|import)\s+"@proworks-hub\/(?!contracts|core-kit)[a-z-]+/.test(f.text),
        f.path,
      ).toBe(false);
      expect(/(?:from|import)\s+"(@ksix|@makerops|@shared)\//.test(f.text), f.path).toBe(false);
    }
  });
  it("G-5: no clock, randomness, network, filesystem or float money in the kernel", () => {
    for (const f of files) {
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random|crypto\.randomUUID/.test(f.text), f.path).toBe(false);
      expect(/(?:from|import)\s+"node:(fs|net|http)/.test(f.text), f.path).toBe(false);
      expect(/\bfetch\s*\(/.test(f.text), f.path).toBe(false);
      // Float arithmetic is confined to the yield's irrational exponent, which
      // produces an advisory Percentage, never Money.
      expect(/Math\.round|parseFloat|toFixed\(/.test(f.text.replace(/Math\.round\(yearly \* 1e12\)/, "").replace(/\.toFixed\(4\)/, "")), f.path).toBe(false);
    }
  });
  it("G-6: no private bus, retry loop, or subscription", () => {
    for (const f of files) {
      expect(/retryWithBackoff|setInterval|setTimeout\(|\.subscribe\(/.test(f.text), f.path).toBe(false);
    }
  });
  it("G-7 / LOCK-1: the public surface exposes nothing that writes a journal", () => {
    for (const f of files) {
      expect(/postEntry|writeJournal|appendJournal|postToLedger/.test(f.text), f.path).toBe(false);
    }
  });
  it("SR-01: no vendor master data — no name, address, bank detail or tax id field", () => {
    const model = files.find((f) => f.path.includes("model.ts"));
    expect(model).toBeDefined();
    expect(/vendorName|vendorAddress|bankAccount|iban\b|taxId|vatNumber/i.test(model?.text ?? "")).toBe(false);
  });
  it("SR-06: no default for yieldMethod, discountBase, currency, aging basis or lead time", () => {
    for (const f of files) {
      expect(/yieldMethod\s*[=:]\s*"simple/.test(f.text) && !f.path.includes("__tests__"), f.path).toBe(false);
      expect(/paymentLeadDays\s*\?\?\s*0/.test(f.text), f.path).toBe(false);
      expect(/\.default\("USD"\)|currency\s*=\s*"USD"/.test(f.text), f.path).toBe(false);
    }
  });
  it("the repositories are structurally immutable: no update/delete method declarations", () => {
    const ports = files.find((f) => f.path.endsWith("ports.ts"));
    expect(/^\s*(update|delete|remove|amend)\w*\s*\(/m.test(ports?.text ?? "")).toBe(false);
  });
});
