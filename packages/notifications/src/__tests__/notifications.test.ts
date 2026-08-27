// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { beforeEach, describe, expect, it } from "vitest";

import { isQuietHour, nextQuietEnd } from "../policy.js";
import type { NotificationPreference, Recipient } from "../models.js";
import {
  createInMemoryNotificationStore,
  createInMemoryPreferenceStore,
  type InMemoryNotificationStore,
  type InMemoryPreferenceStore,
} from "../inMemory.js";
import { createNotificationService, type NotificationService } from "../service.js";

const customer: Recipient = {
  recipientId: "cust-1",
  organizationId: "org-a",
  audience: "customer",
  timeZone: "America/Denver",
};

const manager: Recipient = {
  recipientId: "mgr-1",
  organizationId: "org-a",
  audience: "manager",
  timeZone: "America/Denver",
};

const preference = (over: Partial<NotificationPreference> = {}): NotificationPreference => ({
  recipientId: "cust-1",
  organizationId: "org-a",
  channels: ["email", "sms", "push", "in_app"],
  mutedKinds: [],
  ...over,
});

describe("quiet hours arithmetic", () => {
  it("handles the overnight window, which is the normal one", () => {
    // 21 to 8 wraps midnight, and `hour >= start && hour < end` is false for
    // every hour of it — so the naive version is quiet exactly never.
    const overnight = { startHour: 21, endHour: 8 };
    expect(isQuietHour(23, overnight)).toBe(true);
    expect(isQuietHour(3, overnight)).toBe(true);
    expect(isQuietHour(7, overnight)).toBe(true);
    expect(isQuietHour(8, overnight)).toBe(false);
    expect(isQuietHour(14, overnight)).toBe(false);
  });

  it("handles a same-day window too", () => {
    const daytime = { startHour: 9, endHour: 17 };
    expect(isQuietHour(12, daytime)).toBe(true);
    expect(isQuietHour(20, daytime)).toBe(false);
  });

  it("treats an empty window as no quiet hours", () => {
    expect(isQuietHour(3, { startHour: 8, endHour: 8 })).toBe(false);
  });

  it("releases at the top of the hour rather than whenever the event happened", () => {
    // Otherwise a night's held notifications arrive in a ragged trickle at
    // whatever minutes things happened to occur.
    const release = nextQuietEnd(
      new Date("2026-08-27T05:37:00.000Z"),
      "UTC",
      { startHour: 21, endHour: 8 },
    );
    expect(release.toISOString()).toBe("2026-08-27T08:00:00.000Z");
  });
});

describe("deciding whether to tell somebody", () => {
  let notifications: InMemoryNotificationStore;
  let preferences: InMemoryPreferenceStore;
  let service: NotificationService;
  let clock: Date;
  let counter: number;

  const build = () =>
    createNotificationService({
      notifications,
      preferences,
      now: () => clock,
      generateId: () => `ntf_${++counter}`,
    });

  beforeEach(() => {
    counter = 0;
    // Mid-afternoon in Denver, comfortably outside any quiet hours.
    clock = new Date("2026-08-27T20:00:00.000Z");
    notifications = createInMemoryNotificationStore();
    preferences = createInMemoryPreferenceStore([preference()]);
    service = build();
  });

  const notify = (over: Partial<Parameters<NotificationService["notify"]>[0]> = {}) =>
    service.notify({
      recipient: customer,
      kind: "order.ready_for_pickup",
      subjectRef: "KSX-10284",
      title: "Your order is ready",
      body: "Come and get it.",
      ...over,
    });

  it("queues a notification the recipient can receive", async () => {
    const decision = await notify();

    expect(decision.outcome).toBe("queued");
    expect(decision.notification?.channels).toContain("sms");
  });

  it("refuses a muted kind, and nothing overrides that", async () => {
    // An opt-out that whoever is sending can override is not an opt-out, and
    // the one time it gets overridden is the time that matters legally.
    preferences.set(preference({ mutedKinds: ["order.ready_for_pickup"] }));

    expect((await notify()).outcome).toBe("muted");
    expect(notifications.all()).toHaveLength(0);
  });

  it("mutes only what was muted", async () => {
    preferences.set(preference({ mutedKinds: ["order.in_production"] }));
    expect((await notify()).outcome).toBe("queued");
  });

  it("declines when the recipient has no channel the kind allows", async () => {
    // "Your order is late" by SMS at scale is how a shop trains its customers
    // to ignore its texts, so that kind does not allow SMS at all.
    preferences.set(preference({ channels: ["sms"] }));

    const decision = await notify({ kind: "order.delayed" });
    expect(decision.outcome).toBe("no_channel");
  });

  it("gives an unconfigured recipient the narrow default, not the generous one", async () => {
    // Somebody nobody has set up should not get an SMS because a default was
    // written optimistically.
    preferences.clear();
    const decision = await notify();

    expect(decision.notification?.channels).toEqual(["in_app"]);
  });
});

describe("not telling somebody twice", () => {
  let notifications: InMemoryNotificationStore;
  let preferences: InMemoryPreferenceStore;
  let clock: Date;
  let counter: number;

  const service = () =>
    createNotificationService({
      notifications,
      preferences,
      now: () => clock,
      generateId: () => `ntf_${++counter}`,
    });

  beforeEach(() => {
    counter = 0;
    clock = new Date("2026-08-27T20:00:00.000Z");
    notifications = createInMemoryNotificationStore();
    preferences = createInMemoryPreferenceStore([preference()]);
  });

  const progress = () =>
    service().notify({
      recipient: customer,
      kind: "order.in_production",
      subjectRef: "KSX-10284",
      title: "We started your order",
      body: "In production now.",
    });

  it("merges a correction into the notification not yet sent", async () => {
    // The failure this prevents: a milestone advances, an operator notices it
    // was the wrong work order and undoes it, and the customer has already
    // been told. Holding progress a few minutes makes that a non-event.
    const first = await progress();
    const second = await progress();

    expect(first.outcome).toBe("queued");
    expect(second.outcome).toBe("coalesced");
    expect(notifications.all()).toHaveLength(1);
    expect(second.notification?.notificationId).toBe(first.notification?.notificationId);
  });

  it("does not let a stream of corrections push a notification into next week", async () => {
    const first = await progress();
    clock = new Date("2026-08-27T20:03:00.000Z");
    const second = await progress();

    // The original release time stands.
    expect(second.notification?.releaseAt).toBe(first.notification?.releaseAt);
  });

  it("refuses a replay hours after the first was sent", async () => {
    // An event replayed from a log must not text somebody a second time about
    // something they were already told.
    const first = await progress();
    if (!first.notification) throw new Error("setup failed");

    clock = new Date("2026-08-27T20:06:00.000Z");
    const due = await service().drain("org-a");
    expect(due).toHaveLength(1);
    await service().markSent("org-a", first.notification.notificationId);

    clock = new Date("2026-08-27T23:00:00.000Z");
    expect((await progress()).outcome).toBe("duplicate");
  });

  it("allows the same notification again once the window has passed", async () => {
    const first = await progress();
    if (!first.notification) throw new Error("setup failed");
    clock = new Date("2026-08-27T20:06:00.000Z");
    await service().markSent("org-a", first.notification.notificationId);

    // Well beyond the suppression window.
    clock = new Date("2026-08-29T20:00:00.000Z");
    expect((await progress()).outcome).toBe("queued");
  });

  it("keeps one organization's suppression out of another's", async () => {
    const first = await progress();
    if (!first.notification) throw new Error("setup failed");
    clock = new Date("2026-08-27T20:06:00.000Z");
    await service().markSent("org-a", first.notification.notificationId);

    preferences.set(preference({ organizationId: "org-b" }));
    const other = await service().notify({
      recipient: { ...customer, organizationId: "org-b" },
      kind: "order.in_production",
      subjectRef: "KSX-10284",
      title: "We started your order",
      body: "In production now.",
    });

    expect(other.outcome).toBe("queued");
  });
});

describe("when a notification is allowed to arrive", () => {
  let notifications: InMemoryNotificationStore;
  let preferences: InMemoryPreferenceStore;
  let clock: Date;

  const service = () =>
    createNotificationService({ notifications, preferences, now: () => clock });

  beforeEach(() => {
    notifications = createInMemoryNotificationStore();
    // 02:00 UTC is 20:00 the previous day in Denver — inside 21-08? No: 20:00
    // is just before. 06:00 UTC is midnight in Denver, squarely inside.
    clock = new Date("2026-08-28T06:00:00.000Z");
    preferences = createInMemoryPreferenceStore([
      preference({ quietHours: { startHour: 21, endHour: 8 } }),
    ]);
  });

  it("holds a progress notification until the shop's morning", async () => {
    const decision = await service().notify({
      recipient: customer,
      kind: "order.in_production",
      subjectRef: "KSX-1",
      title: "Started",
      body: "In production.",
    });

    // Held, never dropped. Being late is recoverable; being missing is not.
    expect(decision.outcome).toBe("queued");
    expect(new Date(decision.notification!.releaseAt).getTime()).toBeGreaterThan(
      clock.getTime(),
    );
    expect(await service().drain("org-a")).toHaveLength(0);
  });

  it("holds a transactional one too — nobody needs a pickup notice at midnight", async () => {
    const decision = await service().notify({
      recipient: customer,
      kind: "order.ready_for_pickup",
      subjectRef: "KSX-1",
      title: "Ready",
      body: "Come and get it.",
    });

    expect(new Date(decision.notification!.releaseAt).getTime()).toBeGreaterThan(
      clock.getTime(),
    );
  });

  it("wakes staff for something going wrong on the floor", async () => {
    // Urgent bypasses quiet hours, and only staff kinds are urgent — a
    // customer notification is never worth waking somebody for.
    preferences.set(
      preference({
        recipientId: "mgr-1",
        channels: ["push", "in_app"],
        quietHours: { startHour: 21, endHour: 8 },
      }),
    );

    const decision = await service().notify({
      recipient: manager,
      kind: "material.short",
      subjectRef: "mat-steel-18ga",
      title: "Out of 18ga steel",
      body: "Two jobs blocked.",
    });

    expect(decision.notification?.releaseAt).toBe(clock.toISOString());
    expect(await service().drain("org-a")).toHaveLength(1);
  });

  it("sends rather than holding when the recipient's zone cannot be resolved", async () => {
    // A held notification nobody releases is a notification lost, so an
    // unusable time zone fails towards delivery.
    const decision = await service().notify({
      recipient: { ...customer, timeZone: "Mars/Olympus_Mons" },
      kind: "order.in_production",
      subjectRef: "KSX-1",
      title: "Started",
      body: "In production.",
    });

    const delay =
      new Date(decision.notification!.releaseAt).getTime() - clock.getTime();
    // Only the coalescing window, not a quiet-hours hold.
    expect(delay).toBe(5 * 60 * 1000);
  });
});

describe("a notification cannot leak what a tracking page hides", () => {
  it("refuses tracking-shaped data carrying internal detail to a customer", async () => {
    // A body assembled from an internal projection is exactly how a station
    // name reaches a customer, so the tracking guard is reused rather than a
    // second field list being maintained here.
    const service = createNotificationService({
      notifications: createInMemoryNotificationStore(),
      preferences: createInMemoryPreferenceStore([preference()]),
      now: () => new Date("2026-08-27T20:00:00.000Z"),
    });

    await expect(
      service.notify({
        recipient: customer,
        kind: "order.in_production",
        subjectRef: "KSX-1",
        title: "Started",
        body: "In production.",
        data: {
          orderRef: "KSX-1",
          stage: "in_production",
          internal: { currentStation: "Laser #2" },
        },
      }),
    ).rejects.toThrow(/internal detail/);
  });

  it("catches an internal block on data that does not look tracking-shaped", async () => {
    // The hole in the first version of this check: it keyed off `stage` and
    // `orderRef` being present, so a payload assembled slightly differently
    // sailed past the one guard between an internal projection and an inbox.
    const service = createNotificationService({
      notifications: createInMemoryNotificationStore(),
      preferences: createInMemoryPreferenceStore([preference()]),
      now: () => new Date("2026-08-27T20:00:00.000Z"),
    });

    await expect(
      service.notify({
        recipient: customer,
        kind: "order.in_production",
        subjectRef: "KSX-1",
        title: "Started",
        body: "In production.",
        data: { internal: { assignedOperatorId: "op-14" } },
      }),
    ).rejects.toThrow(/internal detail/);
  });

  it("allows the same data to a manager", async () => {
    const service = createNotificationService({
      notifications: createInMemoryNotificationStore(),
      preferences: createInMemoryPreferenceStore([
        preference({ recipientId: "mgr-1", channels: ["in_app", "push"] }),
      ]),
      now: () => new Date("2026-08-27T20:00:00.000Z"),
    });

    const decision = await service.notify({
      recipient: manager,
      kind: "order.at_risk",
      subjectRef: "KSX-1",
      title: "Running late",
      body: "Blocked at laser.",
      data: {
        orderRef: "KSX-1",
        stage: "in_production",
        internal: { currentStation: "Laser #2" },
      },
    });

    expect(decision.outcome).toBe("queued");
  });
});
