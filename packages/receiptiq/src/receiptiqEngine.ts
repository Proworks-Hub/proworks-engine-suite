// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type {
  EventBus,
  EventSource,
  NormalizedReceipt,
  PriceObservation,
  RawReceiptInput,
  ReceiptExtractor,
  TenantContext,
  TraceContext,
} from "@proworks-hub/contracts";
import {
  EVENT_TYPES,
  createEnginePublisher,
  newCorrelationId,
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
   * Where to announce what was read. Optional: an engine with no bus publishes
   * nothing and behaves exactly as before, which is how Family Table can adopt
   * this without adopting an event system.
   *
   * ReceiptIQ never learns who listens. That ignorance is the point — it is
   * what lets a household's receipt improve a fabrication shop's cost basis
   * without ReceiptIQ gaining a dependency on either.
   */
  eventBus?: EventBus;
  /** Identifies the publisher on every event. Defaults to `receiptiq`. */
  eventSource?: EventSource;
  /** Publication is best-effort; failures are reported here, never thrown. */
  onPublishError?: (error: Error, eventType: string) => void;
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
    options: NormalizeOptions<TCategory> & PublishContext,
  ): Promise<NormalizedReceipt>;

  /**
   * Private receipt → canonical observations, subject to opt-in.
   * Returns what may cross; persisting is the host's decision.
   */
  contribute(
    receipt: NormalizedReceipt,
    options: ContributionOptions & PublishContext,
  ): ContributionResult;

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

/**
 * Supplied per call, not per engine. A tenant and a correlation belong to the
 * request being served; an engine instance may serve thousands.
 */
export interface PublishContext {
  tenant?: TenantContext;
  trace?: TraceContext;
}

export function createReceiptIqEngine(config: ReceiptIqConfig = {}): ReceiptIqEngine {
  const extractor = config.extractor ?? textExtractor;
  const publish = createEnginePublisher({
    ...(config.eventBus ? { bus: config.eventBus } : {}),
    source: config.eventSource ?? { service: "receiptiq" },
    ...(config.onPublishError ? { onPublishError: config.onPublishError } : {}),
  });

  return {
    name: "receiptiq",
    extractorName: extractor.name,

    async read(input, options) {
      const extracted = await extractor.extract(input);
      const trace = options.trace ?? { correlationId: newCorrelationId() };

      publish({
        eventType: EVENT_TYPES.receiptIngested,
        ...(options.tenant ? { tenant: options.tenant } : {}),
        trace,
        payload: {
          fingerprint: `pending:${extracted.merchant ?? "unknown"}:${extracted.date ?? "undated"}`,
          source: options.source ?? "manual",
          extractor: extractor.name,
          lineCount: extracted.items?.length ?? 0,
        },
      });

      const receipt = normalizeReceipt(extracted, {
        ...options,
        currency: options.currency ?? config.currency,
      });

      publish({
        eventType: EVENT_TYPES.receiptNormalized,
        ...(options.tenant ? { tenant: options.tenant } : {}),
        trace,
        aggregate: { type: "receipt", id: receipt.fingerprint },
        payload: {
          fingerprint: receipt.fingerprint,
          merchantKey: receipt.merchantKey ?? "",
          merchantName: receipt.merchantName,
          purchaseDate: receipt.purchaseDate,
          lineCount: receipt.lines.length,
          ...(receipt.total ? { total: receipt.total } : {}),
          needsReviewCount: receipt.lines.filter((l) => l.confidence < 0.5).length,
        },
      });

      return receipt;
    },

    contribute(receipt, options) {
      const result = contributeObservations(receipt, options);
      const trace = options.trace ?? { correlationId: newCorrelationId() };

      // Deliberately published WITHOUT a tenant. The payload is a
      // PriceObservation, which is canonical by construction — the bus refuses
      // a tenant on this event type, and that refusal is what keeps the shared
      // layer from learning who contributed.
      for (const observation of result.observations) {
        publish({
          eventType: EVENT_TYPES.materialPurchaseDetected,
          trace,
          aggregate: { type: "canonical-item", id: observation.itemKey },
          payload: { observation },
        });
      }

      return result;
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
