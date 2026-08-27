// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { CatalogProduct, NormalizedOrder } from "@proworks-hub/contracts";

import type { IngestionLedger, ProductCatalog } from "./ports.js";

// ─────────────────────────────────────────────────────────────────────────────
// In-memory ledger and catalogue, for tests and for a host still choosing a
// database.
//
// The ledger here is NOT a real idempotency store: it holds no lock, so two
// simultaneous ingests of the same order both find nothing and both proceed. A
// durable implementation needs a unique constraint on the key and must treat
// the insert conflict — not the prior read — as the duplicate signal. Said
// plainly rather than discovered later.
//
// Every method narrows its port's return type to a plain Promise. Standing rule
// here: vitest strips types, so a returned union passes tests and fails
// typecheck.
// ─────────────────────────────────────────────────────────────────────────────

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface InMemoryIngestionLedger extends IngestionLedger {
  all(): NormalizedOrder[];
  clear(): void;
}

export function createInMemoryIngestionLedger(): InMemoryIngestionLedger {
  const orders = new Map<string, NormalizedOrder>();
  const scope = (organizationId: string, key: string): string => `${organizationId}::${key}`;

  return {
    async find(organizationId, key) {
      const found = orders.get(scope(organizationId, key));
      return found ? clone(found) : null;
    },

    async record(key, order) {
      orders.set(scope(order.organizationId, key), clone(order));
    },

    all: () => [...orders.values()].map(clone),
    clear: () => orders.clear(),
  };
}

export interface InMemoryProductCatalog extends ProductCatalog {
  add(product: CatalogProduct): void;
  clear(): void;
}

export function createInMemoryProductCatalog(
  initial: ReadonlyArray<CatalogProduct> = [],
): InMemoryProductCatalog {
  const products = new Map<string, CatalogProduct>();
  for (const product of initial) products.set(product.sku, clone(product));

  return {
    async bySkus(organizationId, skus) {
      // Deliberately NOT filtered by organization. The engine distinguishes
      // "no such product" from "somebody else's product", and it can only do
      // that if the lookup returns the row and lets the engine judge it. A
      // catalogue that pre-filtered would report a cross-tenant SKU as unknown,
      // and the shop would go looking for a product that exists.
      const wanted = new Set(skus);
      return [...products.values()].filter((p) => wanted.has(p.sku)).map(clone);
    },

    add(product) {
      products.set(product.sku, clone(product));
    },
    clear: () => products.clear(),
  };
}
