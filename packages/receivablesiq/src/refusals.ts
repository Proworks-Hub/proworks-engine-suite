// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// The refusal catalogue — blueprint §19.5. NO refusal returns a value: no
// "zero for unknown", no empty aging for an unbound store, no default
// currency, no assumed scale. An empty aging and an unbound store are
// indistinguishable to a caller, and one of them is a disaster.
// ─────────────────────────────────────────────────────────────────────────────

export const RECEIVABLES_REFUSAL_KINDS = [
  "ambiguous-match",
  "no-candidate",
  "budget-exceeded",
  "unidentified-customer",
  "duplicate-intake",
  "duplicate-receipt",
  "unknown-currency-scale",
  "rate-port-unbound",
  "store-port-unbound",
  "policy-missing",
  "policy-invalid",
  "uniform-rate-not-accepted",
  "loss-rate-cell-missing",
  "authorization-required",
  "period-cutoff-open",
  "aging-identity-violation",
  "allocation-assertion-failed",
  "unsupported-manifest-version",
  "unknown-field-at-current-version",
] as const;

export type ReceivablesRefusalKind = (typeof RECEIVABLES_REFUSAL_KINDS)[number];

export interface ReceivablesRefusal {
  readonly kind: ReceivablesRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ReceivablesRefusal };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const refuse = <T = never>(
  kind: ReceivablesRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });
