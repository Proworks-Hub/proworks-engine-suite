// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { SenseDevice } from "./models.js";

// ─────────────────────────────────────────────────────────────────────────────
// Telling the physical world to do something.
//
// "I observed the light is on" and "turn the light on" are different kinds of
// statement and share no shape here. An observation is a fact that already
// happened and cannot fail; a command is a request that can be refused, can
// half-succeed, and can hurt somebody.
//
// SenseIQ produces an INTENT. It does not switch anything. The engine stays a
// pure library — it authorizes, records and hands the intent to a host-side
// adapter, which is the only thing that touches hardware. That keeps SenseIQ
// portable in the same way the other eight engines are, and it means a
// compromised copy of this package cannot turn anything on.
//
// SAFETY IS PART OF THE MODEL, not a policy layered on later. A high-risk
// device refuses remote activation by default, and the default is the one that
// applies when nobody has thought about it — which is exactly when it matters.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How much harm an unexpected activation could do.
 *
 * The classification is about CONSEQUENCE, not about how clever the device is.
 * A dumb contactor feeding a table saw is high risk; an expensive display is
 * low.
 */
export const safetyClassSchema = z.enum([
  /** A display, a lamp, a non-critical plug. */
  "low",
  /** Ventilation, heaters, compressors — wrong state is costly, not dangerous. */
  "elevated",
  /** Machinery that can injure. Lasers, CNC, motors, anything with a blade. */
  "high",
]);
export type SafetyClass = z.infer<typeof safetyClassSchema>;

export const controlPolicySchema = z
  .object({
    safetyClass: safetyClassSchema,
    /**
     * Whether this device may be switched remotely at all.
     *
     * Defaults FALSE. A device nobody has configured cannot be commanded, which
     * is the correct behaviour for the case where somebody discovered a plug
     * and never looked at it again.
     */
    remoteControlAllowed: z.boolean().default(false),
    /** Whether a routine may act on it without a person present. */
    automationAllowed: z.boolean().default(false),
    /** Who may command it. Empty means nobody. */
    allowedRoles: z.array(z.string()).default([]),
    /** Who decided this, so a permissive policy has an author. */
    setBy: z.string().min(1).optional(),
    setAt: z.string().optional(),
  })
  .strict()
  .refine(
    (policy) => policy.safetyClass !== "high" || !policy.automationAllowed || Boolean(policy.setBy),
    {
      // Automating dangerous equipment is allowed to be possible, but never
      // anonymous. Somebody's name is on it.
      message: "Automating a high-risk device requires a named person to have authorized it.",
      path: ["setBy"],
    },
  );
export type ControlPolicy = z.infer<typeof controlPolicySchema>;

/** The safe default for a device nobody has configured. */
export function defaultPolicyFor(safetyClass: SafetyClass): ControlPolicy {
  return controlPolicySchema.parse({
    safetyClass,
    // Everything off. A discovered device is observable and inert until
    // somebody deliberately grants control.
    remoteControlAllowed: false,
    automationAllowed: false,
    allowedRoles: [],
  });
}

export const commandIntentSchema = z
  .object({
    commandId: z.string().min(1),
    deviceId: z.string().min(1),
    /** The capability being exercised, e.g. `power.switch`. */
    capability: z.string().min(1),
    action: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()).default({}),

    /** Who or what asked. `routine:<id>` for automation, a person otherwise. */
    requestedBy: z.string().min(1),
    /** Present when a routine issued it, so execution history can explain itself. */
    routineId: z.string().min(1).optional(),
    requestedAt: z.string().min(1),
    correlationId: z.string().min(1),

    /**
     * Stable key for one logical request.
     *
     * A retried command must not switch something twice. Physical actions are
     * not idempotent by nature — "toggle" applied twice is a no-op that looks
     * like success — so the key is required rather than optional.
     */
    idempotencyKey: z.string().min(1),
  })
  .strict();
export type CommandIntent = z.infer<typeof commandIntentSchema>;

export type CommandRefusal =
  | "no_such_capability"
  | "remote_control_disabled"
  | "role_not_permitted"
  | "automation_not_permitted"
  | "device_offline"
  | "high_risk_activation";

export interface CommandAuthorization {
  readonly allowed: boolean;
  readonly refusal?: CommandRefusal;
  /** Why, in words a person can act on. */
  readonly reason: string;
}

export interface AuthorizeCommandInput {
  intent: CommandIntent;
  device: SenseDevice;
  policy: ControlPolicy;
  /** Roles the requester holds, resolved by the host. */
  roles: readonly string[];
  /** True when a routine issued this rather than a person. */
  automated: boolean;
}

/**
 * Decides whether a command may be sent to a device.
 *
 * Ordered so the most serious refusal wins: somebody reading "role not
 * permitted" on a laser would go and get a role, and the answer they need is
 * that this device is not remotely operable at all.
 */
export function authorizeCommand(input: AuthorizeCommandInput): CommandAuthorization {
  const { intent, device, policy } = input;

  if (!device.capabilities.includes(intent.capability)) {
    return {
      allowed: false,
      refusal: "no_such_capability",
      reason: `This device does not report ${intent.capability}.`,
    };
  }

  // Before anything else. A high-risk device is not made safe by a permissive
  // role list, and this is the refusal that must not be reachable around.
  if (policy.safetyClass === "high" && !policy.remoteControlAllowed) {
    return {
      allowed: false,
      refusal: "high_risk_activation",
      reason:
        "This device is classified high risk and has no explicit remote-control authorization. Equipment that can injure somebody is not switched from a screen by default.",
    };
  }

  if (!policy.remoteControlAllowed) {
    return {
      allowed: false,
      refusal: "remote_control_disabled",
      reason: "Remote control has not been enabled for this device.",
    };
  }

  if (input.automated && !policy.automationAllowed) {
    return {
      allowed: false,
      refusal: "automation_not_permitted",
      reason:
        "A person may operate this device, but a routine may not. Learning a pattern does not grant permission to act on it.",
    };
  }

  if (policy.allowedRoles.length > 0 && !input.roles.some((role) => policy.allowedRoles.includes(role))) {
    return {
      allowed: false,
      refusal: "role_not_permitted",
      reason: "The requester does not hold a role permitted to operate this device.",
    };
  }

  // Last, because it is the only refusal that may resolve on its own — and
  // reporting it above the safety checks would tell somebody a laser was
  // merely unreachable.
  if (device.health.availability !== "online") {
    return {
      allowed: false,
      refusal: "device_offline",
      reason: `The device is ${device.health.availability}: ${device.health.detail}`,
    };
  }

  return { allowed: true, reason: "Permitted." };
}

export const commandResultSchema = z
  .object({
    commandId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    outcome: z.enum(["succeeded", "failed", "refused", "duplicate"]),
    completedAt: z.string().min(1),
    /** Required for anything that is not a success. */
    detail: z.string().min(1).optional(),
    /** What the device reported afterwards, when it says. Never assumed. */
    resultingState: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((result) => result.outcome === "succeeded" || Boolean(result.detail), {
    // A failure with no reason is a failure nobody can act on.
    message: "A command that did not succeed must say why.",
    path: ["detail"],
  });
export type CommandResult = z.infer<typeof commandResultSchema>;

/**
 * Recognises a command already carried out.
 *
 * The reason `idempotencyKey` is required. A retry after a timeout is the
 * normal case — the first attempt may well have worked — and re-sending it
 * would switch something a second time.
 */
export function findDuplicate(
  intent: CommandIntent,
  history: readonly CommandResult[],
): CommandResult | undefined {
  return history.find(
    (result) => result.idempotencyKey === intent.idempotencyKey && result.outcome !== "failed",
  );
}
