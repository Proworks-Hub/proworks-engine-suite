// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  assertTrackingSafeFor,
  type TrackingAudience,
} from "@proworks-hub/contracts";

import {
  dedupeKeyFor,
  type NotificationChannel,
  type NotificationDecision,
  type NotificationKind,
  type NotificationPreference,
  type PendingNotification,
  type Recipient,
} from "./models.js";
import {
  COALESCE_WINDOW_MINUTES,
  KIND_CHANNELS,
  KIND_URGENCY,
  SUPPRESSION_WINDOW_MINUTES,
  isQuietHour,
  localHour,
  nextQuietEnd,
} from "./policy.js";

// ─────────────────────────────────────────────────────────────────────────────
// The notification service.
//
// It DECIDES and RECORDS. It does not send — the same division as InventoryIQ,
// for the same reason: sending is I/O a pure package cannot make transactional
// or retryable, and a service that both decides and sends cannot be tested for
// what it decides without stubbing a mail server.
//
// The order of the checks below is the design. Muting is checked before
// everything, so nothing can talk its way past it. Suppression is checked
// before coalescing, because an already-sent notification cannot be merged
// into. Quiet hours are applied last, because they change WHEN, not WHETHER.
// ─────────────────────────────────────────────────────────────────────────────

export interface NotificationStore {
  /** Pending, not yet released. */
  pendingByKey(organizationId: string, dedupeKey: string): Promise<PendingNotification | null>;
  /** When this dedupe key was last released, for suppression. */
  lastSentAt(organizationId: string, dedupeKey: string): Promise<string | null>;
  save(notification: PendingNotification): Promise<void>;
  markSent(organizationId: string, notificationId: string, at: string): Promise<void>;
  /** Everything due at or before `at`. */
  due(organizationId: string, at: string): Promise<PendingNotification[]>;
}

export interface PreferenceStore {
  get(organizationId: string, recipientId: string): Promise<NotificationPreference | null>;
}

export interface NotifyInput {
  readonly recipient: Recipient;
  readonly kind: NotificationKind;
  readonly subjectRef: string;
  readonly title: string;
  readonly body: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface NotificationServiceDeps {
  readonly notifications: NotificationStore;
  readonly preferences: PreferenceStore;
  readonly now?: () => Date;
  readonly generateId?: () => string;
  /**
   * Default channels for a recipient with no stored preference.
   *
   * Deliberately narrow. A recipient nobody has configured should not receive
   * an SMS because a default was generous.
   */
  readonly defaultChannels?: ReadonlyArray<NotificationChannel>;
}

export interface NotificationService {
  notify(input: NotifyInput): Promise<NotificationDecision>;
  /** Notifications now due, for a host to send. */
  drain(organizationId: string): Promise<PendingNotification[]>;
  markSent(organizationId: string, notificationId: string): Promise<void>;
}

export function createNotificationService(
  deps: NotificationServiceDeps,
): NotificationService {
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? defaultId;
  const defaultChannels = deps.defaultChannels ?? (["in_app"] as const);

  return {
    async notify(input) {
      const { recipient, kind, subjectRef } = input;
      const preference = await deps.preferences.get(
        recipient.organizationId,
        recipient.recipientId,
      );

      // 1. Muting, first and unconditionally. Nothing below can override it.
      if (preference?.mutedKinds.includes(kind)) {
        return { outcome: "muted", reason: `${recipient.recipientId} muted ${kind}` };
      }

      // 2. A channel that can actually carry it.
      const allowed = KIND_CHANNELS[kind];
      const available = preference?.channels ?? [...defaultChannels];
      const channels = available.filter((c) => allowed.includes(c));
      if (channels.length === 0) {
        return {
          outcome: "no_channel",
          reason: `${kind} allows ${allowed.join("/")}; recipient has ${available.join("/") || "none"}`,
        };
      }

      const at = now();
      const dedupeKey = dedupeKeyFor(
        recipient.organizationId,
        recipient.recipientId,
        kind,
        subjectRef,
      );

      // 3. Already sent recently. An event replayed hours later must not text
      //    somebody a second time about a thing they were already told.
      const lastSent = await deps.notifications.lastSentAt(recipient.organizationId, dedupeKey);
      if (lastSent && minutesBetween(new Date(lastSent), at) < SUPPRESSION_WINDOW_MINUTES) {
        return { outcome: "duplicate", reason: `already sent at ${lastSent}` };
      }

      const urgency = KIND_URGENCY[kind];
      const data = input.data ?? {};

      // The audience discipline tracking uses, applied to message data. A
      // notification is just a tracking view with a delivery mechanism, and it
      // must not become the surface that leaks what the page hides.
      assertNotificationSafe(data, recipient.audience);

      // 4. Supersede a pending one for the same subject and kind. The failure
      //    this prevents: a milestone advances, an operator undoes it a minute
      //    later, and the customer has already been told.
      const pending = await deps.notifications.pendingByKey(
        recipient.organizationId,
        dedupeKey,
      );

      const releaseAt = computeReleaseAt(at, urgency, recipient, preference);

      const notification: PendingNotification = {
        // Reuses the pending id so a store keyed by id replaces rather than
        // accumulating a second row nobody will ever release.
        notificationId: pending?.notificationId ?? generateId(),
        organizationId: recipient.organizationId,
        recipientId: recipient.recipientId,
        kind,
        urgency,
        subjectRef,
        channels,
        title: input.title,
        body: input.body,
        data,
        createdAt: pending?.createdAt ?? at.toISOString(),
        // The original release time stands. A stream of corrections must not
        // push a notification indefinitely into the future.
        releaseAt: pending?.releaseAt ?? releaseAt.toISOString(),
        dedupeKey,
      };

      await deps.notifications.save(notification);
      return { outcome: pending ? "coalesced" : "queued", notification };
    },

    async drain(organizationId) {
      return deps.notifications.due(organizationId, now().toISOString());
    },

    async markSent(organizationId, notificationId) {
      await deps.notifications.markSent(organizationId, notificationId, now().toISOString());
    },
  };
}

/**
 * When a notification may go out.
 *
 * Coalescing delay first, then quiet hours — and urgent skips both, for staff.
 * A customer notification is never urgent enough to wake somebody, which is
 * why `urgent` has no customer-facing kinds in the policy table.
 */
function computeReleaseAt(
  at: Date,
  urgency: PendingNotification["urgency"],
  recipient: Recipient,
  preference: NotificationPreference | null,
): Date {
  if (urgency === "urgent") return at;

  const delayed = new Date(at.getTime() + COALESCE_WINDOW_MINUTES[urgency] * 60 * 1000);

  const quiet = preference?.quietHours;
  if (!quiet || !recipient.timeZone) return delayed;

  const hour = localHour(delayed, recipient.timeZone);
  // An unresolvable zone means quiet hours cannot be evaluated. Sending is the
  // safer failure: a held notification nobody releases is a notification lost.
  if (hour === undefined) return delayed;

  return isQuietHour(hour, quiet) ? nextQuietEnd(delayed, recipient.timeZone, quiet) : delayed;
}

/**
 * Refuses message data that carries more than the audience may see.
 *
 * Reuses the tracking guard rather than reimplementing the field list, so the
 * two surfaces cannot drift apart. A notification body assembled from an
 * internal projection is exactly how a station name reaches a customer.
 */
function assertNotificationSafe(
  data: Readonly<Record<string, unknown>>,
  audience: TrackingAudience,
): void {
  // Any `internal` block at all, not only on data that happens to look
  // tracking-shaped. Keying off the shape would mean a payload assembled
  // slightly differently sails past the one check standing between an internal
  // projection and a customer's inbox.
  if (data["internal"] === undefined && data["shipment"] === undefined) return;

  assertTrackingSafeFor(
    {
      ...(data as Record<string, unknown>),
      // The guard reads only these two keys; the rest is filled so a partial
      // payload cannot throw for the wrong reason and look like a leak.
      orderRef: typeof data["orderRef"] === "string" ? data["orderRef"] : "unknown",
      organizationId: "unknown",
      stage: "received",
      stageIndex: 0,
      percentComplete: 0,
      estimatedCompletionAt: null,
      confidence: "tentative",
      runningBehind: false,
      generatedAt: new Date(0).toISOString(),
    } as unknown as Parameters<typeof assertTrackingSafeFor>[0],
    audience,
  );
}

const minutesBetween = (a: Date, b: Date): number =>
  Math.abs(b.getTime() - a.getTime()) / 60000;

function defaultId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  return typeof g.crypto?.randomUUID === "function"
    ? `ntf_${g.crypto.randomUUID()}`
    : `ntf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
