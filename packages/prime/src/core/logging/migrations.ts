/*
 * Copyright © 2026 Steven. All Rights Reserved.
 *
 * This file was created under the sole direction and vision of Steven.
 * All product decisions, business logic, workflows, and architecture
 * were defined by Steven. AI tools (Cursor, Perplexity, ChatGPT)
 * were used strictly as a coding assistant, similar to working with
 * a hired developer.
 *
 * Owner: Steven
 * Project: MakerOps / ProWorks Hub
 * Created: 2026
 */

/**
 * PRIME Engine — Event migrations registry
 *
 * Lightweight upgrade-on-read facility so the shape of a given event's payload
 * can evolve without rewriting the persisted log or forcing a coordinated
 * deploy. Projections (and other consumers) run every event through
 * `applyMigrations` before folding, so they always see the latest payload
 * shape.
 *
 * Spec: PRIME-PHASE-1-UPGRADE-SPEC.md §1.4 (schema evolution) and §6 (metrics
 * events catalog — future payload extensions).
 *
 * Design notes:
 * - Events already persisted carry no `schemaVersion`. Those are treated as
 *   v1 by default.
 * - A migration is a pure function `(payload, fromVersion) -> nextPayload`.
 *   It should be deterministic and side-effect free.
 * - Migrations are chained per event type; registering v1→v2 and v2→v3 is
 *   enough to migrate a v1 payload all the way to v3.
 * - `applyMigrations` never mutates the input event; it returns a new event
 *   object when any migration fires, and the input reference otherwise.
 * - The registry is intentionally small. It does NOT support forks, branching
 *   version graphs, or downgrading; that would invite accidents.
 */

import type { WorkOrderEvent, WorkOrderEventType } from "../../models/events.js";

/** Version numbers are plain positive integers. `1` is the implicit baseline. */
export type SchemaVersion = number;

/** A single v(N)→v(N+1) payload upgrader. */
export interface EventMigration<TIn = unknown, TOut = unknown> {
  readonly eventType: WorkOrderEventType;
  readonly fromVersion: SchemaVersion;
  readonly toVersion: SchemaVersion;
  migrate(payload: TIn): TOut;
}

/** Internal: read the payload's `schemaVersion` field, defaulting to 1. */
function readVersion(payload: unknown): SchemaVersion {
  if (payload && typeof payload === "object" && "schemaVersion" in payload) {
    const v = (payload as { schemaVersion?: unknown }).schemaVersion;
    if (typeof v === "number" && Number.isFinite(v) && v >= 1) {
      return Math.trunc(v);
    }
  }
  return 1;
}

/**
 * Registry for event-payload migrations. One registry per app/process is the
 * intended pattern; tests can instantiate isolated registries as needed.
 */
export class EventMigrationRegistry {
  // Map<eventType, Map<fromVersion, EventMigration>>
  private readonly byType = new Map<
    WorkOrderEventType,
    Map<SchemaVersion, EventMigration>
  >();

  /**
   * Register a migration. Throws if a migration for the same
   * (eventType, fromVersion) pair is already registered — this guards
   * against ambiguous upgrade paths.
   */
  register(migration: EventMigration): void {
    if (migration.toVersion !== migration.fromVersion + 1) {
      throw new Error(
        `EventMigrationRegistry.register: migrations must be single-step ` +
          `(got ${migration.fromVersion} -> ${migration.toVersion} for ` +
          `${migration.eventType})`
      );
    }
    let forType = this.byType.get(migration.eventType);
    if (!forType) {
      forType = new Map<SchemaVersion, EventMigration>();
      this.byType.set(migration.eventType, forType);
    }
    if (forType.has(migration.fromVersion)) {
      throw new Error(
        `EventMigrationRegistry.register: duplicate migration for ` +
          `${migration.eventType} from v${migration.fromVersion}`
      );
    }
    forType.set(migration.fromVersion, migration);
  }

  /**
   * Highest version reachable for a given event type via registered
   * migrations. Returns `1` for types with no migrations registered.
   */
  latestVersion(eventType: WorkOrderEventType): SchemaVersion {
    const forType = this.byType.get(eventType);
    if (!forType || forType.size === 0) {
      return 1;
    }
    // Latest is the max `toVersion` reachable by chaining from v1.
    let version = 1;
    for (;;) {
      const step = forType.get(version);
      if (!step) {
        return version;
      }
      version = step.toVersion;
    }
  }

  /**
   * Apply all registered migrations to `event` so its payload reaches the
   * latest version registered for its type. Returns the original reference
   * when no migration fires.
   */
  apply(event: WorkOrderEvent): WorkOrderEvent {
    const forType = this.byType.get(event.type);
    if (!forType || forType.size === 0) {
      return event;
    }

    let currentVersion = readVersion(event.payload);
    let payload: unknown = event.payload;
    let mutated = false;

    for (;;) {
      const step = forType.get(currentVersion);
      if (!step) {
        break;
      }
      payload = step.migrate(payload);
      currentVersion = step.toVersion;
      mutated = true;
    }

    if (!mutated) {
      return event;
    }

    // Stamp the new schemaVersion onto the payload so downstream consumers
    // (and re-runs) can see where it landed. We only stamp objects.
    let stampedPayload: unknown = payload;
    if (payload && typeof payload === "object") {
      stampedPayload = { ...(payload as object), schemaVersion: currentVersion };
    }

    return {
      ...event,
      payload: stampedPayload,
    };
  }
}

/**
 * Convenience: build a registry from a flat array of migrations. Equivalent
 * to `new EventMigrationRegistry()` + calling `register` in order.
 */
export function createEventMigrationRegistry(
  migrations: ReadonlyArray<EventMigration> = []
): EventMigrationRegistry {
  const registry = new EventMigrationRegistry();
  for (const m of migrations) {
    registry.register(m);
  }
  return registry;
}
