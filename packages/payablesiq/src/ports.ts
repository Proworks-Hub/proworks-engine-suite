// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ExchangeRateRef, TenantContext } from "@proworks-hub/contracts";

import type {
  AgingSnapshot,
  PayableObligation,
  PaymentTermsDefinition,
  SettlementApplication,
} from "./model.js";

// ─────────────────────────────────────────────────────────────────────────────
// The four repository ports — §21. PayablesIQ holds no database, no ORM and
// no storage of any kind. There is NO update and NO delete on the obligation,
// application or snapshot repositories: LOCK-3 expressed as an absent method,
// the same choice auditiq made. Every method takes a TenantContext; an
// implementation that ignores it fails the isolation tests.
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenItemFilter {
  readonly vendorRef?: string;
  readonly currency?: string;
}

export interface PayableObligationRepository {
  /** Append-only: a new version, never an edit. */
  put(version: PayableObligation, ctx: TenantContext): Promise<void>;
  getLatest(id: string, ctx: TenantContext): Promise<PayableObligation | undefined>;
  getVersion(id: string, v: number, ctx: TenantContext): Promise<PayableObligation | undefined>;
  listOpen(filter: OpenItemFilter, ctx: TenantContext): Promise<readonly PayableObligation[]>;
  /** Duplicate-liability suppression is a QUERY, not a scan. */
  findByFingerprint(fp: string, ctx: TenantContext): Promise<readonly PayableObligation[]>;
}

export interface SettlementApplicationRepository {
  /** Append-only. */
  put(application: SettlementApplication, ctx: TenantContext): Promise<void>;
  listForObligation(obligationId: string, ctx: TenantContext): Promise<readonly SettlementApplication[]>;
  getByIdempotencyKey(key: string, ctx: TenantContext): Promise<SettlementApplication | undefined>;
}

export interface AgingSnapshotRepository {
  /** Write-once. No update method exists. */
  put(snapshot: AgingSnapshot, ctx: TenantContext): Promise<void>;
  get(agingRunId: string, ctx: TenantContext): Promise<AgingSnapshot | undefined>;
}

export interface PaymentTermsDefinitionRepository {
  /** Versioned; no delete — historical results reference old versions. */
  put(terms: PaymentTermsDefinition, ctx: TenantContext): Promise<void>;
  get(methodId: string, semanticVersion: string, ctx: TenantContext): Promise<PaymentTermsDefinition | undefined>;
  /** The version whose effectiveFrom is the latest ≤ termsDate. Never wall clock. */
  resolveAt(methodId: string, termsDate: string, ctx: TenantContext): Promise<PaymentTermsDefinition | undefined>;
}

/** Unbound today. A revaluation with no rate is a refusal, never a stale rate presented as current. */
export interface ExchangeRatePort {
  closingRate(base: string, quote: string, asOf: string): Promise<ExchangeRateRef | undefined>;
}

/** Unbound today. Two vendorRefs merge only when this asserts they are one vendor. */
export interface VendorReferenceResolver {
  sameVendor(a: string, b: string, ctx: TenantContext): Promise<boolean>;
}
