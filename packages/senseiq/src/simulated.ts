// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { commandResultSchema, type CommandIntent, type CommandResult } from "./command.js";
import type { LocalObservation } from "./observation.js";
import { senseDeviceSchema, type SenseDevice } from "./models.js";
import type { AdapterDescription, CommandLog, DeviceAdapter, DeviceStore, ObservationSink } from "./ports.js";

// ─────────────────────────────────────────────────────────────────────────────
// A simulated world, and the in-memory stores.
//
// The simulated adapter is what proves the ports are the right shape before any
// real protocol is written. It is also the thing that makes SenseIQ developable
// and testable without hardware — and per the wider directive, the substrate a
// synthetic shop eventually runs on.
//
// It is honest about what it is: `adapterId` is `simulated`, so a simulated
// device is identifiable everywhere it surfaces. Nothing here should ever be
// mistakable for a real reading, which is the same rule the AI stub adapter
// follows for the same reason.
// ─────────────────────────────────────────────────────────────────────────────

export interface SimulatedDeviceSpec {
  providerRef: string;
  capabilities: string[];
  identifiedAs?: string;
  manufacturer?: string;
  model?: string;
  online?: boolean;
  /** Fails every command, for exercising the failure path. */
  faulty?: boolean;
}

export interface SimulatedAdapterOptions {
  devices: readonly SimulatedDeviceSpec[];
  adapterId?: string;
  now?: () => number;
  /** Throws from `discover`, for exercising adapter failure. */
  discoveryFails?: boolean;
}

export function createSimulatedAdapter(options: SimulatedAdapterOptions): DeviceAdapter {
  const adapterId = options.adapterId ?? "simulated";
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<(observation: LocalObservation) => void>();

  const description: AdapterDescription = {
    adapterId,
    name: "Simulated devices",
    supportsCommands: true,
    supportsDiscovery: true,
  };

  const toDevice = (spec: SimulatedDeviceSpec): SenseDevice => {
    const at = new Date(now()).toISOString();
    return senseDeviceSchema.parse({
      // Derived from adapter and provider reference so rediscovery is stable —
      // a device that got a new id on every scan would duplicate endlessly.
      deviceId: `${adapterId}:${spec.providerRef}`,
      adapterId,
      providerRef: spec.providerRef,
      capabilities: spec.capabilities,
      identity: {
        ...(spec.identifiedAs
          ? {
              identifiedAs: spec.identifiedAs,
              // A simulated adapter is confident because it knows; a real one
              // would rarely be, and the field exists to carry that difference.
              confidence: { score: 0.9, basis: ["declared by the simulated adapter"] },
            }
          : {}),
        ...(spec.manufacturer ? { manufacturer: spec.manufacturer } : {}),
        ...(spec.model ? { model: spec.model } : {}),
      },
      health: {
        availability: spec.online === false ? "offline" : "online",
        detail: spec.online === false ? "Simulated as offline." : "Simulated device responding.",
        lastSeenAt: at,
      },
      metadata: { simulated: true },
      discoveredAt: at,
      updatedAt: at,
    });
  };

  return {
    description,

    async discover() {
      if (options.discoveryFails) {
        throw new Error("Simulated adapter failure during discovery.");
      }
      return options.devices.map(toDevice);
    },

    async execute(intent: CommandIntent): Promise<CommandResult> {
      const spec = options.devices.find(
        (candidate) => `${adapterId}:${candidate.providerRef}` === intent.deviceId,
      );

      if (!spec) {
        return commandResultSchema.parse({
          commandId: intent.commandId,
          idempotencyKey: intent.idempotencyKey,
          outcome: "failed",
          completedAt: new Date(now()).toISOString(),
          detail: "The adapter does not know this device.",
        });
      }

      if (spec.faulty) {
        return commandResultSchema.parse({
          commandId: intent.commandId,
          idempotencyKey: intent.idempotencyKey,
          outcome: "failed",
          completedAt: new Date(now()).toISOString(),
          detail: "The simulated device is faulty and rejected the command.",
        });
      }

      return commandResultSchema.parse({
        commandId: intent.commandId,
        idempotencyKey: intent.idempotencyKey,
        outcome: "succeeded",
        completedAt: new Date(now()).toISOString(),
        resultingState: { action: intent.action, ...intent.parameters },
      });
    },

    subscribe(onObservation) {
      listeners.add(onObservation);
      return () => listeners.delete(onObservation);
    },
  };
}

// ── In-memory stores ─────────────────────────────────────────────────────────

export function createInMemoryDeviceStore(seed: readonly SenseDevice[] = []): DeviceStore {
  const devices = new Map(seed.map((device) => [device.deviceId, device]));

  return {
    async get(deviceId) {
      return devices.get(deviceId) ?? null;
    },
    async list() {
      return [...devices.values()];
    },
    async save(device) {
      devices.set(device.deviceId, device);
    },
    async findByProviderRef(adapterId, providerRef) {
      return (
        [...devices.values()].find(
          (device) => device.adapterId === adapterId && device.providerRef === providerRef,
        ) ?? null
      );
    },
  };
}

export function createInMemoryObservationSink(): ObservationSink {
  const observations: LocalObservation[] = [];

  return {
    async record(incoming) {
      observations.push(...incoming);
    },
    async query(filter) {
      let out = observations;
      if (filter.deviceId) out = out.filter((entry) => entry.deviceId === filter.deviceId);
      if (filter.kind) out = out.filter((entry) => entry.kind === filter.kind);
      if (filter.since) out = out.filter((entry) => entry.observedAt >= filter.since!);
      if (filter.until) out = out.filter((entry) => entry.observedAt <= filter.until!);
      return filter.limit ? out.slice(-filter.limit) : out;
    },
  };
}

export function createInMemoryCommandLog(): CommandLog {
  const entries: { intent: CommandIntent; result: CommandResult }[] = [];

  return {
    async record(intent, result) {
      entries.push({ intent, result });
    },
    async recent(deviceId, limit = 20) {
      return entries
        .filter((entry) => entry.intent.deviceId === deviceId)
        .slice(-limit)
        .reverse()
        .map((entry) => entry.result);
    },
    async findByIdempotencyKey(key) {
      return entries.find((entry) => entry.result.idempotencyKey === key)?.result ?? null;
    },
  };
}
