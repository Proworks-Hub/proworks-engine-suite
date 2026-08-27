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
 * PRIME Engine — Phase 2 Batch Y — projection bundle factory.
 *
 * One-shot composition helper that takes an `EventLog` and returns
 * the full `PrimeProjections` bundle expected by
 * `<PrimeProjectionsProvider>`. Lives here (not in hooks/) because
 * it's an app-boot concern, not a render-time one — you call it
 * once before mounting the React tree and memoize the result.
 *
 * Why a dedicated factory instead of inlining in the caller?
 *   - Keeps the creation order deterministic (summary is created
 *     first; kiosk / master-tablet / pre-production / customer all
 *     depend on it).
 *   - Centralizes dep-injection for tests — you can hand in a
 *     clock override via `opts.now` and every derived projection
 *     picks it up.
 *   - Gives a single surface to change when the set of projections
 *     grows (Phase 3 adds ShopAnalyticsProjection, etc.).
 *
 * Example wiring in App.tsx:
 *
 *   const eventLog = useMemo(() => createEventLog({ ... }), []);
 *   const projections = useMemo(
 *     () => createPrimeProjectionsBundle({ eventLog }),
 *     [eventLog],
 *   );
 *   return (
 *     <PrimeProjectionsProvider value={projections}>
 *       <PrimeSubscriptionRuntime eventLog={eventLog} />
 *       <Routes />
 *     </PrimeProjectionsProvider>
 *   );
 */

import type { EventLog } from "../core/logging/eventLog.js";
import type { WorkOrderSummaryProjection } from "../projections/createWorkOrderSummaryProjection.js";
import type { StationKioskProjection } from "../projections/stationKioskProjection.js";
import type { MasterTabletProjection } from "../projections/masterTabletProjection.js";
import type { PreProductionProjection } from "../projections/preProductionProjection.js";
import type { CustomerProjection } from "../projections/customerProjection.js";

import { createWorkOrderSummaryProjection } from "../projections/createWorkOrderSummaryProjection.js";
import { createStationKioskProjection } from "../projections/stationKioskProjection.js";
import { createMasterTabletProjection } from "../projections/masterTabletProjection.js";
import { createPreProductionProjection } from "../projections/preProductionProjection.js";
import { createCustomerProjection } from "../projections/customerProjection.js";

/**
 * The five projections a host renders together. Declared here rather than in
 * a React hook, because the shape is a pure engine concern — a host binds it
 * to whatever view layer it has.
 */
export interface PrimeProjections {
  readonly workOrderSummary: WorkOrderSummaryProjection;
  readonly stationKiosk: StationKioskProjection;
  readonly masterTablet: MasterTabletProjection;
  readonly preProduction: PreProductionProjection;
  readonly customer: CustomerProjection;
}

export interface CreatePrimeProjectionsBundleDeps {
  readonly eventLog: EventLog;
  /**
   * Clock override applied to every projection that accepts one.
   * Defaults to `Date.now()`. Tests inject a frozen or advancing
   * clock to drive deterministic view timestamps.
   */
  readonly now?: () => Date;
}

export function createPrimeProjectionsBundle(
  deps: CreatePrimeProjectionsBundleDeps,
): PrimeProjections {
  const { eventLog, now } = deps;

  // WorkOrderSummary is the base — every other projection reads from
  // its cache, so it must be created first and shared by reference.
  const workOrderSummary = createWorkOrderSummaryProjection({ eventLog });

  const stationKiosk = createStationKioskProjection({
    summaries: workOrderSummary,
    now,
  });
  const masterTablet = createMasterTabletProjection({
    summaries: workOrderSummary,
    now,
  });
  const preProduction = createPreProductionProjection({
    summaries: workOrderSummary,
    now,
  });
  const customer = createCustomerProjection({
    summaries: workOrderSummary,
    now,
  });

  return Object.freeze({
    workOrderSummary,
    stationKiosk,
    masterTablet,
    preProduction,
    customer,
  });
}
