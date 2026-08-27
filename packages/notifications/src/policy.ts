// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type {
  NotificationChannel,
  NotificationKind,
  NotificationUrgency,
  QuietHours,
} from "./models.js";

// ─────────────────────────────────────────────────────────────────────────────
// The rules, separated from the machinery that applies them.
//
// They are here rather than inline because they are the part somebody will
// want to change without touching anything else — and the part that has to be
// readable by a person deciding whether the shop is being annoying.
// ─────────────────────────────────────────────────────────────────────────────

export const KIND_URGENCY: Readonly<Record<NotificationKind, NotificationUrgency>> =
  Object.freeze({
    // The customer is waiting for these, or must act on them.
    "order.received": "transactional",
    "order.proof_ready": "transactional",
    "order.ready_for_pickup": "transactional",
    "order.shipped": "transactional",
    "order.cancelled": "transactional",
    // Nice to know.
    "order.in_production": "progress",
    "order.delivered": "progress",
    "order.delayed": "progress",
    // Something on the floor is going wrong now.
    "material.short": "urgent",
    "material.oversold": "urgent",
    "quality.failed": "urgent",
    "order.at_risk": "urgent",
    "reorder.suggested": "progress",
  });

/**
 * How long to hold a notification so a later one can replace it.
 *
 * NOT a throttle — a correction window. The failure it prevents is specific
 * and embarrassing: a milestone advances, an operator notices it was the wrong
 * work order and undoes it, and the customer has already been told their
 * order is ready. Holding progress notifications for a few minutes makes that
 * a non-event.
 *
 * Transactional kinds get a much shorter window because the recipient is
 * waiting, and urgent gets none at all — a material shortage that is corrected
 * a minute later still cost somebody a minute they should have had.
 */
export const COALESCE_WINDOW_MINUTES: Readonly<Record<NotificationUrgency, number>> =
  Object.freeze({
    progress: 5,
    transactional: 1,
    urgent: 0,
  });

/**
 * How long the same notification is treated as already handled.
 *
 * Longer than the coalescing window, and doing a different job: coalescing
 * merges notifications not yet sent, suppression stops a second one being
 * created after the first has gone out. An event replay hours later must not
 * text the customer again.
 */
export const SUPPRESSION_WINDOW_MINUTES = 720;

/** Channels a kind is allowed on, when the recipient has several. */
export const KIND_CHANNELS: Readonly<Record<NotificationKind, NotificationChannel[]>> =
  Object.freeze({
    "order.received": ["email", "in_app"],
    "order.proof_ready": ["email", "sms", "push", "in_app"],
    "order.in_production": ["in_app", "push"],
    "order.ready_for_pickup": ["email", "sms", "push", "in_app"],
    "order.shipped": ["email", "sms", "push", "in_app"],
    "order.delivered": ["email", "in_app"],
    // Deliberately not SMS. "Your order is late" by text, at scale, is how a
    // shop trains its customers to ignore its texts.
    "order.delayed": ["email", "in_app", "push"],
    "order.cancelled": ["email", "in_app"],
    "material.short": ["in_app", "push", "email"],
    "material.oversold": ["in_app", "push", "email"],
    "quality.failed": ["in_app", "push"],
    "order.at_risk": ["in_app", "push"],
    "reorder.suggested": ["in_app", "email"],
  });

/**
 * Whether a local hour falls inside quiet hours.
 *
 * Handles the overnight case, which is the normal one: 21 to 8 wraps midnight,
 * and a naive `hour >= start && hour < end` is false for every hour of it.
 */
export function isQuietHour(hour: number, quiet: QuietHours): boolean {
  if (quiet.startHour === quiet.endHour) return false;
  return quiet.startHour < quiet.endHour
    ? hour >= quiet.startHour && hour < quiet.endHour
    : hour >= quiet.startHour || hour < quiet.endHour;
}

/**
 * The local hour for a recipient, or `undefined` when it cannot be determined.
 *
 * Returning undefined rather than falling back to UTC is deliberate. A shop in
 * Denver whose quiet hours are silently evaluated in UTC gets notifications at
 * 5pm and silence at midnight — which looks like the feature working, so
 * nobody investigates.
 */
export function localHour(at: Date, timeZone: string | undefined): number | undefined {
  if (!timeZone) return undefined;
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
    }).format(at);
    const hour = Number.parseInt(formatted, 10);
    return Number.isFinite(hour) ? hour % 24 : undefined;
  } catch {
    // An unknown zone is a data problem, not a reason to guess.
    return undefined;
  }
}

/** The next moment quiet hours end, in the recipient's local terms. */
export function nextQuietEnd(at: Date, timeZone: string, quiet: QuietHours): Date {
  const hour = localHour(at, timeZone);
  if (hour === undefined) return at;

  let hoursAhead = quiet.endHour - hour;
  if (hoursAhead <= 0) hoursAhead += 24;

  const release = new Date(at.getTime() + hoursAhead * 60 * 60 * 1000);
  // Land on the hour rather than at whatever minute the event happened, so a
  // night's worth of held notifications do not arrive in a ragged trickle.
  release.setUTCMinutes(0, 0, 0);
  return release;
}
