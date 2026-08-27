// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  CAPABILITIES,
  PICKUP_STAGE_ORDER,
  TRACKING_STAGE_ORDER,
  assertTrackingSafeFor,
  mergeShipmentIntoTracking,
  redactTrackingFor,
  requireCapability,
  type CapabilityResolver,
  type OrderTrackingSnapshot,
  type TrackingAudience,
  type TrackingStage,
} from "@proworks-hub/contracts";

import type { ShipmentProvider, TrackingQuery, TrackingSource } from "./ports.js";

// ─────────────────────────────────────────────────────────────────────────────
// The tracking service.
//
// Four jobs, in order: ask the sources, pick between their answers, merge in
// the carrier, narrow to the audience. Everything hard is in the second step.
// ─────────────────────────────────────────────────────────────────────────────

/** Stages that describe a CONDITION rather than a position on the bar. */
const CONDITION_STAGES: ReadonlySet<TrackingStage> = new Set(["cancelled", "on_hold"]);

/** Audiences that see internal detail, and so require an entitlement. */
const DEEP_AUDIENCES: ReadonlySet<TrackingAudience> = new Set(["shop_floor", "manager"]);

export interface TrackingServiceDeps {
  /**
   * Ordered, most authoritative first. Order breaks ties and nothing else —
   * the stage comparison below does the real work.
   */
  readonly sources: ReadonlyArray<TrackingSource>;
  readonly shipments?: ShipmentProvider;
  /**
   * Required before any audience that sees internal detail will be served.
   * Absent, deep audiences are REFUSED rather than quietly allowed — an
   * optional access check is not an access check.
   */
  readonly capabilities?: CapabilityResolver;
  /**
   * The consuming application, for the capability lookup.
   *
   * REQUIRED, deliberately. It defaulted to "proworks", which meant a MakerOps
   * host that forgot to pass it had its entitlements looked up under a product
   * it does not run — refused silently, or matched against a grant belonging to
   * a different application. A default that names one host is the coupling this
   * architecture exists to avoid; an omission should fail loudly instead.
   */
  readonly application: string;
  readonly onError?: (source: string, error: unknown) => void;
}

export interface TrackingRequest extends TrackingQuery {
  readonly audience: TrackingAudience;
}

export interface TrackingService {
  track(request: TrackingRequest): Promise<OrderTrackingSnapshot | null>;
}

export function createTrackingService(deps: TrackingServiceDeps): TrackingService {
  const application = deps.application;

  return {
    async track(request) {
      if (DEEP_AUDIENCES.has(request.audience)) {
        if (!deps.capabilities) {
          // Fails closed. A service wired without a resolver cannot serve a
          // view that contains station names and operator ids, because it has
          // no way to know whether this consumer is allowed one.
          throw new Error(
            `tracking audience "${request.audience}" requires a capability resolver; ` +
              `this service was created without one`,
          );
        }
        await requireCapability(
          deps.capabilities,
          request.organizationId,
          application,
          CAPABILITIES.workOrder.shopFloor,
        );
      }

      const query: TrackingQuery = {
        orderRef: request.orderRef,
        organizationId: request.organizationId,
      };

      const answers = await collectAnswers(deps, query);
      const production = mostInformative(answers);
      if (!production) return null;

      const shipment = await loadShipment(deps, query);
      const merged = mergeShipmentIntoTracking(production, shipment);
      const view = redactTrackingFor(merged, request.audience);

      // Braces to redaction's belt. It costs one comparison and it is the last
      // thing standing between an internal block and an HTTP response.
      assertTrackingSafeFor(view, request.audience);
      return view;
    },
  };
}

/**
 * Asks every source, and lets one failing source cost only its own answer.
 *
 * A source is usually a database or another service. If the carrier's
 * integration is down, a customer should still be told their order is in
 * production — a tracking page that 500s because one of four inputs is
 * unavailable is worse than a tracking page that is slightly less complete.
 */
async function collectAnswers(
  deps: TrackingServiceDeps,
  query: TrackingQuery,
): Promise<OrderTrackingSnapshot[]> {
  const settled = await Promise.all(
    deps.sources.map(async (source) => {
      try {
        return await source.get(query);
      } catch (error) {
        deps.onError?.(source.name, error);
        return null;
      }
    }),
  );

  return settled.filter((s): s is OrderTrackingSnapshot => s !== null);
}

async function loadShipment(deps: TrackingServiceDeps, query: TrackingQuery) {
  if (!deps.shipments) return undefined;
  try {
    return (await deps.shipments.get(query)) ?? undefined;
  } catch (error) {
    deps.onError?.(deps.shipments.name, error);
    return undefined;
  }
}

/**
 * Picks between sources that disagree.
 *
 * They disagree constantly and legitimately. A KSix web order says "received"
 * while the ProWorks work order it became says "in_production" — neither is
 * wrong, they are just at different distances from the floor.
 *
 * THE RULE:
 *  1. A condition beats a position. Cancelled is cancelled even if a
 *     production source is still cheerfully reporting progress, because a
 *     source that has not been told about the cancellation is exactly the
 *     source that would keep reporting progress.
 *  2. Otherwise the furthest along its branch wins. Progress is information
 *     somebody has and the others do not.
 *  3. Ties go to source order, so the result is deterministic.
 *
 * The alternative — first non-null wins — is simpler and quietly wrong: it
 * makes the answer depend on the order a host happened to register its
 * sources in, which is not a thing anyone will remember to get right.
 */
function mostInformative(
  answers: ReadonlyArray<OrderTrackingSnapshot>,
): OrderTrackingSnapshot | null {
  if (answers.length === 0) return null;

  const cancelled = answers.find((a) => a.stage === "cancelled");
  if (cancelled) return cancelled;
  const held = answers.find((a) => a.stage === "on_hold");
  if (held) return held;

  let best = answers[0]!;
  let bestRank = stageRank(best.stage);

  for (const candidate of answers.slice(1)) {
    const rank = stageRank(candidate.stage);
    if (rank > bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }

  return best;
}

/**
 * How far along a stage is, across either branch.
 *
 * The two branches are compared by position rather than merged into one
 * ordering, because an order takes exactly one of them — nothing is ever both
 * shipped and collected, so the branches never actually compete.
 */
function stageRank(stage: TrackingStage): number {
  if (CONDITION_STAGES.has(stage)) return -1;
  const shipIndex = TRACKING_STAGE_ORDER.indexOf(stage);
  if (shipIndex >= 0) return shipIndex;
  return PICKUP_STAGE_ORDER.indexOf(stage);
}
