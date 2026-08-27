// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { NotificationPreference, PendingNotification } from "./models.js";
import type { NotificationStore, PreferenceStore } from "./service.js";

// ─────────────────────────────────────────────────────────────────────────────
// In-memory stores, for tests and for a host that has not chosen a database.
//
// Every method narrows its port's return type to a plain Promise rather than
// the union the port permits — the standing rule here, because vitest strips
// types and a returned union passes tests while failing typecheck.
// ─────────────────────────────────────────────────────────────────────────────

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface InMemoryNotificationStore extends NotificationStore {
  all(): PendingNotification[];
  sent(): PendingNotification[];
  clear(): void;
}

export function createInMemoryNotificationStore(): InMemoryNotificationStore {
  const pending = new Map<string, PendingNotification>();
  const sentAt = new Map<string, string>();
  const sentList: PendingNotification[] = [];

  const scope = (organizationId: string, key: string): string => `${organizationId}::${key}`;

  return {
    async pendingByKey(organizationId, dedupeKey) {
      for (const notification of pending.values()) {
        if (
          notification.organizationId === organizationId &&
          notification.dedupeKey === dedupeKey
        ) {
          return clone(notification);
        }
      }
      return null;
    },

    async lastSentAt(organizationId, dedupeKey) {
      return sentAt.get(scope(organizationId, dedupeKey)) ?? null;
    },

    async save(notification) {
      // Keyed by id, so a coalesced notification replaces rather than adding a
      // second row that nobody will ever release.
      pending.set(notification.notificationId, clone(notification));
    },

    async markSent(organizationId, notificationId, at) {
      const notification = pending.get(notificationId);
      if (!notification || notification.organizationId !== organizationId) return;
      pending.delete(notificationId);
      sentAt.set(scope(organizationId, notification.dedupeKey), at);
      sentList.push(clone(notification));
    },

    async due(organizationId, at) {
      return [...pending.values()]
        .filter((n) => n.organizationId === organizationId && n.releaseAt <= at)
        .sort((a, b) => a.releaseAt.localeCompare(b.releaseAt))
        .map(clone);
    },

    all: () => [...pending.values()].map(clone),
    sent: () => sentList.map(clone),
    clear: () => {
      pending.clear();
      sentAt.clear();
      sentList.length = 0;
    },
  };
}

export interface InMemoryPreferenceStore extends PreferenceStore {
  set(preference: NotificationPreference): void;
  clear(): void;
}

export function createInMemoryPreferenceStore(
  initial: ReadonlyArray<NotificationPreference> = [],
): InMemoryPreferenceStore {
  const preferences = new Map<string, NotificationPreference>();
  const key = (organizationId: string, recipientId: string): string =>
    `${organizationId}::${recipientId}`;

  for (const preference of initial) {
    preferences.set(key(preference.organizationId, preference.recipientId), clone(preference));
  }

  return {
    async get(organizationId, recipientId) {
      const found = preferences.get(key(organizationId, recipientId));
      return found ? clone(found) : null;
    },
    set(preference) {
      preferences.set(key(preference.organizationId, preference.recipientId), clone(preference));
    },
    clear: () => preferences.clear(),
  };
}
