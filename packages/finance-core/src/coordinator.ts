// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  coreRequest,
  createCoordinator,
  type CoreFailure,
  type CoreOutcome,
  type Coordinator,
} from "@proworks-hub/core-kit";
import type { RequestContext } from "@proworks-hub/contracts";

import type { FinanceCapability, FinanceRegistry, FinanceRequest } from "./registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// The finance coordinator.
//
// Now a thin parameterization of core-kit. Everything that was here — timeouts,
// typed refusals, no-silent-fallback, sequential askAll, three-state health —
// is unchanged in behaviour and shared with every other Core, which is the
// whole reason for extracting it. Eight Cores each with their own retry logic
// is how behaviour becomes Core-dependent.
//
// Finance has no ordering between its capabilities: a cost and a margin can be
// computed in either order. Operations does, which is why that Core adds a
// `sequence` method and this one does not.
// ─────────────────────────────────────────────────────────────────────────────

export type FinanceFailure = CoreFailure;
export type FinanceOutcome<TOutput = unknown> = CoreOutcome<FinanceCapability, TOutput>;
export type FinanceCoordinator = Coordinator<FinanceCapability>;

export interface CoordinatorOptions {
  registry: FinanceRegistry;
  timeoutMs?: number;
  allowFallback?: boolean;
  now?: () => number;
  onAttempt?: Parameters<typeof createCoordinator<FinanceCapability>>[0]["onAttempt"];
}

export function createFinanceCoordinator(options: CoordinatorOptions): FinanceCoordinator {
  return createCoordinator<FinanceCapability>({
    core: "finance",
    registry: options.registry,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.allowFallback === undefined ? {} : { allowFallback: options.allowFallback }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onAttempt === undefined ? {} : { onAttempt: options.onAttempt }),
  });
}

/** Unchanged signature, so existing hosts keep compiling. */
export function financeRequest<TInput>(input: {
  capability: FinanceCapability;
  input: TInput;
  context: RequestContext;
  correlationId: string;
  causationId?: string;
}): FinanceRequest<TInput> {
  return coreRequest(input);
}
