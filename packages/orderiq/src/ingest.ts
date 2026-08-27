// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  ORDER_CONTRACT_VERSION,
  externalOrderKey,
  isValidInteraxisSku,
  interaxisSkuSchema,
  validateExternalOrder,
  type CatalogProduct,
  type ExternalOrder,
  type ExternalOrderLine,
  type LineMatchFailure,
  type NormalizedOrder,
  type NormalizedOrderLine,
} from "@proworks-hub/contracts";

import type { IngestionLedger, ProductCatalog } from "./ports.js";
import type { OrderIqEvent } from "./events.js";

// ─────────────────────────────────────────────────────────────────────────────
// Ingestion.
//
// Five steps, and only the middle one is interesting:
//
//   1. Has this order already been ingested?   ← everything hinges on this
//   2. Is it well-formed?
//   3. Match each line to a product.
//   4. Record the key, so step 1 works next time.
//   5. Hand back a normalized order and the events that describe it.
//
// TWO RULES THAT LOOK LIKE DETAILS AND ARE NOT.
//
// AN UNMATCHED LINE DOES NOT FAIL THE ORDER. The customer has already paid.
// Refusing the whole order because one line's SKU is wrong turns a five-minute
// mapping job into a lost sale and an angry buyer, and the shop finds out from
// the buyer rather than from a queue. The order is ingested, the line is
// flagged with WHY, and somebody fixes it.
//
// THE DUPLICATE CHECK COMES FIRST, before validation and before matching.
// Pollers re-read. Webhooks retry. A shop clicks "sync now" twice. If the check
// runs anywhere but first, the second read has already done half its work.
// ─────────────────────────────────────────────────────────────────────────────

export interface IngestOrderDeps {
  readonly ledger: IngestionLedger;
  readonly catalog: ProductCatalog;
  readonly now?: () => Date;
  readonly generateOrderRef?: () => string;
}

export type IngestOutcome =
  | "ingested"
  /** Already seen. The previously normalized order is returned unchanged. */
  | "duplicate"
  /** The payload is not a valid external order. Nothing was recorded. */
  | "rejected";

export interface IngestResult {
  readonly outcome: IngestOutcome;
  readonly order?: NormalizedOrder;
  readonly events: OrderIqEvent[];
  readonly error?: { readonly message: string; readonly details?: unknown };
}

export interface IngestOrderUseCase {
  execute(input: unknown): Promise<IngestResult>;
}

export function createIngestOrderUseCase(deps: IngestOrderDeps): IngestOrderUseCase {
  const now = deps.now ?? (() => new Date());
  const generateOrderRef = deps.generateOrderRef ?? defaultOrderRef;

  return {
    async execute(input) {
      // Read the key WITHOUT trusting the rest of the payload. A duplicate of
      // a malformed order is still a duplicate, and validating first would
      // reject it noisily every time the poller came round.
      const probe = input as Partial<ExternalOrder>;
      const key =
        probe?.channel?.channel && probe?.externalOrderId
          ? externalOrderKey(probe.channel, probe.externalOrderId)
          : null;
      const organizationId = probe?.organizationId;

      if (key && organizationId) {
        const seen = await deps.ledger.find(organizationId, key);
        if (seen) {
          return {
            outcome: "duplicate",
            order: seen,
            events: [
              {
                type: "order.duplicate_skipped",
                organizationId,
                orderRef: seen.orderRef,
                occurredAt: now().toISOString(),
                payload: {
                  channel: seen.channel.channel,
                  externalOrderId: seen.externalOrderId,
                  firstIngestedAt: seen.ingestedAt,
                },
              },
            ],
          };
        }
      }

      let external: ExternalOrder;
      try {
        external = validateExternalOrder(input);
      } catch (error) {
        return {
          outcome: "rejected",
          events: [],
          error: {
            message: "the payload is not a valid external order",
            details: error instanceof Error ? error.message : error,
          },
        };
      }

      const at = now().toISOString();
      const orderRef = generateOrderRef();

      const skus = collectCandidateSkus(external.lines);
      const products = await deps.catalog.bySkus(external.organizationId, skus);
      const bySku = new Map(products.map((p) => [p.sku, p]));

      const lines = external.lines.map((line) =>
        matchLine(line, bySku, external.organizationId),
      );
      const fullyMatched = lines.every((line) => line.matchFailure === undefined);

      const order: NormalizedOrder = {
        orderVersion: ORDER_CONTRACT_VERSION,
        orderRef,
        organizationId: external.organizationId,
        channel: external.channel,
        externalOrderId: external.externalOrderId,
        ...(external.externalOrderNumber
          ? { externalOrderNumber: external.externalOrderNumber }
          : {}),
        placedAt: external.placedAt,
        ingestedAt: at,
        ...(external.buyer ? { buyer: external.buyer } : {}),
        lines,
        ...(external.orderTotal ? { orderTotal: external.orderTotal } : {}),
        ...(external.paid !== undefined ? { paid: external.paid } : {}),
        ...(external.requestedShipBy ? { requestedShipBy: external.requestedShipBy } : {}),
        ...(external.buyerNote ? { buyerNote: external.buyerNote } : {}),
        fullyMatched,
      };

      // Recorded before the events are handed back. A caller that publishes
      // and then crashes must not be able to re-ingest, and the ledger write
      // is what makes the second attempt a duplicate.
      await deps.ledger.record(
        externalOrderKey(external.channel, external.externalOrderId),
        order,
      );

      const events: OrderIqEvent[] = [
        {
          type: "order.ingested",
          organizationId: order.organizationId,
          orderRef,
          occurredAt: at,
          payload: {
            channel: order.channel.channel,
            externalOrderId: order.externalOrderId,
            lineCount: order.lines.length,
            fullyMatched,
            paid: order.paid,
          },
        },
      ];

      for (const line of lines) {
        if (!line.matchFailure) continue;
        events.push({
          type: "order.line_unmatched",
          organizationId: order.organizationId,
          orderRef,
          occurredAt: at,
          payload: {
            externalLineId: line.externalLineId,
            reason: line.matchFailure,
            sourceSku: line.sourceSku,
            sourceTitle: line.sourceTitle,
            quantity: line.quantity,
          },
        });
      }

      if (fullyMatched) {
        events.push({
          type: "order.ready_for_production",
          organizationId: order.organizationId,
          orderRef,
          occurredAt: at,
          payload: {
            // A configurable line still needs its options resolved before a
            // route exists, so "ready" is not the same as "routable".
            requiresConfiguration: lines.some((line) => line.configurable),
            lineCount: lines.length,
          },
        });
      }

      return { outcome: "ingested", order, events };
    },
  };
}

/**
 * Matches one line to a product, and says precisely why when it cannot.
 *
 * The order of the checks is deliberate: it walks from "there was nothing to
 * work with" to "there was something and it was wrong", so the failure a human
 * reads is the most specific one true of the line.
 */
function matchLine(
  line: ExternalOrderLine,
  bySku: ReadonlyMap<string, CatalogProduct>,
  organizationId: string,
): NormalizedOrderLine {
  const base = {
    externalLineId: line.externalLineId,
    quantity: line.quantity,
    configurable: false,
    ...(line.unitPrice ? { unitPrice: line.unitPrice } : {}),
    // Carried through whatever happens. Personalization is the thing a buyer
    // will phone about, and losing it because a SKU did not match is
    // unrecoverable — the channel may not keep it either.
    ...(line.personalization ? { personalization: line.personalization } : {}),
    ...(line.selections ? { selections: line.selections } : {}),
    ...(line.title ? { sourceTitle: line.title } : {}),
    ...(line.sku ? { sourceSku: line.sku } : {}),
  };

  const fail = (matchFailure: LineMatchFailure): NormalizedOrderLine => ({
    ...base,
    matchFailure,
  });

  const raw = line.sku?.trim();
  if (!raw) return fail("no_sku");

  const candidate = raw.toUpperCase();
  if (!candidate.startsWith("IX-")) return fail("foreign_sku");

  // Shaped like ours but failing its own check character: a transcription
  // error, not an unknown product. Different message, different fix — and
  // telling somebody "unknown SKU" when they mistyped one sends them looking
  // for a product that was there all along.
  if (!interaxisSkuSchema.safeParse(candidate).success || !isValidInteraxisSku(candidate)) {
    return fail("malformed_sku");
  }

  const product = bySku.get(candidate);
  if (!product) return fail("unknown_sku");
  if (product.organizationId !== organizationId) return fail("wrong_organization");
  if (!product.active) return fail("inactive_product");

  return {
    ...base,
    sku: product.sku,
    configurable: product.configurable,
    ...(product.productDefinitionId
      ? { productDefinitionId: product.productDefinitionId }
      : {}),
  };
}

/** Well-formed Interaxis SKUs on the order, deduplicated, for one catalogue read. */
function collectCandidateSkus(lines: ReadonlyArray<ExternalOrderLine>): string[] {
  const skus = new Set<string>();
  for (const line of lines) {
    const candidate = line.sku?.trim().toUpperCase();
    if (candidate && isValidInteraxisSku(candidate)) skus.add(candidate);
  }
  return [...skus];
}

function defaultOrderRef(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  return typeof g.crypto?.randomUUID === "function"
    ? `ord_${g.crypto.randomUUID()}`
    : `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
