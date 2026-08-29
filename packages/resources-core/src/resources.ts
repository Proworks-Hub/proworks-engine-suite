// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import {
  coreRequest,
  createCoordinator,
  defaultAuthorityFor,
  createSpecialistRegistry,
  type CoreAnswer,
  type CoreFailure,
  type CoreOutcome,
  type CoreRefusal,
  type CoreRequest,
  type Coordinator,
  type Specialist,
  type SpecialistRegistry,
} from "@proworks-hub/core-kit";
import type { AuthorityEnvelope, Governance } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Resources Core: what an organization has.
//
// The machinery is core-kit's, same as Finance and Operations. What this Core
// adds is the one thing that makes its domain different from theirs:
//
//   A FINANCE ANSWER IS TIMELESS. A RESOURCES ANSWER IS NOT.
//
// Ask CostIQ what a job costs and the answer is as true in an hour as it was
// when given. Ask what is on hand and the answer began going stale the instant
// it was computed, because somebody else can reserve the last roll while the
// reply is still in flight.
//
// That difference is a real bug class, not a philosophical one: code that
// treats a check as a hold. "I checked, there were four, go ahead" — and by the
// time the job starts there are none, because checking never took them. Only
// reserving does.
//
// So every capability here is classified, every answer says which kind it was,
// and a reading is never reported as a guarantee.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the resources domain can be asked.
 *
 * Named for the question, not the engine. `check_availability` outlives
 * InventoryIQ; `inventoryiq_check` would couple every caller to an
 * implementation through a string.
 */
export const resourcesCapabilitySchema = z.enum([
  // Readings — true at a moment, and only at that moment.
  "check_availability",
  "detect_shortages",
  "detect_reorder_signals",
  "locate_asset",
  "forecast_capacity",

  // Commitments — they change what the organization has.
  "reserve_material",
  "release_reservation",
  "consume_material",
]);
export type ResourcesCapability = z.infer<typeof resourcesCapabilitySchema>;

/**
 * Whether an answer is a snapshot or a change.
 *
 * `reading` — true when observed, not a promise about the future. Acting on a
 * stale reading is the caller's risk, and the caller must be told it is one.
 *
 * `commitment` — the organization now holds, released, or consumed something.
 * It survives being read late, because it did not describe the world, it
 * changed it.
 */
export type AnswerKind = "reading" | "commitment";

const KIND: Readonly<Record<ResourcesCapability, AnswerKind>> = Object.freeze({
  check_availability: "reading",
  detect_shortages: "reading",
  detect_reorder_signals: "reading",
  locate_asset: "reading",
  forecast_capacity: "reading",
  reserve_material: "commitment",
  release_reservation: "commitment",
  consume_material: "commitment",
});

export function answerKind(capability: ResourcesCapability): AnswerKind {
  return KIND[capability];
}

/** True only for capabilities that actually make stock binding. */
export function isBinding(capability: ResourcesCapability): boolean {
  return KIND[capability] === "commitment";
}

export type ResourcesSpecialist = Specialist<ResourcesCapability>;
export type ResourcesRegistry = SpecialistRegistry<ResourcesCapability>;
export type ResourcesRequest<TInput = unknown> = CoreRequest<ResourcesCapability, TInput>;
export type ResourcesRefusal = CoreRefusal<ResourcesCapability>;
export type ResourcesFailure = CoreFailure;

/**
 * A resources answer, carrying the two facts a caller needs in order not to
 * mistake a snapshot for a promise.
 */
export interface ResourcesAnswer<TOutput = unknown>
  extends CoreAnswer<ResourcesCapability, TOutput> {
  readonly kind: AnswerKind;
  /** When the answer was true. ISO-8601. */
  readonly observedAt: string;
}

export type ResourcesOutcome<TOutput = unknown> =
  | { readonly ok: true; readonly answer: ResourcesAnswer<TOutput> }
  | { readonly ok: false; readonly refusal: ResourcesRefusal };

export function createResourcesRegistry(
  specialists: readonly ResourcesSpecialist[] = [],
): ResourcesRegistry {
  return createSpecialistRegistry(specialists);
}

export interface ResourcesCoordinatorOptions {
  registry: ResourcesRegistry;
  /**
   * REQUIRED. Decides whether the caller may use the capability, before the
   * registry is consulted. Pass `createDenyAllGovernance()` to deny explicitly;
   * there is no way to express "no governance" other than saying so.
   */
  governance: Governance;
  /** Defaults to `defaultAuthorityFor`. Supply one to state a real purpose. */
  authorityFor?: (request: CoreRequest<ResourcesCapability>) => AuthorityEnvelope;
  timeoutMs?: number;
  allowFallback?: boolean;
  now?: () => number;
  onAttempt?: Parameters<typeof createCoordinator<ResourcesCapability>>[0]["onAttempt"];
}

export interface ResourcesCoordinator
  extends Omit<Coordinator<ResourcesCapability>, "ask" | "askAll"> {
  ask<TOutput = unknown>(request: ResourcesRequest): Promise<ResourcesOutcome<TOutput>>;
  /** Everything that worked, beside everything that did not — same shape as
   *  every other Core, with each answer classified and stamped. */
  askAll(requests: readonly ResourcesRequest[]): Promise<{
    answers: ResourcesAnswer[];
    refusals: ResourcesRefusal[];
    complete: boolean;
  }>;
}

export function createResourcesCoordinator(
  options: ResourcesCoordinatorOptions,
): ResourcesCoordinator {
  const clock = options.now ?? Date.now;

  const inner = createCoordinator<ResourcesCapability>({
    core: "resources",
    registry: options.registry,
    governance: options.governance,
    authorityFor: options.authorityFor ?? defaultAuthorityFor,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.allowFallback === undefined ? {} : { allowFallback: options.allowFallback }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onAttempt === undefined ? {} : { onAttempt: options.onAttempt }),
  });

  const stamp = <TOutput>(
    outcome: CoreOutcome<ResourcesCapability, TOutput>,
  ): ResourcesOutcome<TOutput> =>
    outcome.ok
      ? {
          ok: true,
          answer: {
            ...outcome.answer,
            kind: answerKind(outcome.answer.capability),
            // Stamped here rather than by the specialist. A specialist that
            // reported its own observation time could report a stale reading as
            // fresh, and this is the field a caller uses to decide whether the
            // number is still worth trusting.
            observedAt: new Date(clock()).toISOString(),
          },
        }
      : { ok: false, refusal: outcome.refusal };

  return {
    ...inner,
    async ask<TOutput = unknown>(request: ResourcesRequest): Promise<ResourcesOutcome<TOutput>> {
      return stamp(await inner.ask<TOutput>(request));
    },
    async askAll(requests: readonly ResourcesRequest[]) {
      const result = await inner.askAll(requests);
      return {
        ...result,
        answers: result.answers.map((answer) => ({
          ...answer,
          kind: answerKind(answer.capability),
          observedAt: new Date(clock()).toISOString(),
        })),
      };
    },
  };
}

/** Unchanged signature, so hosts build requests the same way for every Core. */
export function resourcesRequest<TInput>(input: {
  capability: ResourcesCapability;
  input: TInput;
  context: Parameters<typeof coreRequest<ResourcesCapability, TInput>>[0]["context"];
  correlationId: string;
  causationId?: string;
}): ResourcesRequest<TInput> {
  return coreRequest(input);
}

/**
 * Whether a reading is too old to act on.
 *
 * There is no correct tolerance and this does not invent one — the caller
 * passes what its own decision can stand. What the function refuses to do is
 * treat a commitment as expiring: a reservation does not go stale, and asking
 * whether it has means the caller has confused a hold with a check. That is
 * exactly the confusion this Core exists to prevent, so it throws rather than
 * answering false and letting the misunderstanding continue.
 */
export function isStale(
  answer: ResourcesAnswer,
  toleranceMs: number,
  now: () => number = Date.now,
): boolean {
  if (answer.kind === "commitment") {
    throw new Error(
      `${answer.capability} is a commitment, not a reading. It does not go stale — ` +
        "asking whether it has suggests a hold is being treated as something that needs re-checking.",
    );
  }
  return now() - Date.parse(answer.observedAt) > toleranceMs;
}
