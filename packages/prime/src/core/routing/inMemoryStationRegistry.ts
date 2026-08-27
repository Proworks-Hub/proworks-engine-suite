// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

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
 * PRIME Engine — In-memory Station Registry adapter
 *
 * Reference implementation of the `StationRegistry` port. Safe for tests and
 * local dev. A real adapter will stitch together a stations table with
 * live telemetry (operator login, maintenance flags, queue depth).
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.3.
 *
 * Static eligibility rules applied here:
 *  - `station.workstationClass === query.workstationClass`
 *  - every tag in `query.requiredSkillTags` is present in `station.availableSkillTags`
 *  - `station.status` is NOT `down` or `maintenance`
 *
 * Dynamic pick (queue depth, manual override) is the routing use case's job,
 * not the registry's.
 */

import type {
  Station,
  StationEligibilityQuery,
  StationId,
  StationRegistry,
} from "./routingTypes.js";

export interface InMemoryStationRegistryOptions {
  readonly stations?: ReadonlyArray<Station>;
}

export function createInMemoryStationRegistry(
  options: InMemoryStationRegistryOptions = {}
): StationRegistry {
  const byId = new Map<StationId, Station>();
  for (const s of options.stations ?? []) {
    byId.set(s.id, s);
  }
  const all: ReadonlyArray<Station> = [...byId.values()];

  return {
    async listEligibleStations(query: StationEligibilityQuery) {
      return all.filter((station) => isEligible(station, query));
    },
    async getById(stationId) {
      return byId.get(stationId) ?? null;
    },
  };
}

function isEligible(
  station: Station,
  query: StationEligibilityQuery
): boolean {
  if (station.workstationClass !== query.workstationClass) return false;
  if (station.status === "down" || station.status === "maintenance") return false;
  for (const tag of query.requiredSkillTags) {
    if (!station.availableSkillTags.includes(tag)) return false;
  }
  return true;
}
