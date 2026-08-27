// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type {
  NormalizedReceipt,
  PriceObservation,
  RawReceiptInput,
  ReceiptExtractor,
} from "@proworks-hub/contracts";
import { textExtractor } from "./extract/textExtractor.js";
import { normalizeReceipt, type NormalizeOptions } from "./normalizeReceipt.js";
import { contributeObservations, type ContributionOptions, type ContributionResult } from "./boundary/contribute.js";
import { bestEstimate, estimatePrice, summarizeByMerchant, type EstimateOptions, type PriceEstimate } from "./pricing/estimator.js";

// ─────────────────────────────────────────────────────────────────────────────
// ReceiptIQ — read it, normalize it, learn from it.
//
// The public boundary. A receipt in, a normalized private record out; and
// separately, on an explicit opt-in, canonical observations that may be shared.
//
// The two are separate calls on purpose. A single `process()` that did both
// would make contribution the default path and privacy the thing you have to
// remember — which is how shared-knowledge systems turn into shared-data
// systems without anyone deciding to.
//
// Every persistence concern is a port. ReceiptIQ holds no database, no ORM, no
// storage of any kind, so Family Table can back it with a local document and
// Supabase while ProWorks backs it with Postgres, and neither can see the
// other's records because neither repository can express the query.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReceiptIqConfig {
  /**
   * Reads raw captures. Defaults to the built-in text extractor, which needs
   * no AI provider — so the engine works offline and its behaviour is
   * reproducible in tests.
   */
  extractor?: ReceiptExtractor;
  currency?: string;
}

export interface ReceiptIqEngine {
  readonly name: string;
  /** Which extractor is in use, so a host can report it honestly. */
  readonly extractorName: string;

  /** Raw capture → normalized private receipt. */
  read<TCategory extends string = string>(
    input: RawReceiptInput,
    options: NormalizeOptions<TCategory>,
  ): Promise<NormalizedReceipt>;

  /**
   * Private receipt → canonical observations, subject to opt-in.
   * Returns what may cross; persisting is the host's decision.
   */
  contribute(receipt: NormalizedReceipt, options: ContributionOptions): ContributionResult;

  /** What an item costs, from observations alone. */
  estimate(
    itemKey: string,
    observations: readonly PriceObservation[],
    options?: EstimateOptions & { preferredMerchantKey?: string },
  ): PriceEstimate | null;

  /** The same item, merchant by merchant. */
  compareMerchants(
    itemKey: string,
    observations: readonly PriceObservation[],
  ): ReturnType<typeof summarizeByMerchant>;
}

export function createReceiptIqEngine(config: ReceiptIqConfig = {}): ReceiptIqEngine {
  const extractor = config.extractor ?? textExtractor;

  return {
    name: "receiptiq",
    extractorName: extractor.name,

    async read(input, options) {
      const extracted = await extractor.extract(input);
      return normalizeReceipt(extracted, {
        ...options,
        currency: options.currency ?? config.currency,
      });
    },

    contribute(receipt, options) {
      return contributeObservations(receipt, options);
    },

    estimate(itemKey, observations, options = {}) {
      return options.preferredMerchantKey
        ? bestEstimate(itemKey, observations, options)
        : estimatePrice(itemKey, observations, options);
    },

    compareMerchants(itemKey, observations) {
      return summarizeByMerchant(itemKey, observations);
    },
  };
}
