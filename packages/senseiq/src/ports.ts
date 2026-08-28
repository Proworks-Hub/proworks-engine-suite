// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { CommandIntent, CommandResult } from "./command.js";
import type { LocalObservation } from "./observation.js";
import type { SenseDevice } from "./models.js";

// ─────────────────────────────────────────────────────────────────────────────
// What SenseIQ asks of the world.
//
// Every protocol lives behind `DeviceAdapter`. Matter, MQTT, Zigbee, a
// manufacturer API, Home Assistant, future ProWorks hardware — each is one
// implementation of this interface, and SenseIQ cannot tell which it is
// holding.
//
// Home Assistant deserves naming explicitly because it is the tempting
// shortcut: it would give broad hardware support immediately, and depending on
// it would be invisible for a year. It is ONE ADAPTER. If it disappeared
// tomorrow this interface would be unchanged, and that property is worth more
// than the shortcut.
//
// Storage is a port too. Engines in this suite hold no state — the host owns
// the database and SenseIQ owns the shape of what goes in it. That is the
// reading of "each engine owns its domain memory" that keeps the engine
// portable: it owns the contracts and the logic, not the disk.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdapterDescription {
  readonly adapterId: string;
  /** Shown to a person choosing what to connect. */
  readonly name: string;
  /** What it can do. An adapter that cannot command says so here. */
  readonly supportsCommands: boolean;
  readonly supportsDiscovery: boolean;
}

/**
 * Something that can see and operate devices of one kind.
 *
 * Deliberately small. An adapter translates; it does not decide. Authorization,
 * safety, deduplication, identity and confidence are all SenseIQ's, so five
 * adapters cannot end up with five different opinions about whether a laser may
 * be switched on.
 */
export interface DeviceAdapter {
  readonly description: AdapterDescription;

  /**
   * Everything this adapter can currently see.
   *
   * Returns the full set each time rather than a delta. Deltas require the
   * adapter to track what it has already reported, which is state in the one
   * place least able to keep it — and a missed delta becomes a device that
   * silently disappears from a shop map.
   */
  discover(): Promise<readonly SenseDevice[]>;

  /**
   * Performs a command that SenseIQ has already authorized.
   *
   * Adapters MUST NOT re-decide authorization. If this is reachable the
   * decision was made; second-guessing it here is how a device becomes
   * operable through one adapter and not another.
   */
  execute?(intent: CommandIntent): Promise<CommandResult>;

  /** Pushes observations as they happen. Returns an unsubscribe. */
  subscribe?(onObservation: (observation: LocalObservation) => void): () => void;
}

/**
 * Where devices and spaces live between sessions.
 *
 * A port, so the engine stays pure. ProWorks binds Postgres, a Family Table
 * installation might bind IndexedDB, and a test binds the in-memory one.
 */
export interface DeviceStore {
  get(deviceId: string): Promise<SenseDevice | null>;
  list(): Promise<readonly SenseDevice[]>;
  save(device: SenseDevice): Promise<void>;
  /** By adapter and provider reference — how a rediscovery finds its existing row. */
  findByProviderRef(adapterId: string, providerRef: string): Promise<SenseDevice | null>;
}

/**
 * Where observations go.
 *
 * Takes LOCAL observations only. There is deliberately no method here that
 * accepts a generalized one: the path to shared knowledge runs through
 * `generalize()` and its refusals, and offering a second door would make that
 * boundary optional.
 */
export interface ObservationSink {
  record(observations: readonly LocalObservation[]): Promise<void>;
  /** For a window. Hosts implement whatever indexing they need. */
  query(filter: {
    deviceId?: string;
    kind?: string;
    since?: string;
    until?: string;
    limit?: number;
  }): Promise<readonly LocalObservation[]>;
}

/** Where command history lives, for idempotency and for explaining what happened. */
export interface CommandLog {
  record(intent: CommandIntent, result: CommandResult): Promise<void>;
  /** Recent results for one device, newest first. */
  recent(deviceId: string, limit?: number): Promise<readonly CommandResult[]>;
  findByIdempotencyKey(key: string): Promise<CommandResult | null>;
}

/** Everything a host must supply for SenseIQ to run. */
export interface SenseIqPorts {
  adapters: readonly DeviceAdapter[];
  devices: DeviceStore;
  observations: ObservationSink;
  commands: CommandLog;
  /** Injected so the engine has no ambient clock, like every other engine here. */
  now?: () => number;
}
