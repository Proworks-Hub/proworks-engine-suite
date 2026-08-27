// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { CanonicalProduct, NormalizedOrder } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// What OrderIQ asks of a host.
//
// Note what is absent: anything that knows how to TALK to a channel. Pulling
// from Etsy needs OAuth, rate-limit handling and a per-seller token; pulling
// from Shopify needs webhooks and a different auth model entirely. All of that
// is a host adapter's job. The engine receives an already-fetched order.
//
// That is what makes "the channel does not matter" true rather than aspirational
// — there is no place in this package for a channel to matter.
// ─────────────────────────────────────────────────────────────────────────────

export interface IngestionLedger {
  /**
   * The order previously ingested under this key, or null.
   *
   * Returning the ORDER rather than a boolean is deliberate: a caller
   * re-reading a duplicate usually wants the normalized result, and a boolean
   * would send it back to the database for what this call already had.
   */
  find(organizationId: string, key: string): Promise<NormalizedOrder | null>;

  /**
   * Records the key against the order.
   *
   * A host's implementation should write this in the SAME transaction as any
   * downstream work it triggers. Recorded-but-not-acted-on is a lost order;
   * acted-on-but-not-recorded is a duplicate one.
   */
  record(key: string, order: NormalizedOrder): Promise<void>;
}

export interface ProductCatalog {
  /** One read for the whole order, rather than one per line. */
  bySkus(
    organizationId: string,
    skus: ReadonlyArray<string>,
  ): Promise<CanonicalProduct[]>;
}
