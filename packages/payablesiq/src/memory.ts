// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { TenantContext } from "@proworks-hub/contracts";

import type {
  AgingSnapshot,
  PayableObligation,
  PaymentTermsDefinition,
  SettlementApplication,
} from "./model.js";
import { obligationFingerprint } from "./model.js";
import type {
  AgingSnapshotRepository,
  OpenItemFilter,
  PayableObligationRepository,
  PaymentTermsDefinitionRepository,
  SettlementApplicationRepository,
} from "./ports.js";

// ─────────────────────────────────────────────────────────────────────────────
// Reference in-memory repositories. Tenant-scoped by key prefix — an
// implementation that ignored the TenantContext would fail the isolation
// tests, so this one does not ignore it.
// ─────────────────────────────────────────────────────────────────────────────

const scope = (ctx: TenantContext, key: string) => `${ctx.organizationId}::${key}`;

export function createInMemoryPayablesRepositories(): {
  obligations: PayableObligationRepository;
  applications: SettlementApplicationRepository;
  snapshots: AgingSnapshotRepository;
  terms: PaymentTermsDefinitionRepository;
} {
  const versions = new Map<string, PayableObligation[]>();
  const applications = new Map<string, SettlementApplication[]>();
  const applicationsByKey = new Map<string, SettlementApplication>();
  const snapshots = new Map<string, AgingSnapshot>();
  const termsStore = new Map<string, PaymentTermsDefinition[]>();

  return {
    obligations: {
      async put(version, ctx) {
        const key = scope(ctx, version.obligationId);
        const chain = versions.get(key) ?? [];
        chain.push(version);
        versions.set(key, chain);
      },
      async getLatest(id, ctx) {
        const chain = versions.get(scope(ctx, id));
        return chain ? chain[chain.length - 1] : undefined;
      },
      async getVersion(id, v, ctx) {
        return versions.get(scope(ctx, id))?.find((o) => o.version === v);
      },
      async listOpen(filter: OpenItemFilter, ctx) {
        const out: PayableObligation[] = [];
        for (const [key, chain] of versions) {
          if (!key.startsWith(`${ctx.organizationId}::`)) continue;
          const latest = chain[chain.length - 1];
          if (!latest) continue;
          if (filter.vendorRef && latest.vendorRef !== filter.vendorRef) continue;
          if (filter.currency && latest.currency !== filter.currency) continue;
          out.push(latest);
        }
        return out.sort((a, b) => (a.obligationId < b.obligationId ? -1 : 1));
      },
      async findByFingerprint(fp, ctx) {
        const out: PayableObligation[] = [];
        for (const [key, chain] of versions) {
          if (!key.startsWith(`${ctx.organizationId}::`)) continue;
          const latest = chain[chain.length - 1];
          if (latest && obligationFingerprint(latest) === fp) out.push(latest);
        }
        return out;
      },
    },
    applications: {
      async put(application, ctx) {
        const key = scope(ctx, application.obligationId);
        const list = applications.get(key) ?? [];
        list.push(application);
        applications.set(key, list);
        applicationsByKey.set(scope(ctx, `key:${application.idempotencyKey}`), application);
      },
      async listForObligation(obligationId, ctx) {
        return applications.get(scope(ctx, obligationId)) ?? [];
      },
      async getByIdempotencyKey(key, ctx) {
        return applicationsByKey.get(scope(ctx, `key:${key}`));
      },
    },
    snapshots: {
      async put(snapshot, ctx) {
        const key = scope(ctx, snapshot.agingRunId);
        if (snapshots.has(key)) {
          // Write-once: a second write with the same id is a programmer error.
          throw new Error(`AgingSnapshot ${snapshot.agingRunId} already exists; snapshots are write-once.`);
        }
        snapshots.set(key, snapshot);
      },
      async get(agingRunId, ctx) {
        return snapshots.get(scope(ctx, agingRunId));
      },
    },
    terms: {
      async put(terms, ctx) {
        const key = scope(ctx, terms.methodRef.methodId);
        const list = termsStore.get(key) ?? [];
        list.push(terms);
        termsStore.set(key, list);
      },
      async get(methodId, semanticVersion, ctx) {
        return termsStore
          .get(scope(ctx, methodId))
          ?.find((t) => t.methodRef.semanticVersion === semanticVersion);
      },
      async resolveAt(methodId, termsDate, ctx) {
        const eligible = (termsStore.get(scope(ctx, methodId)) ?? [])
          .filter((t) => (t.methodRef.effectiveFrom ?? "0000-01-01") <= termsDate)
          .sort((a, b) =>
            (a.methodRef.effectiveFrom ?? "").localeCompare(b.methodRef.effectiveFrom ?? ""),
          );
        return eligible[eligible.length - 1];
      },
    },
  };
}
