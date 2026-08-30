// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  addExactMoney,
  exactMinorUnits,
  exactMoneyFromMinorUnits,
  isPermitted,
  isSoleBasisAiCandidate,
  multiplyExactMoneyByRate,
  postingProposalSchema,
  type AuthorityEnvelope,
  type ExactMoney,
  type ExchangeRateRef,
  type FxRateType,
  type GovernanceDecision,
  type PostingProposal,
  type RiskClass,
} from "@proworks-hub/contracts";

import { refusal, type LedgerRefusal } from "../contractsLocal/refusals.js";
import type {
  Account,
  AccountingCalendar,
  Book,
  ChartOfAccountsVersion,
  DimensionSchema,
  JournalEntry,
  JournalLine,
  Period,
  PeriodState,
} from "../model/model.js";
import { canonicalJson, deterministicEntryId, fnv1a64 } from "./hash.js";
import { LEDGER_METHODS } from "./methods.js";
import { meetsRiskFloor, periodAdmitsEntry } from "./period.js";

// ─────────────────────────────────────────────────────────────────────────────
// LEDGER-PROPOSAL-VALIDATION/1.0.0 — the ordered ladder, gates 1–28.
//
// ORDER IS PART OF THE SPECIFICATION (§16.2). Two implementations that check
// the same conditions in a different order return different refusals for the
// same bad input, and a refusal that changes with implementation is not a
// contract. The FIRST failure is returned. Ordering is by consequence, not by
// cheapness: an unbalanced proposal into a closed period is told about the
// period, because fixing the balance and retrying into a closed period is a
// loop for nothing.
//
// Gates 1–28 are PURE: no I/O, no clock, no randomness. Everything the ladder
// needs arrives in the snapshot, prefetched by the runtime. Gates 29–30 (the
// store) live in runtime/, not here.
//
// THERE IS NO GATE THAT CHECKS WHO PROPOSED. The ladder never consults a
// roster of authorized proposing engines. `proposedBy` is recorded and read by
// attribution and the control-account gate — gate 15 reads the ACCOUNT'S OWN
// `controlledBySource`, per-account configuration, not a global list.
// Authority to post is decided by the account's reservations, by Governance
// and by the entry's own integrity — never by membership of a list.
// ─────────────────────────────────────────────────────────────────────────────

/** A governance decision together with the envelope it answered — LedgerIQ verifies; it never evaluates policy. */
export interface SuppliedAuthorization {
  readonly decision: GovernanceDecision;
  readonly envelope: AuthorityEnvelope;
}

/** Everything the pure ladder needs, prefetched. */
export interface LedgerSnapshot {
  readonly book: Book | undefined;
  readonly chartVersions: readonly ChartOfAccountsVersion[];
  readonly calendar: AccountingCalendar | undefined;
  readonly dimensionSchema: DimensionSchema | undefined;
  /** Current state per period, keyed `${fiscalYear}-${periodNumber}`. */
  readonly periodStates: Readonly<Record<string, PeriodState>>;
  /** ISO-4217 → scale, supplied as configuration. Never hard-coded, never defaulted. */
  readonly currencyRegistry: Readonly<Record<string, number>>;
  /** Replay lookup result for this proposal's idempotency key, when one exists. */
  readonly existingForKey?: { readonly entryId: string; readonly contentHash: string };
  /** The reversal target, when the proposal names one. */
  readonly reversalTarget?: JournalEntry;
  /** Rates prefetched by the runtime, or the fact that no port is bound. */
  readonly fxRates: readonly ExchangeRateRef[] | "port-unbound";
  /**
   * The resolved human principal for a manual entry, when the runtime could
   * resolve one. Absent = unresolved, and gate 27 refuses.
   */
  readonly resolvedPrincipal?: string;
}

export interface ValidationSuccess {
  readonly ok: true;
  /** The entry, complete except journalSequence (assigned at append, gaplessly). */
  readonly entry: Omit<JournalEntry, "journalSequence">;
  /** Functional debit/credit totals — the proposer's own equality check. */
  readonly functionalTotals: { readonly debits: ExactMoney; readonly credits: ExactMoney };
  /** Lines LedgerIQ generated (residue, intercompany), visible, never silent. */
  readonly generatedLines: readonly JournalLine[];
  readonly replay: false;
}

export interface ValidationReplay {
  readonly ok: true;
  readonly replay: true;
  /** The ORIGINAL entry id. A retry found its first attempt; nothing posted twice. */
  readonly entryId: string;
}

export interface ValidationRefusal {
  readonly ok: false;
  readonly refusal: LedgerRefusal;
}

export type ValidationOutcome = ValidationSuccess | ValidationReplay | ValidationRefusal;

export interface ValidateInput {
  /** Untrusted. Gate 1 parses it. */
  readonly proposal: unknown;
  /** Supplied by the host per call. NEVER a clock read (§13.4). */
  readonly recordedAt: string | undefined;
  readonly snapshot: LedgerSnapshot;
  /** Present when the operation requires one (control-account bypass, pending-close adjustment). */
  readonly authorization?: SuppliedAuthorization;
}

const V = LEDGER_METHODS.proposalValidation;

const no = (r: LedgerRefusal): ValidationRefusal => ({ ok: false, refusal: r });

/** The semantic content the idempotency contract hashes — transport and trace excluded (§23.2). */
function semanticContent(p: PostingProposal): unknown {
  return {
    bookId: p.bookId,
    effectiveDate: p.effectiveDate,
    periodRef: p.periodRef,
    entryType: p.entryType ?? "standard",
    lines: p.lines.map((l) => ({
      lineNo: l.lineNo,
      accountCode: l.accountCode,
      side: l.side,
      amount: l.amount,
      statisticalQuantity: l.statisticalQuantity,
      dimensions: l.dimensions,
      openItemRef: l.openItemRef,
    })),
    reversalOf: p.reversalOf,
  };
}

export function proposalContentHash(p: PostingProposal): string {
  return fnv1a64(canonicalJson(semanticContent(p)));
}

function chartVersionAt(
  versions: readonly ChartOfAccountsVersion[],
  date: string,
): ChartOfAccountsVersion | undefined {
  return versions.find(
    (v) => v.effectiveFrom <= date && (v.effectiveTo === undefined || date <= v.effectiveTo),
  );
}

function periodFor(calendar: AccountingCalendar, fy: number, pn: number): Period | undefined {
  return calendar.periods.find(
    (p) => p.periodRef.fiscalYear === fy && p.periodRef.periodNumber === pn,
  );
}

function daysBetween(earlierIso: string, laterIso: string): number {
  const ms = Date.parse(laterIso + "T00:00:00Z") - Date.parse(earlierIso + "T00:00:00Z");
  return Math.floor(ms / 86_400_000);
}

/**
 * Verifies a supplied governance decision against the operation — permit,
 * purpose binding, expiry, risk floor. LedgerIQ VERIFIES a decision; it does
 * not evaluate policy (§12.3), because the platform coordinator already does.
 */
export function authorizationSatisfies(
  auth: SuppliedAuthorization | undefined,
  expectedPurpose: string,
  floor: RiskClass,
  atInstant: string | undefined,
): { ok: true } | { ok: false; why: string } {
  if (!auth) return { ok: false, why: "No governance decision was supplied." };
  if (!isPermitted(auth.decision)) {
    return { ok: false, why: `The decision is ${auth.decision.decision}: ${auth.decision.reason}` };
  }
  if (auth.envelope.purpose !== expectedPurpose) {
    return {
      ok: false,
      why: `The decision's purpose is "${auth.envelope.purpose}"; this operation is "${expectedPurpose}". Access for one purpose does not authorize another.`,
    };
  }
  if (!meetsRiskFloor(auth.envelope.riskClass, floor)) {
    return {
      ok: false,
      why: `The decision was taken at risk class "${auth.envelope.riskClass}"; this operation's floor is "${floor}".`,
    };
  }
  if (auth.envelope.expiresAt !== undefined && atInstant !== undefined && auth.envelope.expiresAt < atInstant) {
    return { ok: false, why: "The decision's authority has expired. Authority does not outlive its issue." };
  }
  return { ok: true };
}

export function validateProposal(input: ValidateInput): ValidationOutcome {
  const { snapshot } = input;

  // ── Gate 1: the proposal parses against the shared schema ────────────────
  const parsed = postingProposalSchema.safeParse(input.proposal);
  if (!parsed.success) {
    return no(
      refusal(
        "PROPOSAL_MALFORMED",
        V,
        "Correct the proposal to the shared PostingProposal schema; the parse error names the field.",
        parsed.error.issues[0] ? parsed.error.issues[0].path.join(".") : undefined,
      ),
    );
  }
  const p = parsed.data;
  const entryType = p.entryType ?? "standard";

  // ── Gate 2: the book resolves ────────────────────────────────────────────
  const book = snapshot.book;
  if (!book || book.bookId !== p.bookId) {
    return no(refusal("UNKNOWN_BOOK", V, "Name a book this installation holds.", p.bookId));
  }

  // ── Gate 3: the book is active ───────────────────────────────────────────
  if (book.status !== "active") {
    return no(refusal("BOOK_INACTIVE", V, "The book is suspended; reactivate it or target another.", p.bookId));
  }

  // ── Gate 4: idempotency key present ──────────────────────────────────────
  if (!p.idempotencyKey || p.idempotencyKey.length === 0) {
    return no(
      refusal(
        "IDEMPOTENCY_KEY_MISSING",
        V,
        "Derive a deterministic idempotency key from the business facts and the proposing method version, and retry.",
      ),
    );
  }

  // ── Gate 5: replay detection ─────────────────────────────────────────────
  const contentHash = proposalContentHash(p);
  if (snapshot.existingForKey) {
    if (snapshot.existingForKey.contentHash === contentHash) {
      // The retry found its original. Success, and nothing posts twice.
      return { ok: true, replay: true, entryId: snapshot.existingForKey.entryId };
    }
    return no(
      refusal(
        "IDEMPOTENCY_KEY_CONFLICT",
        V,
        "The key was used for different content. Never reuse a key; derive it from the facts it posts.",
        p.idempotencyKey,
      ),
    );
  }

  // ── Gate 6: recordedAt supplied ──────────────────────────────────────────
  if (!input.recordedAt) {
    return no(
      refusal(
        "RECORD_TIME_MISSING",
        V,
        "Supply recordedAt explicitly. LedgerIQ reads no clock; a host that forgets gets a refusal, not a silently stamped time.",
      ),
    );
  }

  // ── Gate 7: the period resolves ──────────────────────────────────────────
  const calendar = snapshot.calendar;
  const period = calendar
    ? periodFor(calendar, p.periodRef.fiscalYear, p.periodRef.periodNumber)
    : undefined;
  if (!period) {
    return no(
      refusal(
        "PERIOD_NOT_FOUND",
        V,
        "Target a period the book's calendar defines.",
        `${p.periodRef.fiscalYear}-${p.periodRef.periodNumber}`,
      ),
    );
  }

  // ── Gate 8: effective date inside the period ─────────────────────────────
  if (p.effectiveDate < period.startDate || p.effectiveDate > period.endDate) {
    return no(
      refusal(
        "EFFECTIVE_DATE_OUTSIDE_PERIOD",
        V,
        `Use an effective date within ${period.startDate}..${period.endDate}, or target the period containing ${p.effectiveDate}.`,
        p.effectiveDate,
      ),
    );
  }

  // ── Gate 9: the period's state admits this entry type ────────────────────
  const stateKey = `${p.periodRef.fiscalYear}-${p.periodRef.periodNumber}`;
  const state = snapshot.periodStates[stateKey] ?? "future";
  if (!periodAdmitsEntry(state, entryType)) {
    const code =
      state === "future"
        ? "PERIOD_FUTURE"
        : state === "pending-close"
          ? "PERIOD_PENDING_CLOSE"
          : state === "permanently-closed"
            ? "PERIOD_PERMANENTLY_CLOSED"
            : "PERIOD_CLOSED";
    return no(
      refusal(
        code,
        LEDGER_METHODS.periodState,
        state === "pending-close"
          ? "The period is in cut-off: only adjusting entries with an elevated decision post here."
          : state === "future"
            ? "Open the period first, or post to an open period."
            : "A closed period admits nothing. A correction is a new entry in an open period.",
        stateKey,
      ),
    );
  }

  // ── Gate 10: at least two lines ──────────────────────────────────────────
  if (p.lines.length < 2) {
    return no(
      refusal("ENTRY_TOO_FEW_LINES", V, "Double entry takes two sides: propose at least two lines."),
    );
  }

  // ── Gate 11: line numbering dense from 1 ─────────────────────────────────
  const numbers = p.lines.map((l) => l.lineNo).sort((a, b) => a - b);
  const dense = numbers.every((n, i) => n === i + 1);
  if (!dense) {
    return no(
      refusal(
        "LINE_NUMBERING_INVALID",
        V,
        "Number lines densely from 1 with no duplicates; export ordering depends on it.",
        numbers.join(","),
      ),
    );
  }

  // ── Gate 12: every account resolves in the chart version at the date ─────
  const chart = chartVersionAt(snapshot.chartVersions, p.effectiveDate);
  const accountByCode = new Map<string, Account>();
  if (chart) for (const a of chart.accounts) accountByCode.set(a.accountCode, a);
  for (const line of p.lines) {
    if (!chart || !accountByCode.has(line.accountCode)) {
      return no(
        refusal(
          "ACCOUNT_UNKNOWN",
          V,
          chart
            ? "Propose to an account the chart version effective at the entry's date defines."
            : `No chart version is effective at ${p.effectiveDate}.`,
          `line ${line.lineNo}: ${line.accountCode}`,
        ),
      );
    }
  }
  // chart is defined from here on.
  const chartVersion = chart as ChartOfAccountsVersion;

  // ── Gate 13: every account is postable ───────────────────────────────────
  for (const line of p.lines) {
    const account = accountByCode.get(line.accountCode) as Account;
    if (!account.postable) {
      return no(
        refusal(
          "ACCOUNT_NOT_POSTABLE",
          V,
          "Post to a leaf account; summary accounts hold structure, not entries.",
          `line ${line.lineNo}: ${line.accountCode}`,
        ),
      );
    }
  }

  // ── Gate 14: no account blocked at the effective date ────────────────────
  for (const line of p.lines) {
    const account = accountByCode.get(line.accountCode) as Account;
    const blocked =
      account.blockedFrom !== undefined &&
      p.effectiveDate >= account.blockedFrom &&
      (account.blockedTo === undefined || p.effectiveDate <= account.blockedTo);
    if (blocked) {
      return no(
        refusal(
          "ACCOUNT_BLOCKED_AT_DATE",
          V,
          "The account is blocked at this date; use its replacement or an unblocked date.",
          `line ${line.lineNo}: ${line.accountCode}`,
        ),
      );
    }
  }

  // ── Gate 15: control-account reservations (LEDGER-CONTROL-ACCOUNT) ───────
  // Reads the ACCOUNT'S OWN reservation, never a roster of proposers.
  for (const line of p.lines) {
    const account = accountByCode.get(line.accountCode) as Account;
    if (account.controlledBySource !== undefined && account.controlledBySource !== p.proposedBy) {
      const bypass = authorizationSatisfies(
        input.authorization,
        `post:control-account:${line.accountCode}`,
        "elevated",
        input.recordedAt,
      );
      if (!bypass.ok) {
        return no(
          refusal(
            "ACCOUNT_CONTROL_RESERVED",
            LEDGER_METHODS.controlAccount,
            `The account is reserved for ${account.controlledBySource}. Propose to the reciprocal account, have the chart owner release the reservation, or supply an elevated decision for purpose "post:control-account:${line.accountCode}".`,
            `line ${line.lineNo}: ${line.accountCode}`,
          ),
        );
      }
    }
  }

  // ── Gate 16: line currency permitted on the account ──────────────────────
  for (const line of p.lines) {
    if (!line.amount) continue;
    const account = accountByCode.get(line.accountCode) as Account;
    if (
      account.permittedCurrencies !== "any" &&
      !account.permittedCurrencies.includes(line.amount.currency)
    ) {
      return no(
        refusal(
          "CURRENCY_NOT_PERMITTED_ON_ACCOUNT",
          V,
          `The account permits ${(account.permittedCurrencies as string[]).join(", ")}.`,
          `line ${line.lineNo}: ${line.amount.currency}`,
        ),
      );
    }
  }

  // ── Gate 17: Money.scale matches the currency's declared scale ───────────
  for (const line of p.lines) {
    if (!line.amount) continue;
    const declared = snapshot.currencyRegistry[line.amount.currency];
    if (declared === undefined) {
      return no(
        refusal(
          "SCALE_VIOLATION",
          V,
          `Currency ${line.amount.currency} is not in the installation's currency registry; register it with its ISO-4217 scale.`,
          `line ${line.lineNo}: ${line.amount.currency}`,
        ),
      );
    }
    if (line.amount.scale !== declared) {
      return no(
        refusal(
          "SCALE_VIOLATION",
          V,
          `${line.amount.currency} carries ${declared} minor-unit digits, not ${line.amount.scale}.`,
          `line ${line.lineNo}`,
        ),
      );
    }
  }

  // ── Gate 18: statistical lines on statistical accounts, and vice versa ───
  for (const line of p.lines) {
    const account = accountByCode.get(line.accountCode) as Account;
    if (line.statisticalQuantity !== undefined && account.accountClass !== "statistical") {
      return no(
        refusal(
          "STATISTICAL_ON_MONETARY_ACCOUNT",
          LEDGER_METHODS.balanceIntegrity,
          "Record quantities on a statistical account; monetary accounts hold Money.",
          `line ${line.lineNo}: ${line.accountCode}`,
        ),
      );
    }
    if (line.amount !== undefined && account.accountClass === "statistical") {
      return no(
        refusal(
          "MONETARY_ON_STATISTICAL_ACCOUNT",
          LEDGER_METHODS.balanceIntegrity,
          "Record Money on a monetary account; statistical accounts hold quantities.",
          `line ${line.lineNo}: ${line.accountCode}`,
        ),
      );
    }
  }

  // ── Gates 19–21: dimensions ──────────────────────────────────────────────
  for (const line of p.lines) {
    const account = accountByCode.get(line.accountCode) as Account;
    for (const required of account.requiredDimensions) {
      if (!(required in line.dimensions)) {
        return no(
          refusal(
            "DIMENSION_REQUIRED_MISSING",
            V,
            `Account ${line.accountCode} requires dimension "${required}". A missing dimension never becomes blank.`,
            `line ${line.lineNo}: ${required}`,
          ),
        );
      }
    }
  }
  if (snapshot.dimensionSchema) {
    const schema = snapshot.dimensionSchema;
    const valueSets = new Map(
      schema.dimensions.map((d) => [d.code, d.values] as const),
    );
    for (const line of p.lines) {
      for (const [code, valueCode] of Object.entries(line.dimensions)) {
        const values = valueSets.get(code);
        const match = values?.find((v) => v.valueCode === valueCode);
        const effective =
          match !== undefined &&
          (match.effectiveFrom === undefined || match.effectiveFrom <= p.effectiveDate) &&
          (match.effectiveTo === undefined || p.effectiveDate <= match.effectiveTo);
        if (!effective) {
          return no(
            refusal(
              "DIMENSION_VALUE_UNKNOWN",
              V,
              `"${valueCode}" is not a value of dimension "${code}" at ${p.effectiveDate}.`,
              `line ${line.lineNo}: ${code}=${valueCode}`,
            ),
          );
        }
      }
    }
    for (const line of p.lines) {
      for (const rule of schema.crossValidationRules) {
        if (
          line.dimensions[rule.when.dimensionCode] === rule.when.valueCode &&
          line.dimensions[rule.forbid.dimensionCode] === rule.forbid.valueCode
        ) {
          return no(
            refusal(
              "DIMENSION_COMBINATION_INVALID",
              V,
              `Rule ${rule.ruleId}: ${rule.when.dimensionCode}=${rule.when.valueCode} forbids ${rule.forbid.dimensionCode}=${rule.forbid.valueCode}.`,
              `line ${line.lineNo}`,
            ),
          );
        }
      }
    }
  }

  // ── Gates 22/22a: FX — rate type declared, conversion possible ───────────
  const functional = book.functionalCurrency;
  const foreignLines = p.lines.filter(
    (l) => l.amount !== undefined && l.amount.currency !== functional.code,
  );
  const rateType: FxRateType | undefined = book.fxRateType ?? p.fxRateType;
  if (foreignLines.length > 0 && rateType === undefined) {
    return no(
      refusal(
        "FX_RATE_TYPE_UNDECLARED",
        LEDGER_METHODS.fxConversion,
        "Declare an FX rate type (spot-at-transaction-date, period-average or period-fixed) on the book or the proposal. Three conventions are defensible; none is a default.",
      ),
    );
  }
  const ratesByBase = new Map<string, ExchangeRateRef>();
  if (foreignLines.length > 0) {
    if (snapshot.fxRates === "port-unbound") {
      return no(
        refusal(
          "FX_PORT_UNBOUND",
          LEDGER_METHODS.fxConversion,
          "No FxRateSource is bound in this installation. Same-currency postings continue; nothing posts at an assumed rate.",
        ),
      );
    }
    for (const line of foreignLines) {
      const from = (line.amount as ExactMoney).currency;
      const rate = (snapshot.fxRates as readonly ExchangeRateRef[]).find(
        (r) => r.base === from && r.rateType === rateType && r.effectiveDate <= p.effectiveDate,
      );
      if (!rate) {
        return no(
          refusal(
            "FX_RATE_UNAVAILABLE",
            LEDGER_METHODS.fxConversion,
            `No ${rateType} rate for ${from}→${functional.code} at ${p.effectiveDate}. The nearest rate is never silently substituted.`,
            `line ${line.lineNo}`,
          ),
        );
      }
      if (rate.quote !== functional.code) {
        // A rate that quotes the wrong currency would cross currencies in
        // the arithmetic. Refused HERE, before any conversion happens.
        return no(
          refusal(
            "MIXED_CURRENCY_ARITHMETIC",
            LEDGER_METHODS.fxConversion,
            `The supplied ${from} rate quotes ${rate.quote}, not the book's functional ${functional.code}. Fix the rate feed.`,
            `line ${line.lineNo}`,
          ),
        );
      }
      if (
        book.fxStalenessDays !== undefined &&
        daysBetween(rate.effectiveDate, p.effectiveDate) > book.fxStalenessDays
      ) {
        return no(
          refusal(
            "FX_RATE_STALE",
            LEDGER_METHODS.fxConversion,
            `The newest ${from} rate is ${rate.effectiveDate}, older than the book's ${book.fxStalenessDays}-day tolerance.`,
            `line ${line.lineNo}`,
          ),
        );
      }
      ratesByBase.set(from, rate);
    }
  }

  // ── LOCK-2 at the posting boundary: AI cannot be the sole basis ──────────
  // Positioned with the authority gates by consequence; structurally cheap.
  if (isSoleBasisAiCandidate(p.evidence)) {
    return no(
      refusal(
        "AI_CANDIDATE_SOLE_BASIS",
        V,
        "An AI candidate may inform an authoritative entry; it may never be its sole basis. Add deterministic or human-accepted evidence (LOCK-2).",
      ),
    );
  }

  // ── Conversion (LEDGER-FX-CONVERSION): the engine's ONE rounding boundary ─
  const lines: JournalLine[] = [];
  for (const line of p.lines) {
    const base: JournalLine = {
      lineNo: line.lineNo,
      accountCode: line.accountCode,
      chartVersionRef: chartVersion.chartVersionRef,
      side: line.side,
      dimensions: line.dimensions,
      ...(line.openItemRef !== undefined ? { openItemRef: line.openItemRef } : {}),
      ...(line.memo !== undefined ? { lineMemo: line.memo } : {}),
      ...(line.statisticalQuantity !== undefined
        ? { statisticalQuantity: line.statisticalQuantity }
        : {}),
    };
    if (line.amount !== undefined) {
      if (line.amount.currency === functional.code) {
        lines.push({ ...base, transactionAmount: line.amount, functionalAmount: line.amount });
      } else {
        const rate = ratesByBase.get(line.amount.currency) as ExchangeRateRef;
        const converted = multiplyExactMoneyByRate(
          line.amount,
          rate.rate,
          functional.code,
          functional.scale,
          book.fxRoundingMode,
        );
        lines.push({
          ...base,
          transactionAmount: line.amount,
          functionalAmount: converted,
          rateRef: rate,
        });
      }
    } else {
      lines.push(base);
    }
  }

  // ── Gate 23: rounding residue (LEDGER-ROUNDING-RESIDUE) ──────────────────
  const zero = exactMoneyFromMinorUnits(0n, functional.code, functional.scale);
  let net = 0n;
  let largestMonetary: JournalLine | undefined;
  let largestAbs = -1n;
  for (const line of lines) {
    if (!line.functionalAmount) continue;
    const units = exactMinorUnits(line.functionalAmount);
    net += line.side === "debit" ? units : -units;
    const abs = units < 0n ? -units : units;
    if (abs > largestAbs) {
      largestAbs = abs;
      largestMonetary = line;
    }
  }
  const generatedLines: JournalLine[] = [];
  const hadForeign = foreignLines.length > 0;
  if (net !== 0n && hadForeign) {
    // A conversion residue. Options rejected in §16.5: absorbing it into the
    // largest line silently changes a business amount; tolerating it in the
    // balance check is an epsilon. The residue becomes a VISIBLE line.
    const tolerance = BigInt(book.residueToleranceMinorUnits ?? p.lines.length);
    const absNet = net < 0n ? -net : net;
    if (absNet > tolerance) {
      return no(
        refusal(
          "ROUNDING_RESIDUE_EXCEEDS_TOLERANCE",
          LEDGER_METHODS.roundingResidue,
          `The residue is ${absNet} minor units against a tolerance of ${tolerance}: the conversion is wrong, not the rounding.`,
        ),
      );
    }
    if (!book.roundingResidueAccount) {
      return no(
        refusal(
          "ROUNDING_RESIDUE_UNASSIGNED",
          LEDGER_METHODS.roundingResidue,
          "Declare a roundingResidueAccount on the book; a residue with no home refuses the entry.",
        ),
      );
    }
    const residueLine: JournalLine = {
      lineNo: lines.length + 1,
      accountCode: book.roundingResidueAccount,
      chartVersionRef: chartVersion.chartVersionRef,
      // The side that zeroes the net: net > 0 means debits exceed credits.
      side: net > 0n ? "credit" : "debit",
      functionalAmount: exactMoneyFromMinorUnits(absNet, functional.code, functional.scale),
      transactionAmount: exactMoneyFromMinorUnits(absNet, functional.code, functional.scale),
      dimensions: largestMonetary ? largestMonetary.dimensions : {},
      generatedBy: LEDGER_METHODS.roundingResidue,
    };
    lines.push(residueLine);
    generatedLines.push(residueLine);
    net = 0n;
  }

  // ── Gate 24: Σ functional debits = Σ functional credits — EXACT ──────────
  // There is no epsilon. An epsilon in a ledger is a permission slip for the
  // defect it was introduced to hide (§16.3).
  let debits = zero;
  let credits = zero;
  for (const line of lines) {
    if (!line.functionalAmount) continue;
    if (line.side === "debit") debits = addExactMoney(debits, line.functionalAmount);
    else credits = addExactMoney(credits, line.functionalAmount);
  }
  if (exactMinorUnits(debits) !== exactMinorUnits(credits)) {
    return no(
      refusal(
        "UNBALANCED_ENTRY",
        LEDGER_METHODS.balanceIntegrity,
        `Functional debits ${debits.amount} ≠ credits ${credits.amount}. Double entry sums to zero; fix the proposal, not the ledger.`,
      ),
    );
  }

  // ── Gate 25: balanced within every balancing dimension value ─────────────
  if (book.balancingDimensions.length > 0) {
    for (const dimension of book.balancingDimensions) {
      const perValue = new Map<string, bigint>();
      for (const line of lines) {
        if (!line.functionalAmount) continue;
        const value = line.dimensions[dimension] ?? "<absent>";
        const units = exactMinorUnits(line.functionalAmount);
        perValue.set(value, (perValue.get(value) ?? 0n) + (line.side === "debit" ? units : -units));
      }
      const unbalanced = [...perValue.entries()].filter(([, n]) => n !== 0n);
      if (unbalanced.length > 0) {
        if (book.intercompanyRule) {
          // Opt-in repair (LEDGER-INTERCOMPANY-BALANCING): generated lines
          // are VISIBLY generated — a ledger that silently invents lines to
          // make a proposal balance is a ledger whose entries do not mean
          // what their proposer thought.
          for (const [value, n] of unbalanced) {
            const abs = n < 0n ? -n : n;
            const generated: JournalLine = {
              lineNo: lines.length + 1,
              accountCode: n > 0n ? book.intercompanyRule.dueToAccount : book.intercompanyRule.dueFromAccount,
              chartVersionRef: chartVersion.chartVersionRef,
              side: n > 0n ? "credit" : "debit",
              functionalAmount: exactMoneyFromMinorUnits(abs, functional.code, functional.scale),
              transactionAmount: exactMoneyFromMinorUnits(abs, functional.code, functional.scale),
              dimensions: { [dimension]: value },
              generatedBy: LEDGER_METHODS.intercompanyBalancing,
            };
            lines.push(generated);
            generatedLines.push(generated);
          }
        } else {
          // Default behaviour is REFUSAL, not repair.
          return no(
            refusal(
              "UNBALANCED_BY_BALANCING_DIMENSION",
              LEDGER_METHODS.dimensionBalance,
              `The entry does not balance within dimension "${dimension}" (values: ${unbalanced
                .map(([v]) => v)
                .join(", ")}). Balance each value, or declare an intercompanyRule to generate due-to/due-from lines.`,
              dimension,
            ),
          );
        }
      }
    }
  }

  // ── Gate 26: reversal integrity ──────────────────────────────────────────
  if (p.reversalOf !== undefined || entryType === "reversal") {
    if (p.reversalOf === undefined) {
      return no(
        refusal(
          "REVERSAL_TARGET_NOT_FOUND",
          LEDGER_METHODS.reversal,
          "A reversal names the entry it reverses.",
        ),
      );
    }
    const target = snapshot.reversalTarget;
    if (!target || target.entryId !== p.reversalOf) {
      return no(
        refusal(
          "REVERSAL_TARGET_NOT_FOUND",
          LEDGER_METHODS.reversal,
          "The named entry does not exist in this book.",
          p.reversalOf,
        ),
      );
    }
    if (target.reversedBy !== undefined) {
      return no(
        refusal(
          "REVERSAL_TARGET_ALREADY_REVERSED",
          LEDGER_METHODS.reversal,
          `Already reversed by ${target.reversedBy}. An entry is reversed at most once; reverse the reversal to reinstate.`,
          p.reversalOf,
        ),
      );
    }
  }

  // ── Gate 27: a manual entry has a resolved human principal ───────────────
  const entrySource = p.entrySource ?? "automated";
  if (entrySource === "manual" && snapshot.resolvedPrincipal === undefined) {
    return no(
      refusal(
        "IDENTITY_UNRESOLVED",
        V,
        "A manual entry requires a resolved human principal (AS 2401). An anonymous manual entry is refused, not recorded.",
      ),
    );
  }

  // ── Gate 28: supplied governance decision verifies (where required) ──────
  if (state === "pending-close") {
    const auth = authorizationSatisfies(
      input.authorization,
      `post:adjusting:${p.bookId}:${stateKey}`,
      "elevated",
      input.recordedAt,
    );
    if (!auth.ok) {
      return no(
        refusal(
          "NOT_AUTHORIZED",
          V,
          `An adjusting entry in cut-off needs an elevated decision for purpose "post:adjusting:${p.bookId}:${stateKey}". ${auth.why}`,
        ),
      );
    }
  }

  // ── Assemble the immutable entry (journalSequence assigned at append) ────
  const entry: Omit<JournalEntry, "journalSequence"> = {
    entryId: deterministicEntryId(p.bookId, p.idempotencyKey),
    bookId: p.bookId,
    periodRef: p.periodRef,
    journalCode: p.journalCode ?? "GEN",
    effectiveDate: p.effectiveDate,
    recordedAt: input.recordedAt,
    entryType,
    entrySource,
    proposedBy: p.proposedBy,
    proposalId: p.proposalId,
    idempotencyKey: p.idempotencyKey,
    contentHash,
    methodRef: p.methodRef,
    postingMethodRefs: [
      LEDGER_METHODS.proposalValidation,
      LEDGER_METHODS.balanceIntegrity,
      ...(hadForeign ? [LEDGER_METHODS.fxConversion] : []),
      ...(generatedLines.some((l) => l.generatedBy?.methodId === LEDGER_METHODS.roundingResidue.methodId)
        ? [LEDGER_METHODS.roundingResidue]
        : []),
      ...(generatedLines.some(
        (l) => l.generatedBy?.methodId === LEDGER_METHODS.intercompanyBalancing.methodId,
      )
        ? [LEDGER_METHODS.intercompanyBalancing]
        : []),
    ],
    evidence: p.evidence,
    trace: p.trace,
    postedByPrincipal:
      entrySource === "manual" ? (snapshot.resolvedPrincipal as string) : (p.principal ?? p.proposedBy),
    ...(input.authorization?.decision.decisionId !== undefined
      ? { governanceDecisionRef: input.authorization.decision.decisionId }
      : {}),
    ...(p.reversalOf !== undefined ? { reversalOf: p.reversalOf } : {}),
    lines,
  };

  return {
    ok: true,
    replay: false,
    entry,
    functionalTotals: { debits, credits },
    generatedLines,
  };
}
