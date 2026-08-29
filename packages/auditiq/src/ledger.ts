// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import {
  identifierSchema,
  type InstanceIdentity,
  type SealedAuditRecord,
} from "@proworks-hub/contracts";

import { createAuditIq, type AuditQuery, type AuditStore, type ChainVerification } from "./audit.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE EXECUTION LEDGER — two ledgers, and the wall between them.
//
// AuditIQ already provides the append-only, hash-chained record: no update, no
// delete, no redact, and each hash covering the previous so a change to an old
// entry invalidates every later one. That is not rebuilt here. This is the
// layer the ledger architecture asks for on top of it, and the whole of it
// turns on one separation:
//
//   THE INSTANCE LEDGER is authoritative for local operational execution. It
//   holds what a shop, a household or a clinic actually did. It is tenant data.
//
//   THE COLLECTIVE LEDGER holds constitutional, security, Foundry, release and
//   escalated-incident history. It is small, it is permanent, and it is not a
//   copy of anything.
//
// "Never mirror full local ledgers into the collective by default." That
// sentence is the design. A collective ledger that accepted ordinary
// operational entries would become a central copy of every tenant's business
// history — which is the outcome the entire multi-instance architecture exists
// to avoid, arrived at through the audit system rather than the database.
//
// So the collective REFUSES an entry that is not of a collective class, and
// the only route from an instance to the collective is an escalation carrying
// references and digests rather than records.
//
// WHY ESCALATION IS A TYPE AND NOT A METHOD PARAMETER
//
// Because six things must all be present and each of them is a thing somebody
// would otherwise leave out under pressure: why, what it covers, which policy
// approved it, which entries it came from, whether it was sanitized, and when
// it closes. An escalation missing any of those is an incident record nobody
// can review afterwards — and afterwards is the only time it gets read.
//
// WHAT THIS DOES NOT DO
//
// It does not authorize. `Governance` decides; a ledger records. It does not
// judge — AuditIQ's charter excludes "constitutional guilt, security
// adjudication". It does not hold domain records, only references and digests.
// And it does not transport anything between instances: an escalation is
// written into a collective ledger the host binds, not sent anywhere.
// ─────────────────────────────────────────────────────────────────────────────

export type LedgerScope = "instance" | "collective";

/**
 * The only kinds of entry a collective ledger accepts.
 *
 * A closed set, and deliberately small. Every addition to it is a decision to
 * copy more of a tenant's history into shared storage, which is exactly the
 * decision that should require someone to edit this list and say why.
 */
export const collectiveEntryClassSchema = z.enum([
  /** Constitutional amendments, charters, human authorizations. */
  "constitutional",
  /** Security findings and containment actions. */
  "security",
  /** Foundry missions, promotions and refusals. */
  "foundry",
  /** Release and version history across instances. */
  "release",
  /** An incident an instance raised. Arrives only by escalation. */
  "escalated_incident",
]);
export type CollectiveEntryClass = z.infer<typeof collectiveEntryClassSchema>;

/**
 * How much of the underlying evidence an escalation carries.
 *
 * Stated, never inferred. An escalation whose sanitization status is unknown
 * is one nobody can safely forward, and "unknown" is what an absent field
 * means to whoever reads it six months later.
 */
export const sanitizationStatusSchema = z.enum([
  /** Identifiers and payloads removed; only structure and counts remain. */
  "sanitized",
  /** Hashes and safe summaries only. The default posture. */
  "digests-only",
  /**
   * Raw tenant evidence. Requires explicit incident authorization, and every
   * read of it is logged.
   */
  "raw-authorized",
]);
export type SanitizationStatus = z.infer<typeof sanitizationStatusSchema>;

/**
 * A pointer back to an instance entry.
 *
 * The hash is carried so a collective reader can later ask the instance to
 * prove the entry still matches — provenance that survives the two ledgers
 * being separate stores, which is the only arrangement in which it is needed.
 */
export const sourceEntryRefSchema = z
  .object({
    globalInstanceId: identifierSchema,
    auditEventId: identifierSchema,
    sequence: z.number().int().nonnegative(),
    hash: z.string().min(1),
  })
  .strict();
export type SourceEntryRef = z.infer<typeof sourceEntryRefSchema>;

export const escalationSchema = z
  .object({
    escalationId: identifierSchema,
    /** Why this left the instance. Required — an unexplained escalation cannot be reviewed. */
    reason: z.string().min(1),
    /** What it covers: the incident, the workflow, the component. */
    scope: z.string().min(1),
    /** Which policy permitted raising it. */
    approvingPolicyId: identifierSchema,
    /** The Governance decision behind it. */
    decisionId: identifierSchema,
    /** Where it came from. At least one — an escalation from nothing is an assertion. */
    sourceEntryRefs: z.array(sourceEntryRefSchema).min(1),
    sanitizationStatus: sanitizationStatusSchema,
    /**
     * Required when raw tenant evidence travels.
     *
     * The one place this file demands a second authorization, because it is the
     * one place a tenant's actual records leave their instance.
     */
    incidentAuthorization: z
      .object({
        incidentId: identifierSchema,
        authorizedBy: identifierSchema,
        authorizedAt: z.string().min(1),
      })
      .strict()
      .optional(),
    /**
     * When this stops being open.
     *
     * One of these is required. An escalation with neither an expiry nor a
     * closure is one that stays open forever by default — and §14's rule that
     * temporary authority shall not silently become permanent is the same rule
     * in a different costume.
     */
    expiresAt: z.string().min(1).optional(),
    closedAt: z.string().min(1).optional(),
  })
  .strict()
  .refine((e) => e.sanitizationStatus !== "raw-authorized" || Boolean(e.incidentAuthorization), {
    message:
      "Raw tenant evidence requires explicit incident authorization. Without it this is a copy of a tenant's records leaving their instance on somebody's judgement, which is the transfer the ownership model exists to prevent.",
    path: ["incidentAuthorization"],
  })
  .refine((e) => Boolean(e.expiresAt) || Boolean(e.closedAt), {
    message:
      "An escalation must state when it expires or record that it closed. One with neither stays open by default, and an incident nobody closed is indistinguishable from one nobody finished.",
    path: ["expiresAt"],
  });
export type Escalation = z.infer<typeof escalationSchema>;

export type LedgerWriteResult =
  | { readonly written: true; readonly sealed: SealedAuditRecord }
  | { readonly written: false; readonly reason: string };

/** A read that names who is reading. There is no unscoped read. */
export interface LedgerRead extends AuditQuery {
  /**
   * The tenant asking.
   *
   * REQUIRED on an instance ledger, and the reason `query` here is not simply
   * AuditIQ's. AuditIQ's filter has an OPTIONAL tenant, which is correct for a
   * component that stores one tenant's evidence — and wrong for a ledger,
   * where an omitted filter would return everything to whoever asked. A
   * missing tenant filter must fail closed, not quietly become a global query.
   */
  readingTenant: string;
}

export interface InstanceLedger {
  readonly scope: "instance";
  readonly instance: InstanceIdentity;
  /** Whether this ledger survives a restart. */
  durability(): "in-memory" | "durable";

  /** Appends operational evidence. */
  append(input: unknown): LedgerWriteResult;

  /** Reads, scoped to the asking tenant. Cross-tenant reads return nothing. */
  read(filter: LedgerRead): readonly SealedAuditRecord[];

  /** Walks the hash chain. */
  verify(): ChainVerification;

  /**
   * Records that a replay was decided, and under what.
   *
   * The replay's own evidence. Charter of the ledger architecture: "Every
   * replay decision and side effect is itself written to the ledger." A replay
   * that left no trace would be the one operation capable of re-running
   * history while being invisible in it.
   */
  recordReplay(input: ReplayDecision): LedgerWriteResult;

  count(): number;
}

export interface CollectiveLedger {
  readonly scope: "collective";
  durability(): "in-memory" | "durable";

  /**
   * Appends a collective-class entry.
   *
   * Refuses anything else. This is the wall.
   */
  append(input: unknown, entryClass: CollectiveEntryClass): LedgerWriteResult;

  /** Accepts an escalation from an instance. References only, never records. */
  escalate(escalation: unknown): LedgerWriteResult;

  read(filter?: AuditQuery): readonly SealedAuditRecord[];
  verify(): ChainVerification;
  count(): number;
}

export interface ReplayDecision {
  readonly replaySessionId: string;
  readonly requestedBy: string;
  readonly tenant: { organizationId: string; roles: string[] };
  readonly correlationId: string;
  /** What is being replayed. A reference, not the events. */
  readonly scope: string;
  readonly decisionId: string;
  /**
   * Whether anything actually happens.
   *
   * Defaults to TRUE. Dry-run is the default posture the ledger architecture
   * asks for, and a default of false would make the dangerous mode the one you
   * get by not thinking about it.
   */
  readonly dryRun?: boolean;
  readonly reason: string;
}

export interface LedgerOptions {
  readonly instance: InstanceIdentity;
  /**
   * Where the entries live. Defaults to in-memory.
   *
   * The instance and collective ledgers take SEPARATE stores, and a host that
   * bound one store to both would have merged the two — which is the single
   * thing this whole file exists to keep apart.
   */
  readonly store?: AuditStore;
  readonly now?: () => Date;
  readonly generateId?: () => string;
  readonly onRejected?: (reason: string, input: unknown) => void;
}

// ─────────────────────────────────────────────────────────────────────────────

export function createInstanceLedger(options: LedgerOptions): InstanceLedger {
  const audit = createAuditIq({
    instance: options.instance,
    ...(options.store ? { store: options.store } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.generateId ? { generateId: options.generateId } : {}),
    ...(options.onRejected ? { onRejected: options.onRejected } : {}),
  });
  const now = options.now ?? (() => new Date());
  let replayCount = 0;

  return {
    scope: "instance",
    instance: options.instance,

    append(input) {
      const result = audit.record(input);
      return result.accepted
        ? { written: true, sealed: result.sealed }
        : { written: false, reason: result.reason };
    },

    read(filter) {
      const { readingTenant, tenant: _ignored, ...rest } = filter ?? {};

      // A MISSING tenant fails closed. It does not become a global query.
      //
      // Found by this file's own test rather than by review, and it is the
      // sharpest lesson available about why the contract says a missing test
      // filter must fail closed: `readingTenant` is required by the type, so
      // the hole was invisible in TypeScript — and underneath, AuditIQ's
      // filter treats an undefined tenant as "no filter", which is correct for
      // a component holding one tenant's evidence and catastrophic for a
      // ledger holding many. A JavaScript host, a JSON body or a test double
      // supplies no types, and this is the boundary they reach.
      if (typeof readingTenant !== "string" || readingTenant.length === 0) return [];

      // The reading tenant OVERRIDES any tenant in the filter rather than
      // combining with it. A caller that could pass both would be a caller
      // that could ask for another tenant's entries and have the wider of the
      // two win — and which one wins is exactly the kind of thing that gets
      // refactored the wrong way later.
      return audit.query({ ...rest, tenant: readingTenant });
    },

    verify: () => audit.verify(),
    durability: () => audit.durability(),

    recordReplay(input) {
      replayCount += 1;
      const dryRun = input.dryRun ?? true;
      const result = audit.record({
        actionType: "replay",
        action: "execution.replayed",
        actor: { actorId: input.requestedBy, kind: "human" },
        tenant: input.tenant,
        component: "hive.platform.auditiq",
        governanceDecisionId: input.decisionId,
        outcome: "succeeded",
        reason: input.reason,
        trace: { correlationId: input.correlationId },
        detail: {
          // A NEW session id, recorded as such. A replay that reused the
          // original execution's identity would be indistinguishable from the
          // original in every later reading of this ledger — which is the one
          // thing a replay must never be.
          replaySessionId: input.replaySessionId,
          replayScope: input.scope,
          dryRun,
          replayOrdinal: replayCount,
          decidedAt: now().toISOString(),
        },
      });
      return result.accepted
        ? { written: true, sealed: result.sealed }
        : { written: false, reason: result.reason };
    },

    count: () => audit.count(),
  };
}

/**
 * The collective ledger.
 *
 * Takes no `InstanceIdentity` of a tenant's: it belongs to the collective, and
 * a collective ledger stamped with one instance's identity would be that
 * instance's ledger wearing a different name.
 */
export function createCollectiveLedger(options: {
  readonly collectiveId: InstanceIdentity;
  readonly store?: AuditStore;
  readonly now?: () => Date;
  readonly generateId?: () => string;
  readonly onRejected?: (reason: string, input: unknown) => void;
}): CollectiveLedger {
  const audit = createAuditIq({
    instance: options.collectiveId,
    ...(options.store ? { store: options.store } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.generateId ? { generateId: options.generateId } : {}),
    ...(options.onRejected ? { onRejected: options.onRejected } : {}),
  });
  const now = options.now ?? (() => new Date());

  const write = (record: Record<string, unknown>): LedgerWriteResult => {
    const result = audit.record(record);
    return result.accepted
      ? { written: true, sealed: result.sealed }
      : { written: false, reason: result.reason };
  };

  return {
    scope: "collective",

    append(input, entryClass) {
      const parsedClass = collectiveEntryClassSchema.safeParse(entryClass);
      if (!parsedClass.success) {
        return {
          written: false,
          reason:
            `"${String(entryClass)}" is not a collective entry class. The collective ledger holds ` +
            "constitutional, security, Foundry, release and escalated-incident history — never ordinary " +
            "operational execution, which belongs to the instance that performed it.",
        };
      }

      if (typeof input !== "object" || input === null) {
        return { written: false, reason: "A ledger entry must be an object." };
      }

      // An escalated incident may not be appended directly. It arrives through
      // `escalate`, which is where the six required pieces of provenance are
      // enforced — and a direct append would be the route around them.
      if (parsedClass.data === "escalated_incident") {
        return {
          written: false,
          reason:
            "An escalated incident is written by `escalate`, not appended. Appending one directly would " +
            "skip the reason, scope, approving policy, source references, sanitization status and closure " +
            "that make an escalation reviewable.",
        };
      }

      return write({
        ...(input as Record<string, unknown>),
        detail: {
          ...((input as { detail?: Record<string, string | number | boolean> }).detail ?? {}),
          collectiveClass: parsedClass.data,
        },
      });
    },

    escalate(input) {
      const parsed = escalationSchema.safeParse(input);
      if (!parsed.success) {
        return {
          written: false,
          reason: `Not a valid escalation: ${JSON.stringify(parsed.error.flatten())}`,
        };
      }
      const e = parsed.data;

      // References and digests. The source entries are NAMED, never copied —
      // an escalation that carried the records would make the collective
      // ledger a partial mirror of the instance's, one incident at a time.
      return write({
        actionType: "escalation",
        action: "incident.escalated",
        actor: { actorId: e.approvingPolicyId, kind: "service" },
        // The escalation belongs to the collective, and its tenant field names
        // the collective rather than the instance it came from: a collective
        // record scoped to one tenant would be readable as that tenant's data.
        tenant: { organizationId: "collective", roles: [] },
        component: "hive.platform.auditiq",
        governanceDecisionId: e.decisionId,
        policyId: e.approvingPolicyId,
        outcome: "succeeded",
        reason: e.reason,
        trace: { correlationId: e.escalationId },
        detail: {
          collectiveClass: "escalated_incident",
          escalationId: e.escalationId,
          escalationScope: e.scope,
          sanitizationStatus: e.sanitizationStatus,
          sourceInstances: [...new Set(e.sourceEntryRefs.map((r) => r.globalInstanceId))].join(","),
          sourceEntryIds: e.sourceEntryRefs.map((r) => r.auditEventId).join(","),
          sourceEntryHashes: e.sourceEntryRefs.map((r) => r.hash).join(","),
          ...(e.incidentAuthorization
            ? {
                incidentId: e.incidentAuthorization.incidentId,
                incidentAuthorizedBy: e.incidentAuthorization.authorizedBy,
              }
            : {}),
          ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}),
          ...(e.closedAt ? { closedAt: e.closedAt } : {}),
          escalatedAt: now().toISOString(),
        },
      });
    },

    read: (filter) => audit.query(filter),
    verify: () => audit.verify(),
    durability: () => audit.durability(),
    count: () => audit.count(),
  };
}

/**
 * Whether local retention deletion can reach the collective ledger.
 *
 * Always false, and the acceptance test the ledger architecture names last.
 * The two ledgers are separate stores with no operation spanning them: there
 * is no method on an `InstanceLedger` that takes a `CollectiveLedger`, and
 * neither has a delete at all. A tenant expiring its local history removes
 * nothing constitutional, because nothing constitutional was ever stored
 * inside the thing being expired.
 */
export function localRetentionErasesCollective(): false {
  return false;
}

/**
 * Whether a ledger entry authorizes anything.
 *
 * Always false. The sixteenth of these. A ledger records what authority was
 * established and by whom; reading the record back does not re-establish it,
 * which is the same distinction an audit record already draws by holding a
 * `governanceDecisionId` rather than a decision.
 */
export function ledgerEntryGrantsAuthority(): false {
  return false;
}
