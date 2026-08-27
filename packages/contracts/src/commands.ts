// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { traceContextSchema } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// Commands — asking an engine to do something.
//
// A COMMAND IS NOT AN EVENT, and keeping them separate types is the point.
// An event is a fact: it already happened, it cannot be refused, and a
// consumer that dislikes it has no recourse. A command is a request: it names
// an intent, it can be rejected, and the rejection is a normal outcome rather
// than an error. Systems that blur the two end up with events that can fail
// and commands that cannot be declined, and neither is recoverable.
//
// WHY A BOUNDARY AT ALL, when a caller could invoke a use case directly.
//
// Because there is nowhere else to put the things that must be true of EVERY
// mutation: that the caller is entitled to it, that it names an organization,
// that it can be traced to what caused it, and that it is replayable. Ten use
// cases each checking those is ten places to forget. One door is one place.
//
// It also makes a mutation serializable, which is what lets an orchestrator
// send one across a queue instead of holding a reference to the engine.
// ─────────────────────────────────────────────────────────────────────────────

export const commandEnvelopeSchema = z
  .object({
    /**
     * Stable per intent, not per attempt. A retry after a timeout carries the
     * SAME id — that is what makes it a retry rather than a second order.
     */
    commandId: z.string().min(1),
    type: z.string().min(1),
    organizationId: z.string().min(1),
    issuedAt: z.string().datetime(),
    trace: traceContextSchema,
    payload: z.unknown(),
  })
  .strict();

export type CommandEnvelope<TType extends string = string, TPayload = unknown> = Omit<
  z.infer<typeof commandEnvelopeSchema>,
  "type" | "payload"
> & {
  readonly type: TType;
  readonly payload: TPayload;
};

/**
 * Why a command was refused.
 *
 * These are OUTCOMES, not exceptions. A caller that is not entitled to reroute
 * has not encountered a bug; it has been told no, and the difference matters
 * to whoever reads the logs at 2am.
 */
export const commandRefusalSchema = z.enum([
  /** The consumer does not hold the capability this command requires. */
  "not_entitled",
  /** No handler is wired for this command in this deployment. */
  "unsupported",
  /** The payload does not match what the command requires. */
  "invalid_payload",
  /** The command is valid but the target is in a state that forbids it. */
  "conflict",
  /** The target does not exist, or not for this organization. */
  "not_found",
]);
export type CommandRefusal = z.infer<typeof commandRefusalSchema>;

export interface CommandRejection {
  readonly ok: false;
  readonly refusal: CommandRefusal;
  readonly message: string;
  readonly details?: unknown;
}

export interface CommandAcceptance<TData> {
  readonly ok: true;
  readonly data: TData;
}

export type CommandResult<TData> = CommandAcceptance<TData> | CommandRejection;

export const rejectCommand = (
  refusal: CommandRefusal,
  message: string,
  details?: unknown,
): CommandRejection => ({ ok: false, refusal, message, ...(details ? { details } : {}) });

export const acceptCommand = <TData>(data: TData): CommandAcceptance<TData> => ({
  ok: true,
  data,
});

/** Validates an envelope, throwing with zod's detail. */
export function validateCommandEnvelope(input: unknown): CommandEnvelope {
  return commandEnvelopeSchema.parse(input) as CommandEnvelope;
}
