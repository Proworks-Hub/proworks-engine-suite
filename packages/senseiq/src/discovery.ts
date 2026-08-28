// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { mergeDiscovered, type SenseDevice } from "./models.js";
import type { DeviceAdapter, DeviceStore } from "./ports.js";

// ─────────────────────────────────────────────────────────────────────────────
// Finding what is out there.
//
// "Discovery first, configuration second." Somebody setting up a shop should
// see "I found 12 devices" and be asked to confirm a handful of guesses — not
// be asked for an IP address, a Zigbee channel or an entity id.
//
// Phase A builds the mechanics that make that possible: run the adapters,
// reconcile against what is already known, and report what is new, what
// changed, and what has gone quiet. The confirmation experience is Phase B; the
// thing it needs from here is that rediscovery never destroys what a person
// already told us.
//
// ONE ADAPTER FAILING MUST NOT FAIL DISCOVERY. A bridge being down is normal,
// and losing every other device because of it would make the whole feature feel
// unreliable at exactly the moment somebody is deciding whether to trust it.
// ─────────────────────────────────────────────────────────────────────────────

export interface DiscoveryOutcome {
  /** Devices SenseIQ had never seen. */
  readonly discovered: readonly SenseDevice[];
  /** Devices already known, with fresh information merged in. */
  readonly updated: readonly SenseDevice[];
  /**
   * Known devices no adapter reported this time.
   *
   * NOT deleted, and not marked offline. An adapter that failed reports
   * nothing, and treating silence as absence would empty a shop map because a
   * bridge rebooted.
   */
  readonly unseen: readonly SenseDevice[];
  /** Adapters that threw, with the reason. Discovery still succeeded. */
  readonly adapterFailures: readonly { adapterId: string; reason: string }[];
}

export interface RunDiscoveryOptions {
  adapters: readonly DeviceAdapter[];
  store: DeviceStore;
  /** Persist the results. Off for a preview run. */
  persist?: boolean;
}

/**
 * Runs every adapter and reconciles the result against what is known.
 *
 * Deduplication is by `(adapterId, providerRef)` rather than by any property of
 * the device. Names change, capabilities are re-reported differently between
 * firmware versions, and a device that moved room is still the same device —
 * only the pair the adapter itself is stable about can identify it.
 */
export async function runDiscovery(options: RunDiscoveryOptions): Promise<DiscoveryOutcome> {
  const discovered: SenseDevice[] = [];
  const updated: SenseDevice[] = [];
  const adapterFailures: { adapterId: string; reason: string }[] = [];
  const seenIds = new Set<string>();

  // Sequential rather than parallel: adapters talk to hardware and a bridge
  // being hit by five concurrent scans is a bridge that starts timing out.
  for (const adapter of options.adapters) {
    if (!adapter.description.supportsDiscovery) continue;

    let found: readonly SenseDevice[];
    try {
      found = await adapter.discover();
    } catch (error) {
      adapterFailures.push({
        adapterId: adapter.description.adapterId,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const device of found) {
      const existing = await options.store.findByProviderRef(device.adapterId, device.providerRef);

      if (!existing) {
        discovered.push(device);
        seenIds.add(device.deviceId);
        if (options.persist) await options.store.save(device);
        continue;
      }

      // Merge protects a confirmed identity and an assigned location. A scan
      // must never overwrite what somebody told us.
      const merged = mergeDiscovered(existing, device);
      updated.push(merged);
      seenIds.add(merged.deviceId);
      if (options.persist) await options.store.save(merged);
    }
  }

  const known = await options.store.list();
  const unseen = known.filter((device) => !seenIds.has(device.deviceId));

  return { discovered, updated, unseen, adapterFailures };
}

/**
 * A plain-language summary of a discovery run.
 *
 * The first thing a person sees. Reports adapter failures explicitly, because
 * "found 4 devices" after a bridge failed is a true sentence that leaves
 * somebody wondering where the other eight went.
 */
export function describeDiscovery(outcome: DiscoveryOutcome): string {
  const parts: string[] = [];

  parts.push(
    outcome.discovered.length === 1
      ? "Found 1 new device."
      : `Found ${outcome.discovered.length} new devices.`,
  );

  if (outcome.updated.length > 0) {
    parts.push(`${outcome.updated.length} already known.`);
  }

  if (outcome.unseen.length > 0) {
    parts.push(
      `${outcome.unseen.length} known device(s) did not respond — they may be off, or their adapter may be unavailable.`,
    );
  }

  for (const failure of outcome.adapterFailures) {
    parts.push(`The ${failure.adapterId} adapter could not be reached: ${failure.reason}`);
  }

  return parts.join(" ");
}

/**
 * Devices that need a person to confirm something.
 *
 * The queue behind "I think this energy monitor belongs to the UV printer."
 * A device is here when SenseIQ has guessed at its identity and nobody has
 * agreed yet — or when it has no idea at all, which is equally worth saying.
 */
export function needsConfirmation(devices: readonly SenseDevice[]): SenseDevice[] {
  return devices.filter((device) => !device.identity.confirmedBy);
}
