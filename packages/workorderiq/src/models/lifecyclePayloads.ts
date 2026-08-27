// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { WorkOrderStepId } from "./events.js";

// ─────────────────────────────────────────────────────────────────────────────
// Quality and packaging outcomes.
//
// The audit found the existing vocabulary already covers nearly everything a
// tracking system needs — 35 event types, against roughly 25 in the proposal
// that prompted this. These four are what it genuinely lacked, and they were
// added rather than the whole set renamed.
//
// WHY QUALITY IS NOT ALREADY COVERED by `step.completed`. A QC step completing
// says the inspection HAPPENED. It does not say what the inspection FOUND, and
// those are different facts with different consequences: one advances the work
// order, the other may send half of it back to a station it already left. A
// system that infers "passed" from "completed" cannot represent a failed
// inspection at all, and a failed inspection is the case that matters.
//
// WHY PACKAGING IS NOT COVERED either. `ready_for_pickup` means required steps
// are done. Between that and a parcel existing there is real work — boxing,
// labelling, staging — during which the honest answer to "where is my order"
// is neither "in production" nor "shipped". Without these, tracking has to
// guess, and it guesses "shipped", which is the guess that generates the call.
//
// No use case in this engine emits these yet; a host appends them through the
// event log like any other fact. That is stated rather than hidden — the
// vocabulary is a contract, and a contract can be published before every
// producer exists. What must not happen is tracking inferring these states.
// ─────────────────────────────────────────────────────────────────────────────

/** What an inspection was performed against. */
export interface QualityInspectionRef {
  /** The QC step whose completion carried this inspection, when there was one. */
  readonly stepId?: WorkOrderStepId;
  /** Free-text station or bench name, for the floor's own records. */
  readonly station?: string;
  /** How many units were looked at, when the inspection was a sample. */
  readonly sampledQuantity?: number;
}

export interface QualityInspectionPassedPayload extends QualityInspectionRef {
  readonly inspectedQuantity: number;
  readonly notes?: string;
}

/**
 * A failed inspection.
 *
 * `disposition` is the field that matters: it is what happens next, and it is
 * not derivable from the failure itself. Scrapping fifty shirts and reworking
 * them are the same event and completely different orders.
 */
export interface QualityInspectionFailedPayload extends QualityInspectionRef {
  readonly inspectedQuantity: number;
  readonly failedQuantity: number;
  readonly disposition: "rework" | "scrap" | "use_as_is" | "hold_for_review";
  /** Short, and written for the shop rather than the customer. */
  readonly reason: string;
  /** Steps that must run again. Empty for scrap or use-as-is. */
  readonly reworkStepIds?: ReadonlyArray<WorkOrderStepId>;
  readonly notes?: string;
}

export interface PackagingStartedPayload {
  readonly station?: string;
  /** Parcels, boxes, pallets — whatever this shop counts. */
  readonly expectedPackageCount?: number;
}

/**
 * Packing is done and the goods are staged.
 *
 * Deliberately says nothing about a carrier. Whether a parcel has been
 * collected is the carrier's fact, not the shop's, and a shop that records its
 * own "shipped" is a shop whose tracking is wrong for two days at a time.
 */
export interface PackagingCompletedPayload {
  readonly packageCount: number;
  readonly station?: string;
  /** Where the finished work is now sitting, for whoever has to find it. */
  readonly stagingLocation?: string;
  /** True when the customer collects rather than the order shipping. */
  readonly awaitingPickup?: boolean;
  readonly notes?: string;
}
