// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Typed refusals — blueprint §19.3. Returned, never thrown. Every variant
// names what is missing. NEVER returned instead: zero, an empty array, a
// default, or a null a caller might read as "nothing owed".
// Unknown ≠ zero ≠ healthy.
// ─────────────────────────────────────────────────────────────────────────────

export const PAYABLES_REFUSAL_KINDS = [
  "missing-evidence",
  "missing-port",
  "missing-method-argument",
  "invariant-violated",
  "missing-quantity-evidence",
  "unratified-ownership",
  "terms-unresolved",
  "not-authorized",
  "currency-mismatch",
  "period-closed",
  "stale-result",
] as const;

export type PayablesRefusalKind = (typeof PAYABLES_REFUSAL_KINDS)[number];

export interface PayablesRefusal {
  readonly kind: PayablesRefusalKind;
  /** The versioned rule that refused. */
  readonly methodRef: MethodRef;
  /** What is missing or violated, named precisely. */
  readonly detail: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: PayablesRefusal };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const refuse = <T = never>(
  kind: PayablesRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });
