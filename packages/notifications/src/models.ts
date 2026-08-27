// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { trackingAudienceSchema } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Who gets told what.
//
// The hard part of notifications is not sending them. It is not sending them:
// not twice, not at 3am, not about something that gets corrected a minute
// later, and not to somebody who asked you to stop.
//
// Every type here exists to make one of those refusals possible.
// ─────────────────────────────────────────────────────────────────────────────

export const notificationChannelSchema = z.enum(["email", "sms", "push", "in_app", "webhook"]);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

/**
 * What kind of thing happened, from the reader's point of view.
 *
 * Named for what the recipient cares about, not for the event that triggered
 * it. `order.delayed` may come from an ETA drift, a blocked step or a failed
 * inspection — the customer's interest is identical in all three, and coupling
 * the notification to the cause would produce three near-identical messages.
 */
export const notificationKindSchema = z.enum([
  // Customer-facing.
  "order.received",
  "order.proof_ready",
  "order.in_production",
  "order.ready_for_pickup",
  "order.shipped",
  "order.delivered",
  "order.delayed",
  "order.cancelled",
  // Staff-facing.
  "material.short",
  "material.oversold",
  "quality.failed",
  "order.at_risk",
  "reorder.suggested",
]);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/**
 * How much a notification is allowed to interrupt.
 *
 *   progress      — nice to know. Coalesced, and held until quiet hours end.
 *   transactional — the recipient is waiting for it, or must act on it.
 *                   Held through quiet hours too: nobody needs a pickup
 *                   notice at 3am, and it is still there at 8.
 *   urgent        — something on the floor is going wrong now. Bypasses quiet
 *                   hours, for STAFF only. A customer notification is never
 *                   urgent enough to wake them.
 */
export const notificationUrgencySchema = z.enum(["progress", "transactional", "urgent"]);
export type NotificationUrgency = z.infer<typeof notificationUrgencySchema>;

export const recipientSchema = z
  .object({
    recipientId: z.string().min(1),
    organizationId: z.string().min(1),
    /**
     * Which redaction applies to anything this recipient is told. The same
     * discipline tracking uses, so a notification cannot leak what a tracking
     * page would have hidden.
     */
    audience: trackingAudienceSchema,
    /** IANA zone, for quiet hours. Absent means quiet hours cannot apply. */
    timeZone: z.string().optional(),
  })
  .strict();
export type Recipient = z.infer<typeof recipientSchema>;

export const quietHoursSchema = z
  .object({
    /** Local hour, 0–23, when quiet begins. */
    startHour: z.number().int().min(0).max(23),
    /** Local hour when it ends. May be less than start, meaning overnight. */
    endHour: z.number().int().min(0).max(23),
  })
  .strict();
export type QuietHours = z.infer<typeof quietHoursSchema>;

export const notificationPreferenceSchema = z
  .object({
    recipientId: z.string().min(1),
    organizationId: z.string().min(1),
    channels: z.array(notificationChannelSchema),
    /**
     * Kinds this recipient has opted out of.
     *
     * Absolute. Nothing in this package overrides it — not urgency, not a
     * caller flag. An opt-out that can be overridden by whoever is sending is
     * not an opt-out, and the one time it gets overridden is the time that
     * matters legally.
     */
    mutedKinds: z.array(notificationKindSchema).default([]),
    quietHours: quietHoursSchema.optional(),
  })
  .strict();
export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>;

/**
 * A notification that has been decided but not yet sent.
 *
 * `subjectRef` is what it is about — an order reference, a material id. It is
 * half of the coalescing key: two notifications of the same kind about the
 * same subject are the same notification, however many events produced them.
 */
export interface PendingNotification {
  readonly notificationId: string;
  readonly organizationId: string;
  readonly recipientId: string;
  readonly kind: NotificationKind;
  readonly urgency: NotificationUrgency;
  readonly subjectRef: string;
  readonly channels: ReadonlyArray<NotificationChannel>;
  readonly title: string;
  readonly body: string;
  /** Extra fields for a template. Already redacted for the audience. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  /**
   * Not before this time.
   *
   * Set by coalescing and by quiet hours. A notification is never dropped for
   * either reason — being late is recoverable, being missing is not.
   */
  readonly releaseAt: string;
  /**
   * Identity for suppression. Same key means same notification: a retry, a
   * replayed event, or a duplicate producer.
   */
  readonly dedupeKey: string;
}

export type NotificationOutcome =
  | "queued"
  /** Superseded a pending one for the same subject and kind. */
  | "coalesced"
  /** An identical notification was already handled inside the window. */
  | "duplicate"
  /** The recipient muted this kind. */
  | "muted"
  /** The recipient has no channel that can carry it. */
  | "no_channel";

export interface NotificationDecision {
  readonly outcome: NotificationOutcome;
  readonly notification?: PendingNotification;
  readonly reason?: string;
}

/** `${org}::${recipient}::${kind}::${subject}` — stable and greppable. */
export const dedupeKeyFor = (
  organizationId: string,
  recipientId: string,
  kind: NotificationKind,
  subjectRef: string,
): string => `${organizationId}::${recipientId}::${kind}::${subjectRef}`;
