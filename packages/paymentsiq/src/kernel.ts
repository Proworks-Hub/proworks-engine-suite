// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// PaymentsIQ kernel — §16. The fingerprint is a COMPOSITE KEY, not a hash: a
// hash can only say "different"; a composite key can say "same payee, same
// amount, same date, different obligation refs" — the sentence a clerk needs.
// The duplication rule's centre: you may not re-pay something you do not know
// the fate of — a match in an indeterminate state blocks with NO override.
// An unmapped scheme status goes to review-required, never to a default. Run
// composition produces a RECOMMEND with no release() — authority lives with
// humans.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const PAYMENTS_METHODS = {
  fingerprint: method("PAY-FINGERPRINT"),
  duplication: method("PAY-DUPLICATION"),
  statusMap: method("PAY-STATUS-MAP"),
  riskClass: method("PAY-RISK-CLASS"),
  settleRecon: method("PAY-SETTLE-RECON"),
  runCompose: method("PAY-RUN-COMPOSE"),
} as const satisfies Record<string, MethodRef>;

export const PAYMENTS_REFUSAL_KINDS = [
  "duplicate_suspected",
  "risk_bands_unconfigured",
  "netting_policy_undeclared",
] as const;
export type PaymentsRefusalKind = (typeof PAYMENTS_REFUSAL_KINDS)[number];

export interface PaymentsRefusal {
  readonly kind: PaymentsRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: PaymentsRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: PaymentsRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── §16.1 · the composite fingerprint ───────────────────────────────────────

export interface InstructionFacts {
  readonly organizationId: string;
  readonly direction: "outbound" | "inbound";
  readonly railId: string;
  readonly payerTokenRef: string;
  readonly payeeTokenRef: string;
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly requestedExecutionDate: string;
  readonly obligationRefs: readonly string[];
  readonly payeeName: string;
}

/** Documented, versioned normalization: case fold, whitespace collapse,
 * punctuation strip, NO transliteration. Part of the method version because
 * changing it changes which pairs are duplicates. */
export function normalizePayeeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,;:'"!?()\-_/\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Fingerprint {
  readonly fields: readonly string[];
  readonly key: string;
}

export function fingerprint(facts: InstructionFacts): Fingerprint {
  const fields = [
    facts.organizationId,
    facts.direction,
    facts.railId,
    facts.payerTokenRef,
    facts.payeeTokenRef,
    `${facts.amountMinor}:${facts.currencyCode}`,
    facts.requestedExecutionDate,
    [...facts.obligationRefs].sort().join("+"),
    normalizePayeeName(facts.payeeName),
  ];
  return { fields, key: fields.join("|") };
}

// ── §16.2 · duplication: never re-pay an unknown fate ───────────────────────

export type InstructionState =
  | "draft"
  | "authorized"
  | "instructed"
  | "in-flight"
  | "settled"
  | "rejected"
  | "failed"
  | "cancelled"
  | "authorization-refused";

const TERMINAL_FAILED: ReadonlySet<InstructionState> = new Set([
  "rejected",
  "failed",
  "cancelled",
  "authorization-refused",
]);

export type DuplicationAssessment =
  | { readonly verdict: "clear" }
  | {
      readonly verdict: "near";
      readonly matchedInstructionRef: string;
      readonly differingField: "obligationRefs" | "requestedExecutionDate";
      readonly blocking: false;
    }
  | {
      /** The matched prior payment demonstrably did not happen — still
       * blocking, but the override path is cheaper. */
      readonly verdict: "suspected-recoverable";
      readonly matchedInstructionRef: string;
      readonly matchedState: InstructionState;
      readonly overrideAvailable: true;
    }
  | {
      /** The single most important rule in the method: a match in ANY
       * indeterminate state blocks with NO override until it resolves. */
      readonly verdict: "suspected-blocking";
      readonly matchedInstructionRef: string;
      readonly matchedState: InstructionState;
      readonly overrideAvailable: false;
    };

export function assessDuplication(
  candidate: InstructionFacts,
  windowInstructions: readonly { instructionRef: string; facts: InstructionFacts; state: InstructionState }[],
): { readonly assessment: DuplicationAssessment; readonly methodRef: MethodRef } {
  const M = PAYMENTS_METHODS.duplication;
  const candidateKey = fingerprint(candidate).key;
  for (const other of windowInstructions) {
    const otherPrint = fingerprint(other.facts);
    if (otherPrint.key === candidateKey) {
      if (TERMINAL_FAILED.has(other.state)) {
        return {
          assessment: {
            verdict: "suspected-recoverable",
            matchedInstructionRef: other.instructionRef,
            matchedState: other.state,
            overrideAvailable: true,
          },
          methodRef: M,
        };
      }
      return {
        assessment: {
          verdict: "suspected-blocking",
          matchedInstructionRef: other.instructionRef,
          matchedState: other.state,
          overrideAvailable: false,
        },
        methodRef: M,
      };
    }
    // Near match: all fields equal except obligationRefs, or except the date.
    const c = fingerprint(candidate).fields;
    const o = otherPrint.fields;
    const differing = c.map((f, i) => (f === o[i] ? null : i)).filter((i): i is number => i !== null);
    if (differing.length === 1 && differing[0] === 7) {
      return {
        assessment: { verdict: "near", matchedInstructionRef: other.instructionRef, differingField: "obligationRefs", blocking: false },
        methodRef: M,
      };
    }
    if (differing.length === 1 && differing[0] === 6) {
      return {
        assessment: { verdict: "near", matchedInstructionRef: other.instructionRef, differingField: "requestedExecutionDate", blocking: false },
        methodRef: M,
      };
    }
  }
  return { assessment: { verdict: "clear" }, methodRef: M };
}

// ── §16.3 · scheme status mapping: unmapped goes to review ──────────────────

export interface StatusMapTable {
  readonly codeSetVersion: string;
  readonly entries: Readonly<Record<string, string>>; // scheme code → neutral state
}

export type StatusMapOutcome =
  | { readonly mapped: true; readonly neutralState: string; readonly codeSetVersion: string }
  | {
      /** Not a default state, not a best guess: the payment stays where it
       * is and an exception is raised. A mapping that silently defaults is a
       * false validator. */
      readonly mapped: false;
      readonly outcome: "unmapped-scheme-status";
      readonly schemeCode: string;
      readonly codeSetVersion: string;
      readonly disposition: "review-required";
    };

export function mapSchemeStatus(table: StatusMapTable, schemeCode: string): StatusMapOutcome {
  const neutral = table.entries[schemeCode];
  if (neutral === undefined) {
    return {
      mapped: false,
      outcome: "unmapped-scheme-status",
      schemeCode,
      codeSetVersion: table.codeSetVersion,
      disposition: "review-required",
    };
  }
  return { mapped: true, neutralState: neutral, codeSetVersion: table.codeSetVersion };
}

// ── §16.4 · risk classification: deterministic ladder, recorded basis ───────

export type RiskClass = "routine" | "elevated" | "high" | "critical";
const LADDER: readonly RiskClass[] = ["routine", "elevated", "high", "critical"];

export interface RiskInputs {
  readonly amountMinor: bigint;
  /** Versioned tenant bands, ascending thresholds mapping to base classes.
   * NO DEFAULT: a default amount band is the quiet way an engine decides
   * $500,000 is routine. */
  readonly tenantBands: readonly { upToMinor: bigint | null; base: RiskClass }[] | undefined;
  readonly railFinality: "irrevocable-on-settlement" | "recallable";
  readonly payeeVerification: "match" | "close-match" | "no-match" | "unknown";
  readonly firstPaymentToPayeeAccount: boolean;
  readonly crossBorderOrCrossCurrency: boolean;
  readonly screeningVerdictKnown: boolean;
  readonly memberOfAuthorizedRun: boolean;
}

export interface RiskClassification {
  readonly riskClass: RiskClass;
  /** Every applied escalation with its rule id, so L4 can print WHY. */
  readonly riskClassBasis: readonly string[];
  readonly methodRef: MethodRef;
}

export function classifyRisk(inputs: RiskInputs): Result<RiskClassification> {
  const M = PAYMENTS_METHODS.riskClass;
  if (inputs.tenantBands === undefined || inputs.tenantBands.length === 0) {
    return refuse("risk_bands_unconfigured", M, "No tenant amount bands configured; a refusal, not a default band.");
  }
  const band =
    inputs.tenantBands.find((b) => b.upToMinor === null || inputs.amountMinor <= b.upToMinor) ??
    inputs.tenantBands[inputs.tenantBands.length - 1]!;
  let level = LADDER.indexOf(band.base);
  const basis: string[] = [`band:${band.base}`];
  const escalate = (ruleId: string): void => {
    if (level < LADDER.length - 1) level += 1;
    basis.push(ruleId);
  };
  if (inputs.railFinality === "irrevocable-on-settlement") escalate("rail-irrevocable");
  if (inputs.payeeVerification === "unknown" || inputs.payeeVerification === "no-match") escalate("payee-unverified");
  if (inputs.payeeVerification === "close-match") escalate("payee-close-match");
  if (inputs.firstPaymentToPayeeAccount) escalate("first-payment-to-account");
  if (inputs.crossBorderOrCrossCurrency) escalate("cross-border-or-currency");
  if (!inputs.screeningVerdictKnown && level < LADDER.indexOf("high")) {
    level = LADDER.indexOf("high");
    basis.push("screening-unknown-floor-high");
  }
  if (!inputs.memberOfAuthorizedRun) escalate("outside-authorized-run");
  return ok({ riskClass: LADDER[level]!, riskClassBasis: basis, methodRef: M });
}

// ── §16.6 · settlement reconciliation tri-state ─────────────────────────────

export interface SettleReconInputs {
  readonly instructedMinor: bigint;
  readonly settledMinor: bigint;
  readonly ourChargesMinor: bigint;
  readonly fxDifferenceMinor: bigint;
  readonly toleranceMinor: bigint;
  readonly unattributedChargeCandidateMinor: bigint | null;
}

export type ReconState = "reconciled" | "tentatively-reconciled" | "unreconciled";

export interface SettleRecon {
  readonly state: ReconState;
  readonly residualMinor: bigint;
  readonly exceptionRaised: boolean;
  readonly methodRef: MethodRef;
}

export function reconcileSettlement(inputs: SettleReconInputs): SettleRecon {
  const M = PAYMENTS_METHODS.settleRecon;
  const residual = inputs.instructedMinor - inputs.settledMinor - inputs.ourChargesMinor - inputs.fxDifferenceMinor;
  const abs = residual < 0n ? -residual : residual;
  if (abs <= inputs.toleranceMinor) {
    return { state: "reconciled", residualMinor: residual, exceptionRaised: false, methodRef: M };
  }
  if (inputs.unattributedChargeCandidateMinor !== null && residual === inputs.unattributedChargeCandidateMinor) {
    return { state: "tentatively-reconciled", residualMinor: residual, exceptionRaised: true, methodRef: M };
  }
  return { state: "unreconciled", residualMinor: residual, exceptionRaised: true, methodRef: M };
}

// ── §16.7 · run composition: a RECOMMEND with no release() ──────────────────

export interface PaymentCandidate {
  readonly candidateRef: string;
  readonly facts: InstructionFacts;
  readonly payByDate: string;
}

export interface PaymentRunProposal {
  readonly kind: "payment-run-proposal"; // RECOMMEND — carries no authority
  readonly groups: readonly {
    readonly groupKey: string;
    readonly memberRefs: readonly string[];
    readonly nettedAmountMinor: bigint;
    readonly obligationRefs: readonly string[];
  }[];
  readonly runCompositionFingerprint: string;
  readonly methodRef: MethodRef;
  // deliberately NO release() and no authority field
}

export function composeRun(
  candidates: readonly PaymentCandidate[],
  nettingPolicy: "net-within-group" | "no-netting" | undefined,
): Result<PaymentRunProposal> {
  const M = PAYMENTS_METHODS.runCompose;
  if (nettingPolicy === undefined) {
    return refuse("netting_policy_undeclared", M, "The tenant's netting policy is a required input, not a house choice.");
  }
  const byGroup = new Map<string, PaymentCandidate[]>();
  for (const c of candidates) {
    const key = [c.facts.payeeTokenRef, c.facts.railId, c.facts.currencyCode, c.facts.requestedExecutionDate].join("|");
    const list = byGroup.get(key) ?? [];
    list.push(c);
    byGroup.set(key, list);
  }
  const groups = [...byGroup.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([groupKey, members]) => {
      const sorted = [...members].sort((a, b) => (a.candidateRef < b.candidateRef ? -1 : 1));
      if (nettingPolicy === "no-netting") {
        return sorted.map((m) => ({
          groupKey: `${groupKey}|${m.candidateRef}`,
          memberRefs: [m.candidateRef],
          nettedAmountMinor: m.facts.amountMinor,
          obligationRefs: m.facts.obligationRefs,
        }));
      }
      return [
        {
          groupKey,
          memberRefs: sorted.map((m) => m.candidateRef),
          nettedAmountMinor: sorted.reduce((a, m) => a + m.facts.amountMinor, 0n),
          obligationRefs: sorted.flatMap((m) => m.facts.obligationRefs),
        },
      ];
    });
  const printKey = groups.map((g) => `${g.groupKey}=${g.nettedAmountMinor}`).join(";");
  return ok({
    kind: "payment-run-proposal",
    groups,
    runCompositionFingerprint: `${printKey}#${nettingPolicy}`,
    methodRef: M,
  });
}
