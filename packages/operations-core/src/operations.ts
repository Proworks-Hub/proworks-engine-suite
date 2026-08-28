// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import {
  coreRequest,
  createCoordinator,
  createSpecialistRegistry,
  type CoreAnswer,
  type CoreRefusal,
  type CoreRequest,
  type Coordinator,
  type Specialist,
  type SpecialistRegistry,
} from "@proworks-hub/core-kit";
import type { RequestContext } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Operations Core: what must happen, in what order.
//
// The machinery is core-kit's. What is specific to this domain is that its
// capabilities DEPEND ON EACH OTHER, which Finance's do not. A cost and a
// margin can be computed in any order; an order must be normalized before a
// work order can be created from it.
//
// That changes the failure model, and it is the reason this file exists rather
// than just a capability enum:
//
//   A SEQUENCE THAT FAILS PARTWAY HAS ALREADY CHANGED THE WORLD. Step one
//   created something. There is no rollback — a Core cannot un-create a work
//   order, and offering one would be a lie that costs somebody a duplicate.
//
// So a failed sequence reports exactly which steps completed and what they
// produced. "Order normalized, work order NOT created" is a state somebody can
// act on. "Sequence failed" is not.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the operations domain can be asked.
 *
 * Named for the question, never the engine. `create_work_order` survives
 * WorkOrderIQ being replaced.
 */
export const operationsCapabilitySchema = z.enum([
  "normalize_order",
  "create_work_order",
  "route_work_order",
  "advance_work_order",
  "locate_order",
  "schedule_work",
  "list_queue",
]);
export type OperationsCapability = z.infer<typeof operationsCapabilitySchema>;

export type OperationsSpecialist = Specialist<OperationsCapability>;
export type OperationsRegistry = SpecialistRegistry<OperationsCapability>;
export type OperationsRequest<TInput = unknown> = CoreRequest<OperationsCapability, TInput>;
export type OperationsAnswer<TOutput = unknown> = CoreAnswer<OperationsCapability, TOutput>;
export type OperationsRefusal = CoreRefusal<OperationsCapability>;

export function createOperationsRegistry(
  specialists: readonly OperationsSpecialist[] = [],
): OperationsRegistry {
  return createSpecialistRegistry(specialists);
}

// ── Sequences ────────────────────────────────────────────────────────────────

export interface SequenceStep {
  readonly capability: OperationsCapability;
  /**
   * Builds this step's input from what came before.
   *
   * A function rather than static data, because the whole point is that step
   * two consumes step one's output. Given the answers so far, keyed by
   * capability.
   */
  readonly input: (previous: Readonly<Record<string, unknown>>) => unknown;
  /**
   * Whether the sequence continues if this step is refused.
   *
   * Defaults to false. A step whose output the next one needs cannot be
   * optional, and defaulting to "carry on" would run step two against
   * undefined.
   */
  readonly optional?: boolean;
}

export interface SequenceOutcome {
  readonly completed: readonly OperationsAnswer[];
  readonly refusals: readonly OperationsRefusal[];
  /** Every step ran and succeeded. */
  readonly complete: boolean;
  /**
   * What the world looks like now, in words.
   *
   * The field that matters after a partial failure. It names what DID happen,
   * because that is the part somebody has to reconcile — and the part a bare
   * error would hide.
   */
  readonly state: string;
  /** True when a step failed after an earlier one had already had an effect. */
  readonly partiallyApplied: boolean;
}

export interface OperationsCoordinator extends Coordinator<OperationsCapability> {
  /**
   * Runs dependent steps in order, threading outputs forward.
   *
   * Stops at the first required refusal. Does not roll back, and says so.
   */
  sequence(input: {
    steps: readonly SequenceStep[];
    context: RequestContext;
    correlationId: string;
    causationId?: string;
  }): Promise<SequenceOutcome>;
}

export interface OperationsCoordinatorOptions {
  registry: OperationsRegistry;
  timeoutMs?: number;
  allowFallback?: boolean;
  now?: () => number;
  onAttempt?: Parameters<typeof createCoordinator<OperationsCapability>>[0]["onAttempt"];
}

export function createOperationsCoordinator(
  options: OperationsCoordinatorOptions,
): OperationsCoordinator {
  const base = createCoordinator<OperationsCapability>({
    core: "operations",
    registry: options.registry,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.allowFallback === undefined ? {} : { allowFallback: options.allowFallback }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onAttempt === undefined ? {} : { onAttempt: options.onAttempt }),
  });

  return {
    ...base,

    async sequence({ steps, context, correlationId, causationId }) {
      const completed: OperationsAnswer[] = [];
      const refusals: OperationsRefusal[] = [];
      const outputs: Record<string, unknown> = {};

      for (const step of steps) {
        const outcome = await base.ask(
          coreRequest({
            capability: step.capability,
            input: step.input(outputs),
            context,
            correlationId,
            // Each step is caused by the one before it. Without this a trace
            // shows five events at one instant with no order between them.
            ...(completed.length > 0
              ? { causationId: completed[completed.length - 1]!.capability }
              : causationId
                ? { causationId }
                : {}),
          }),
        );

        if (outcome.ok) {
          completed.push(outcome.answer);
          outputs[outcome.answer.capability] = outcome.answer.output;
          continue;
        }

        refusals.push(outcome.refusal);

        if (!step.optional) {
          // Stop. Running the next step would pass it `undefined` where it
          // expected the previous output, and it would fail somewhere less
          // legible than here.
          break;
        }
      }

      const partiallyApplied = completed.length > 0 && refusals.some((refusal) =>
        steps.find((step) => step.capability === refusal.capability)?.optional !== true,
      );

      return {
        completed,
        refusals,
        complete: refusals.length === 0,
        partiallyApplied,
        state: describeState(completed, refusals, partiallyApplied),
      };
    },
  };
}

/**
 * Says what actually happened, for somebody who has to reconcile it.
 *
 * Deliberately concrete. "2 of 3 steps completed" tells a person nothing they
 * can act on; naming the steps tells them exactly what exists and what does
 * not.
 */
function describeState(
  completed: readonly OperationsAnswer[],
  refusals: readonly OperationsRefusal[],
  partiallyApplied: boolean,
): string {
  if (refusals.length === 0) {
    return `All ${completed.length} step(s) completed.`;
  }

  if (completed.length === 0) {
    return `Nothing was done. ${refusals[0]!.reason}`;
  }

  const done = completed.map((answer) => answer.capability.replace(/_/g, " ")).join(", then ");
  const stopped = refusals[0]!;

  return (
    `${done} completed. Then ${stopped.capability.replace(/_/g, " ")} was refused: ${stopped.reason}` +
    (partiallyApplied
      ? " Nothing was undone — the earlier steps have already taken effect and need reconciling by hand."
      : "")
  );
}

/**
 * The order intake sequence, as a named thing rather than an ad-hoc array.
 *
 * Built here so the dependency between normalization and work-order creation
 * lives in the domain that owns it, instead of being reassembled by every host
 * that wants to take an order.
 */
export function orderIntakeSequence(externalOrder: unknown): SequenceStep[] {
  return [
    { capability: "normalize_order", input: () => externalOrder },
    {
      capability: "create_work_order",
      // Consumes the normalized order. This is the dependency the whole
      // sequence mechanism exists for.
      input: (previous) => previous["normalize_order"],
    },
    {
      capability: "route_work_order",
      input: (previous) => previous["create_work_order"],
      // Optional: an unrouted work order is a real, workable state — somebody
      // routes it by hand. Failing intake because routing is unavailable would
      // lose the order entirely, which is far worse.
      optional: true,
    },
  ];
}
