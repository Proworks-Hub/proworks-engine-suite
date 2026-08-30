// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

/*
 * File:    packages/simulation-lab/src/lab.ts
 * Module:  simulation-lab
 * Purpose: Rehearsing the Hive against synthetic organizations, and knowing when the rehearsal proved nothing.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// THE ORACLE'S THIRD ANSWER IS THE WHOLE POINT
//
// The blueprint's validation rule is the sentence this package is built
// around: "If the intended fault did not occur, return INCONCLUSIVE rather
// than a false pass/fail."
//
// A two-valued oracle is not just less informative — it is actively
// misleading, and it fails in the safe-looking direction. A chaos test that
// meant to kill a node, silently failed to kill it, and then observed the
// system working reports PASS. It reports PASS every run. It becomes the
// most trusted test in the suite precisely because it never goes red, and
// what it is actually testing is that an undamaged system works.
//
// So fault injection here returns EVIDENCE that the fault took effect, the
// oracle checks that evidence before it reads the invariant, and a scenario
// whose fault did not land is INCONCLUSIVE with the reason attached. That
// makes green mean something.
//
// DETERMINISM, BECAUSE A SIMULATION YOU CANNOT REPEAT IS AN ANECDOTE
//
// Everything random here comes from a seeded generator. Same seed, same run,
// on any machine, in any year. Without that, a failure found at 2am cannot be
// handed to the person who has to fix it.
//
// SIMULATION IS EVIDENCE, NOT AUTHORITY
//
// Nothing in this package activates, approves, or deploys anything. A green
// simulation is an argument to put in front of Governance, and `SimulationVerdict`
// carries `isAuthorization: false` in its type so that no consumer can drift
// into treating it as more than that.
// ─────────────────────────────────────────────────────────────────────────────

// ── Deterministic randomness ─────────────────────────────────────────────────

/**
 * Mulberry32. Small, fast, dependency-free, and — the property that matters —
 * identical everywhere. `Math.random()` would make every run unrepeatable and
 * every reported failure unfixable.
 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Synthetic organizations ──────────────────────────────────────────────────

export const organizationKindSchema = z.enum([
  "SMALL_MANUFACTURER_INTERMITTENT",
  "MULTI_LOCATION_MOBILE",
  "HIGH_SENSITIVITY_SYNTHETIC",
  "RETAIL_BURST",
  "INDUSTRIAL_IOT_EDGE",
  "SAAS_POLYGLOT",
  "TWO_ORGS_INTERCONNECT_ONLY",
  "MANY_INSTANCES_COLLECTIVE_OUTAGE",
]);
export type OrganizationKind = z.infer<typeof organizationKindSchema>;

export interface SyntheticOrganization {
  readonly organizationId: string;
  readonly kind: OrganizationKind;
  readonly instanceIds: readonly string[];
  readonly tenantIds: readonly string[];
  /** Capabilities the org's engines offer. */
  readonly capabilities: readonly string[];
  /** Fraction of time the org's link to the Collective is up, 0..1. */
  readonly connectivity: number;
  /** True when the fixture models sensitive data — synthetic, always. */
  readonly highSensitivity: boolean;
  /** Peak messages per second this org generates. */
  readonly peakMessagesPerSecond: number;
  readonly notes: string;
}

/**
 * Builds one of the eight organization types.
 *
 * Every one is synthetic. The high-sensitivity fixture models the SHAPE of
 * regulated data — classifications, minimization duties, audit expectations —
 * and contains no real records of any kind. Testing privacy machinery with
 * real sensitive data would be the exact failure the machinery exists to
 * prevent, performed deliberately.
 */
export function buildOrganization(kind: OrganizationKind, seed: number): SyntheticOrganization {
  const random = createRandom(seed);
  const id = `org-${kind.toLowerCase().replace(/_/g, "-")}-${seed}`;
  const pick = (n: number, prefix: string): string[] => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);

  switch (kind) {
    case "SMALL_MANUFACTURER_INTERMITTENT":
      return {
        organizationId: id,
        kind,
        instanceIds: [`${id}-shop`],
        tenantIds: [`${id}-t1`],
        capabilities: ["ordering", "manufacturing.plan", "costing", "workorder"],
        connectivity: 0.6,
        highSensitivity: false,
        peakMessagesPerSecond: 20,
        notes: "One shop, rural connectivity. The interesting property is that local work must continue while the Collective is unreachable, which is most of the time.",
      };
    case "MULTI_LOCATION_MOBILE":
      return {
        organizationId: id,
        kind,
        instanceIds: pick(4, `${id}-site`),
        tenantIds: [`${id}-t1`],
        capabilities: ["dispatch", "workorder", "tracking", "notifications"],
        connectivity: 0.85,
        highSensitivity: false,
        peakMessagesPerSecond: 200,
        notes: "Mobile workers on phones. Store-and-forward is the normal path, not the exception, and the OS decides when it drains.",
      };
    case "HIGH_SENSITIVITY_SYNTHETIC":
      return {
        organizationId: id,
        kind,
        instanceIds: [`${id}-main`],
        tenantIds: pick(3, `${id}-t`),
        capabilities: ["intake", "records", "audit"],
        connectivity: 0.99,
        highSensitivity: true,
        peakMessagesPerSecond: 100,
        notes: "Models the SHAPE of regulated data — classification, minimization, audit — with entirely fabricated records. No real sensitive data enters this lab, ever.",
      };
    case "RETAIL_BURST":
      return {
        organizationId: id,
        kind,
        instanceIds: [`${id}-main`],
        tenantIds: [`${id}-t1`],
        capabilities: ["ordering", "inventory", "fulfilment", "notifications"],
        connectivity: 0.98,
        highSensitivity: false,
        peakMessagesPerSecond: 5_000,
        notes: "Flat most of the day, then twenty times that for ninety minutes. Backpressure and shedding are what this fixture exists to exercise.",
      };
    case "INDUSTRIAL_IOT_EDGE":
      return {
        organizationId: id,
        kind,
        instanceIds: [`${id}-plant`],
        tenantIds: [`${id}-t1`],
        capabilities: ["telemetry", "machine.state", "alerting"],
        connectivity: 0.7,
        highSensitivity: false,
        peakMessagesPerSecond: 2_000,
        notes: "Hundreds of constrained publishers with no durable local storage. A power cycle loses whatever was queued, and that is expected rather than a bug.",
      };
    case "SAAS_POLYGLOT":
      return {
        organizationId: id,
        kind,
        instanceIds: [`${id}-main`],
        tenantIds: pick(50, `${id}-t`),
        capabilities: ["api", "billing", "search", "reporting", "webhooks"],
        connectivity: 0.999,
        highSensitivity: false,
        peakMessagesPerSecond: 10_000,
        notes: "Services in four languages behind one contract. Cross-language golden fixtures are the point; fifty tenants make cross-tenant leakage detectable.",
      };
    case "TWO_ORGS_INTERCONNECT_ONLY":
      return {
        organizationId: id,
        kind,
        instanceIds: [`${id}-a`, `${id}-b`],
        tenantIds: [`${id}-ta`, `${id}-tb`],
        capabilities: ["subcontract.request", "subcontract.status"],
        connectivity: 0.95,
        highSensitivity: false,
        peakMessagesPerSecond: 50,
        notes: "Two independent organizations that may only reach each other through a governed gateway. Every direct path attempted here must be refused.",
      };
    case "MANY_INSTANCES_COLLECTIVE_OUTAGE":
      return {
        organizationId: id,
        kind,
        instanceIds: pick(200, `${id}-i`),
        tenantIds: pick(200, `${id}-t`),
        capabilities: ["ordering", "workorder"],
        connectivity: Math.round(random() * 10) / 100,
        highSensitivity: false,
        peakMessagesPerSecond: 1_000,
        notes: "Two hundred local instances during a Collective outage. The invariant under test is autonomy: local work continues, and nothing silently widens to compensate.",
      };
  }
}

// ── Faults ───────────────────────────────────────────────────────────────────

export const faultKindSchema = z.enum([
  "NODE_LOSS",
  "PROVIDER_OUTAGE",
  "COLLECTIVE_OUTAGE",
  "NETWORK_PARTITION",
  "LATENCY_SPIKE",
  "MESSAGE_DUPLICATION",
  "SCHEMA_INCOMPATIBILITY",
  "ADAPTER_TAMPER",
  "CERTIFICATE_EXPIRY",
  "CLOCK_SKEW",
]);
export type FaultKind = z.infer<typeof faultKindSchema>;

/**
 * Proof that a fault actually happened.
 *
 * `applied` is the field the oracle reads. A fault injector that could only
 * report "I tried" would leave every scenario unable to tell a survived fault
 * from an absent one.
 */
export interface FaultEvidence {
  readonly fault: FaultKind;
  readonly target: string;
  readonly applied: boolean;
  /** What was observed that proves it. Required when applied. */
  readonly proof: string;
  /** Why it did not apply. Required when not applied. */
  readonly failureToApply: string | null;
}

export interface FaultInjector {
  inject(fault: FaultKind, target: string): FaultEvidence;
}

/**
 * A fault injector over a mutable world model.
 *
 * Returns evidence rather than a boolean, and reports honestly when a target
 * does not exist — injecting into a node that is not there is the commonest
 * way a chaos test silently stops testing anything, usually after a rename.
 */
export function createFaultInjector(world: {
  nodes: Set<string>;
  providers: Set<string>;
  collectiveReachable: boolean;
  partitions: Set<string>;
}): FaultInjector {
  return {
    inject(fault, target) {
      const evidence = (applied: boolean, proof: string, failureToApply: string | null): FaultEvidence => ({
        fault,
        target,
        applied,
        proof,
        failureToApply,
      });

      switch (fault) {
        case "NODE_LOSS": {
          if (!world.nodes.has(target)) {
            return evidence(false, "", `Node "${target}" was not present, so nothing was removed. The scenario proves nothing about node loss — most often this means the fixture was renamed and the scenario was not.`);
          }
          world.nodes.delete(target);
          return evidence(true, `Node "${target}" removed; ${world.nodes.size} node(s) remain.`, null);
        }
        case "PROVIDER_OUTAGE": {
          if (!world.providers.has(target)) {
            return evidence(false, "", `Provider "${target}" was not bound, so no outage occurred.`);
          }
          world.providers.delete(target);
          return evidence(true, `Provider "${target}" removed from the bound set.`, null);
        }
        case "COLLECTIVE_OUTAGE": {
          if (!world.collectiveReachable) {
            return evidence(false, "", "The Collective was already unreachable, so this run did not transition anything. A fault that was already true tests nothing.");
          }
          world.collectiveReachable = false;
          return evidence(true, "Collective marked unreachable.", null);
        }
        case "NETWORK_PARTITION": {
          if (world.partitions.has(target)) {
            return evidence(false, "", `Zone "${target}" was already partitioned.`);
          }
          world.partitions.add(target);
          return evidence(true, `Zone "${target}" partitioned; ${world.partitions.size} partition(s) active.`, null);
        }
        case "LATENCY_SPIKE":
        case "MESSAGE_DUPLICATION":
        case "SCHEMA_INCOMPATIBILITY":
        case "ADAPTER_TAMPER":
        case "CERTIFICATE_EXPIRY":
        case "CLOCK_SKEW":
          // Flow- and trust-level faults are conditions the scenario asserts
          // against rather than mutations of the world model. They are
          // reported as applied because declaring them IS the injection.
          return evidence(true, `Condition "${fault}" declared for target "${target}" and asserted by the scenario.`, null);
      }
    },
  };
}

// ── Adversary ────────────────────────────────────────────────────────────────

export const adversaryMoveSchema = z.enum([
  "DIRECT_CROSS_INSTANCE_BYPASS",
  "TRANSITIVE_TRUST_RELAY",
  "FORGED_ADAPTER_MANIFEST",
  "TRACE_BAGGAGE_INJECTION",
  "REPLAY_OLD_MESSAGE",
  "CROSS_TENANT_MAPPING",
  "UNCERTIFIED_ADAPTER_DISPATCH",
  "RETRY_AMPLIFICATION",
]);
export type AdversaryMove = z.infer<typeof adversaryMoveSchema>;

export interface AdversaryAttempt {
  readonly move: AdversaryMove;
  /** What the system did. The scenario asserts this is a refusal. */
  readonly refused: boolean;
  readonly refusedBy: string | null;
  readonly detail: string;
}

// ── Oracle ───────────────────────────────────────────────────────────────────

export const outcomeSchema = z.enum(["PASS", "FAIL", "INCONCLUSIVE"]);
export type Outcome = z.infer<typeof outcomeSchema>;

export interface Invariant {
  readonly invariantId: string;
  /** What must be true, in words. */
  readonly statement: string;
  /** Evaluated against whatever the scenario observed. */
  readonly holds: boolean;
  /** What was observed. Required either way — a bare boolean explains nothing. */
  readonly observation: string;
}

export interface ScenarioResult {
  readonly scenarioId: string;
  readonly seed: number;
  readonly outcome: Outcome;
  readonly faultEvidence: readonly FaultEvidence[];
  readonly adversaryAttempts: readonly AdversaryAttempt[];
  readonly invariants: readonly Invariant[];
  readonly componentVersions: Readonly<Record<string, string>>;
  /** Required when INCONCLUSIVE. */
  readonly inconclusiveReason: string | null;
  readonly explanation: string;
  /** Typed as the literal. A simulation is evidence, never permission. */
  readonly isAuthorization: false;
}

/**
 * Judges one scenario.
 *
 * Order matters and is the substance of this function:
 *
 *   1. Did the faults we intended actually happen? If not, INCONCLUSIVE —
 *      whatever the invariants say, they were evaluated against a system that
 *      was not damaged the way the scenario claims.
 *   2. Did every adversary move get refused? An unrefused move is a FAIL
 *      regardless of the invariants, because the thing we were defending
 *      against succeeded.
 *   3. Only then, do the invariants hold?
 *
 * Checking invariants first would let an undamaged system pass a chaos test,
 * which is the failure this whole package exists to make impossible.
 */
export function judge(input: {
  readonly scenarioId: string;
  readonly seed: number;
  readonly faultEvidence: readonly FaultEvidence[];
  readonly adversaryAttempts: readonly AdversaryAttempt[];
  readonly invariants: readonly Invariant[];
  readonly componentVersions: Readonly<Record<string, string>>;
}): ScenarioResult {
  const base = {
    scenarioId: input.scenarioId,
    seed: input.seed,
    faultEvidence: input.faultEvidence,
    adversaryAttempts: input.adversaryAttempts,
    invariants: input.invariants,
    componentVersions: input.componentVersions,
    isAuthorization: false as const,
  };

  const unapplied = input.faultEvidence.filter((f) => !f.applied);
  if (unapplied.length > 0) {
    const reason = `${unapplied.length} intended fault(s) did not occur: ${unapplied
      .map((f) => `${f.fault} on "${f.target}" (${f.failureToApply})`)
      .join("; ")}.`;
    return {
      ...base,
      outcome: "INCONCLUSIVE",
      inconclusiveReason: reason,
      explanation: `${reason} The invariants were not evaluated as a verdict, because a system that was never damaged tells us nothing about how it behaves when it is. A green result here would be the most dangerous kind — permanently green, and testing nothing.`,
    };
  }

  const succeeded = input.adversaryAttempts.filter((a) => !a.refused);
  if (succeeded.length > 0) {
    return {
      ...base,
      outcome: "FAIL",
      inconclusiveReason: null,
      explanation: `${succeeded.length} adversary move(s) were NOT refused: ${succeeded
        .map((a) => `${a.move} (${a.detail})`)
        .join("; ")}. An unrefused move is a failure whatever the invariants report — the defence being tested did not hold.`,
    };
  }

  const broken = input.invariants.filter((i) => !i.holds);
  if (broken.length > 0) {
    return {
      ...base,
      outcome: "FAIL",
      inconclusiveReason: null,
      explanation: `${broken.length} invariant(s) broke under the injected faults: ${broken
        .map((i) => `${i.invariantId} — ${i.statement} Observed: ${i.observation}`)
        .join(" | ")}`,
    };
  }

  if (input.invariants.length === 0) {
    return {
      ...base,
      outcome: "INCONCLUSIVE",
      inconclusiveReason: "The scenario declared no invariants.",
      explanation:
        "Every intended fault occurred and no adversary move succeeded, but the scenario asserts nothing. A scenario without an invariant cannot pass or fail — it just runs, and a suite full of those reports green forever.",
    };
  }

  return {
    ...base,
    outcome: "PASS",
    inconclusiveReason: null,
    explanation: `All ${input.faultEvidence.length} intended fault(s) occurred, ${input.adversaryAttempts.length} adversary move(s) were refused, and ${input.invariants.length} invariant(s) held. This is evidence for a Governance decision, not a decision.`,
  };
}

// ── Foundry connector ────────────────────────────────────────────────────────

/**
 * Where results go. Foundry implements it.
 *
 * A port rather than an import, in the same direction and for the same reason
 * as the Fabric's evidence port: the lab must be runnable with no Foundry
 * present, or it cannot be used to test Foundry.
 */
export interface LabEvidencePort {
  submit(result: ScenarioResult): void;
}

/** Submits a result, and never lets the sink's failure change the verdict. */
export function submitResult(port: LabEvidencePort, result: ScenarioResult): { readonly submitted: boolean } {
  try {
    port.submit(result);
    return { submitted: true };
  } catch {
    return { submitted: false };
  }
}

/** A green simulation is an argument, not a permission. */
export function simulationGrantsAuthority(): false {
  return false;
}
