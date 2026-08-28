// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { authorizeCommand, type CommandIntent, type ControlPolicy } from "./command.js";
import type { SenseDevice } from "./models.js";

// ─────────────────────────────────────────────────────────────────────────────
// Routines: from noticing a pattern to being allowed to act on it.
//
//   OBSERVE → LEARN → RECOMMEND → ASK → AUTOMATE
//
// The arrows are one-way and the fourth one is a person. SenseIQ may notice
// that the lights go on at 7:30 every weekday; that observation grants it
// exactly no permission to turn them on. A routine reaches `active` only by
// somebody approving it, and the approver's name stays on it.
//
// The reason this is structural rather than a policy note: silent autonomous
// physical control is the failure that cannot be walked back. A wrong dashboard
// number is embarrassing. A machine that started on its own is an incident, and
// possibly an injury.
//
// Every execution is explainable — "Production lights turned on at 7:28 because
// Open Shop ran" — because an automated action nobody can account for is
// indistinguishable from a fault, and gets reported as one.
// ─────────────────────────────────────────────────────────────────────────────

export const routineStateSchema = z.enum([
  /** Noticed, not yet shown to anybody. */
  "observed",
  /** Shown to a person as a suggestion. */
  "recommended",
  /** A person said yes. Only now may it run. */
  "active",
  /** Temporarily stopped. Still exists, still visible. */
  "paused",
  /** A person said no. Kept so it is not suggested again. */
  "declined",
]);
export type RoutineState = z.infer<typeof routineStateSchema>;

export const routineStepSchema = z
  .object({
    deviceId: z.string().min(1),
    capability: z.string().min(1),
    action: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type RoutineStep = z.infer<typeof routineStepSchema>;

export const routineTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  /** Local time, e.g. "07:30", on the given weekdays (0 = Sunday). */
  z.object({ kind: z.literal("schedule"), atLocalTime: z.string().regex(/^\d{2}:\d{2}$/), weekdays: z.array(z.number().int().min(0).max(6)).min(1) }).strict(),
  z.object({ kind: z.literal("observation"), capability: z.string().min(1), deviceId: z.string().min(1) }).strict(),
]);
export type RoutineTrigger = z.infer<typeof routineTriggerSchema>;

export const routineSchema = z
  .object({
    routineId: z.string().min(1),
    name: z.string().min(1),
    state: routineStateSchema,
    trigger: routineTriggerSchema,
    steps: z.array(routineStepSchema).min(1),

    /** What was noticed. Shown when recommending, so the offer explains itself. */
    evidence: z.array(z.string()).default([]),
    observedCount: z.number().int().nonnegative().default(0),

    /** Who approved it. Absent unless the state is active or paused. */
    approvedBy: z.string().min(1).optional(),
    approvedAt: z.string().optional(),
    declinedBy: z.string().min(1).optional(),

    /**
     * Whether a person must confirm each run.
     *
     * Separate from approval: somebody may accept that a routine is a good idea
     * and still want to press the button themselves.
     */
    requiresConfirmation: z.boolean().default(false),
    createdAt: z.string().min(1),
  })
  .strict()
  .refine(
    (routine) => !(routine.state === "active" || routine.state === "paused") || Boolean(routine.approvedBy),
    {
      // The rule the whole file exists for, enforced by the parser: a routine
      // cannot be active without a named person having approved it.
      message: "A routine can only be active or paused if a named person approved it.",
      path: ["approvedBy"],
    },
  );
export type Routine = z.infer<typeof routineSchema>;

/** Enough repetitions before a pattern is worth mentioning to somebody. */
export const MIN_OBSERVATIONS_TO_RECOMMEND = 5;

export type RecommendationRefusal = "too_few_observations" | "already_decided";

export interface RecommendationResult {
  readonly ok: boolean;
  readonly routine?: Routine;
  readonly refusal?: RecommendationRefusal;
  readonly reason?: string;
}

/**
 * Offers an observed pattern to a person.
 *
 * Refuses on thin evidence. "I noticed you did this twice" is not a pattern,
 * and a system that suggests constantly is one whose suggestions get dismissed
 * without reading — which costs the good ones too.
 */
export function recommendRoutine(routine: Routine): RecommendationResult {
  if (routine.state === "declined") {
    return {
      ok: false,
      refusal: "already_decided",
      reason: "This was declined. Suggesting it again is how a helpful system becomes a nagging one.",
    };
  }

  if (routine.state !== "observed") {
    return { ok: false, refusal: "already_decided", reason: `This routine is already ${routine.state}.` };
  }

  if (routine.observedCount < MIN_OBSERVATIONS_TO_RECOMMEND) {
    return {
      ok: false,
      refusal: "too_few_observations",
      reason: `Seen ${routine.observedCount} time(s); ${MIN_OBSERVATIONS_TO_RECOMMEND} are needed before this is worth offering.`,
    };
  }

  return { ok: true, routine: routineSchema.parse({ ...routine, state: "recommended" }) };
}

/** A person accepts a recommendation. The only route to `active`. */
export function approveRoutine(
  routine: Routine,
  approvedBy: string,
  now: number,
  options: { requiresConfirmation?: boolean } = {},
): Routine {
  return routineSchema.parse({
    ...routine,
    state: "active",
    approvedBy,
    approvedAt: new Date(now).toISOString(),
    requiresConfirmation: options.requiresConfirmation ?? routine.requiresConfirmation,
  });
}

export function declineRoutine(routine: Routine, declinedBy: string): Routine {
  return routineSchema.parse({
    ...routine,
    state: "declined",
    declinedBy,
    // Approval is cleared: a declined routine that kept an approver's name
    // would read as though somebody had authorized it.
    approvedBy: undefined,
    approvedAt: undefined,
  });
}

export function pauseRoutine(routine: Routine): Routine {
  return routineSchema.parse({ ...routine, state: "paused" });
}

// ── Execution ────────────────────────────────────────────────────────────────

export interface RoutineExecutionPlan {
  readonly routineId: string;
  readonly intents: readonly CommandIntent[];
  /** Steps that were dropped, and why. Never silently skipped. */
  readonly refused: readonly { step: RoutineStep; reason: string }[];
  /** True when nothing may run at all. */
  readonly blocked: boolean;
  readonly reason: string;
}

export interface PlanExecutionInput {
  routine: Routine;
  devices: ReadonlyMap<string, SenseDevice>;
  policies: ReadonlyMap<string, ControlPolicy>;
  correlationId: string;
  now: number;
  /** Present when a person pressed the button rather than a schedule firing. */
  triggeredBy?: string;
}

/**
 * Turns a routine into command intents, dropping what it may not do.
 *
 * A routine is NOT all-or-nothing. Open Shop turning on four of five things and
 * saying which one it could not is far more useful than refusing entirely
 * because one plug is offline — that is the "shop ready with 2 items requiring
 * attention" behaviour, and it is why refusals are returned rather than thrown.
 */
export function planExecution(input: PlanExecutionInput): RoutineExecutionPlan {
  const { routine } = input;

  if (routine.state !== "active") {
    return {
      routineId: routine.routineId,
      intents: [],
      refused: [],
      blocked: true,
      reason: `The routine is ${routine.state}. Only an approved, active routine may run.`,
    };
  }

  if (routine.requiresConfirmation && !input.triggeredBy) {
    return {
      routineId: routine.routineId,
      intents: [],
      refused: [],
      blocked: true,
      reason: "This routine requires a person to confirm each run.",
    };
  }

  const intents: CommandIntent[] = [];
  const refused: { step: RoutineStep; reason: string }[] = [];

  for (const [index, step] of routine.steps.entries()) {
    const device = input.devices.get(step.deviceId);
    if (!device) {
      refused.push({ step, reason: "The device is not known to SenseIQ." });
      continue;
    }

    const policy = input.policies.get(step.deviceId);
    if (!policy) {
      // No policy means nobody has granted control. Treated as a refusal, not
      // as permission by omission.
      refused.push({ step, reason: "No control policy exists for this device." });
      continue;
    }

    const intent: CommandIntent = {
      commandId: `${routine.routineId}:${index}:${input.now}`,
      deviceId: step.deviceId,
      capability: step.capability,
      action: step.action,
      parameters: step.parameters,
      requestedBy: input.triggeredBy ?? `routine:${routine.routineId}`,
      routineId: routine.routineId,
      requestedAt: new Date(input.now).toISOString(),
      correlationId: input.correlationId,
      // Keyed on the routine, the step and the run, so a retried execution does
      // not switch anything twice while two genuine runs stay distinct.
      idempotencyKey: `${routine.routineId}:${index}:${input.correlationId}`,
    };

    const decision = authorizeCommand({
      intent,
      device,
      policy,
      roles: [],
      // A scheduled run is automated even when a person started it manually:
      // what matters is that a routine is acting, not who set it going.
      automated: true,
    });

    if (!decision.allowed) {
      refused.push({ step, reason: decision.reason });
      continue;
    }

    intents.push(intent);
  }

  return {
    routineId: routine.routineId,
    intents,
    refused,
    blocked: false,
    reason:
      refused.length === 0
        ? `${intents.length} step(s) authorized.`
        : `${intents.length} step(s) authorized, ${refused.length} refused.`,
  };
}

/**
 * Explains an action after the fact.
 *
 * "Production lights turned on at 7:28 because Open Shop ran." An automated
 * action nobody can account for is indistinguishable from a fault, and gets
 * reported as one.
 */
export function explainExecution(
  routine: Routine,
  intent: CommandIntent,
  deviceName: string,
): string {
  const at = new Date(intent.requestedAt).toLocaleTimeString();
  const cause = intent.requestedBy.startsWith("routine:")
    ? `${routine.name} ran`
    : `${intent.requestedBy} ran ${routine.name}`;
  return `${deviceName} — ${intent.action} at ${at} because ${cause}.`;
}
