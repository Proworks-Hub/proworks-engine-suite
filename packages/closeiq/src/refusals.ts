// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// Typed refusals — returned, never thrown for a domain reason. There is no
// force parameter, no override flag and no skipValidation option, at any
// level of the API; adding one is a stop-and-report condition, not a feature.

export const CLOSE_REFUSAL_KINDS = [
  "dag-invalid",
  "unreachable-task",
  "orphaned-evidence-requirement",
  "predecessors-unmet",
  "wrong-state",
  "evidence-unsatisfied",
  "not-a-human",
  "empty-reason",
  "not-permitted",
  "self-authorization",
  "replayed-authorization",
  "stale-fingerprint",
  "blocking-incomplete",
  "materiality-unbound",
  "unknown-currency-scale",
  "tier-unknown",
  "not-balanced",
  "candidate-stale",
  "store-unbound",
  "empty-statement",
] as const;

export type CloseRefusalKind = (typeof CLOSE_REFUSAL_KINDS)[number];

export interface CloseRefusal {
  readonly kind: CloseRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: CloseRefusal };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const refuse = <T = never>(
  kind: CloseRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });
