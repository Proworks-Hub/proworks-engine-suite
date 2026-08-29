// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Evidence } from "../evidence/evidence.js";
import type { InvariantDetector } from "./invariants.js";

// ─────────────────────────────────────────────────────────────────────────────
// Extended invariant detectors.
//
// The baseline set covered 5 of the catalog's 26, and that was the limiting
// factor on how much any diagnosis could conclude — 21 invariants returning
// NOT_ASSESSED forces human review on almost every run.
//
// WHAT MAKES A DETECTOR HONEST
//
// Every detector here decides from flat evidence FACTS that an executor
// recorded. None infers from a scenario annotation, a fault class, or a test
// title (§8). Every one returns null when the fact it needs is absent, which is
// different from returning HELD — a detector that reports HELD when it found
// nothing converts absence of evidence into evidence of compliance.
//
// WHAT IS DELIBERATELY STILL MISSING
//
// Five of the 26 are NOT implemented and will keep reporting NOT_ASSESSED:
//
//   APPROVAL        needs to know which version was approved, which is domain
//                   state this subsystem does not hold
//   ASSET-LINEAGE   needs the asset derivation graph
//   CHARTER         needs behaviour compared against charter text
//   CONSTITUTION    needs behaviour compared against constitutional meaning
//   PORTABILITY     needs dependency and import analysis rather than runtime
//                   evidence — the drift detector answers this, not a runtime
//                   invariant
//
// They are listed in `UNDETECTABLE_INVARIANTS` at the foot of this file with
// their reasons, and a test asserts that every catalog entry is either detected
// or named there. Naming them is the point: a catalog where 21 are checked and
// 5 are openly unchecked is honest; one where all 26 report HELD because nobody
// looked is not.
// ─────────────────────────────────────────────────────────────────────────────

/** Evidence carrying a fact of a given type. */
function withStringFact(evidence: readonly Evidence[], fact: string) {
  return evidence.filter((e) => typeof e.facts[fact] === "string");
}

function withBoolFact(evidence: readonly Evidence[], fact: string) {
  return evidence.filter((e) => typeof e.facts[fact] === "boolean");
}

const ids = (evidence: readonly Evidence[]) => evidence.map((e) => e.evidenceId);

/**
 * HIVE-INV-GOVERNANCE-ORDER-001 — Governance decides before the action.
 *
 * Constitution §1.9. Distinct from AUTHORITY-001, which asks whether a decision
 * existed at all: this asks whether it came FIRST. A system that authorizes
 * after acting has an audit trail and no gate.
 */
export const governanceOrderDetector: InvariantDetector = {
  invariantId: "HIVE-INV-GOVERNANCE-ORDER-001",
  name: "governance-precedes-action",
  detect(evidence) {
    const decisions = evidence.filter((e) => e.kind === "governance_decision");
    const actions = evidence.filter((e) => e.facts.consequential === true);
    if (decisions.length === 0 || actions.length === 0) return null;

    // Ordering by recorded time. Requires both to carry one, which they do —
    // `observedAt` is mandatory on every piece of evidence.
    const earliestDecision = decisions
      .map((e) => new Date(e.observedAt).getTime())
      .sort((a, b) => a - b)[0]!;

    const premature = actions.filter((e) => new Date(e.observedAt).getTime() < earliestDecision);

    if (premature.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: [...ids(premature), ...ids(decisions)],
        confidence: "confirmed",
        detail: `${premature.length} consequential action(s) occurred before the first Governance decision. Authorizing after acting produces an audit trail and no gate.`,
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: [...ids(actions), ...ids(decisions)],
      confidence: "confirmed",
      detail: "Every consequential action followed a Governance decision.",
    };
  },
};

/**
 * HIVE-INV-OWNERSHIP-001 — only the owning engine writes its entities.
 *
 * The general form of PRIME-OWNERSHIP-001. Needs the executor to record both
 * what was persisted and who owns that entity type.
 */
export const ownershipDetector: InvariantDetector = {
  invariantId: "HIVE-INV-OWNERSHIP-001",
  name: "owner-writes-only",
  detect(evidence) {
    const writes = evidence.filter(
      (e) => typeof e.facts.persistedEntity === "string" && typeof e.facts.entityOwner === "string",
    );
    if (writes.length === 0) return null;

    const trespassing = writes.filter((e) => e.componentId !== e.facts.entityOwner);

    if (trespassing.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: ids(trespassing),
        confidence: "confirmed",
        detail: trespassing
          .map(
            (e) =>
              `${e.componentId} wrote ${String(e.facts.persistedEntity)}, which ${String(e.facts.entityOwner)} owns`,
          )
          .join("; "),
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: ids(writes),
      confidence: "confirmed",
      detail: `${writes.length} write(s), each by the owning engine.`,
    };
  },
};

/**
 * HIVE-INV-NO-DUPLICATION-001 — one source produces one entity.
 *
 * Needs the executor to record the source key an entity was created from.
 */
export const noDuplicationDetector: InvariantDetector = {
  invariantId: "HIVE-INV-NO-DUPLICATION-001",
  name: "one-source-one-entity",
  detect(evidence) {
    const creations = withStringFact(evidence, "createdFromSourceKey");
    if (creations.length === 0) return null;

    const bySource = new Map<string, Evidence[]>();
    for (const e of creations) {
      const key = String(e.facts.createdFromSourceKey);
      bySource.set(key, [...(bySource.get(key) ?? []), e]);
    }

    const duplicated = [...bySource.entries()].filter(([, list]) => list.length > 1);

    if (duplicated.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: duplicated.flatMap(([, list]) => ids(list)),
        confidence: "confirmed",
        detail: duplicated
          .map(([key, list]) => `source ${key} produced ${list.length} entities`)
          .join("; "),
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: ids(creations),
      confidence: "confirmed",
      detail: `${bySource.size} source(s), one entity each.`,
    };
  },
};

/**
 * HIVE-INV-VERSION-LINEAGE-001 — producer and consumer agree on the contract.
 *
 * Needs both sides to record the contract version they used.
 */
export const versionLineageDetector: InvariantDetector = {
  invariantId: "HIVE-INV-VERSION-LINEAGE-001",
  name: "contract-version-agreement",
  detect(evidence) {
    const versioned = evidence.filter(
      (e) => typeof e.facts.contractName === "string" && typeof e.facts.contractVersion === "string",
    );
    if (versioned.length < 2) return null;

    const byContract = new Map<string, Set<string>>();
    for (const e of versioned) {
      const name = String(e.facts.contractName);
      const set = byContract.get(name) ?? new Set<string>();
      set.add(String(e.facts.contractVersion));
      byContract.set(name, set);
    }

    const disagreeing = [...byContract.entries()].filter(([, versions]) => versions.size > 1);

    if (disagreeing.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: ids(versioned),
        confidence: "confirmed",
        detail: disagreeing
          .map(([name, versions]) => `${name} used at versions ${[...versions].sort().join(" and ")}`)
          .join("; "),
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: ids(versioned),
      confidence: "confirmed",
      detail: `${byContract.size} contract(s), one version each.`,
    };
  },
};

/**
 * HIVE-INV-PROVENANCE-001 — derived data names what it was derived from.
 *
 * A figure with no stated source cannot be checked, corrected, or explained
 * later, and will eventually be treated as authoritative by something.
 */
export const provenanceDetector: InvariantDetector = {
  invariantId: "HIVE-INV-PROVENANCE-001",
  name: "derived-data-names-its-source",
  detect(evidence) {
    const derived = withBoolFact(evidence, "isDerived").filter((e) => e.facts.isDerived === true);
    if (derived.length === 0) return null;

    const unsourced = derived.filter((e) => typeof e.facts.derivedFrom !== "string");

    if (unsourced.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: ids(unsourced),
        confidence: "confirmed",
        detail: `${unsourced.length} derived value(s) name no source. A figure with no provenance cannot be checked or corrected, and will eventually be treated as authoritative.`,
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: ids(derived),
      confidence: "confirmed",
      detail: `${derived.length} derived value(s), each naming its source.`,
    };
  },
};

/**
 * HIVE-INV-DATA-MINIMIZATION-001 — protected material is not copied around.
 *
 * Decidable directly from the evidence store's own contents: restricted or
 * secret evidence carrying extracted facts is protected material leaving its
 * boundary one field at a time.
 */
export const dataMinimizationDetector: InvariantDetector = {
  invariantId: "HIVE-INV-DATA-MINIMIZATION-001",
  name: "protected-material-referenced-not-copied",
  detect(evidence) {
    const protectedEvidence = evidence.filter(
      (e) => e.sensitivity === "restricted" || e.sensitivity === "secret",
    );
    if (protectedEvidence.length === 0) return null;

    const leaking = protectedEvidence.filter((e) => Object.keys(e.facts).length > 0);

    if (leaking.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: ids(leaking),
        confidence: "confirmed",
        detail: `${leaking.length} piece(s) of protected evidence carry extracted facts rather than only a reference.`,
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: ids(protectedEvidence),
      confidence: "confirmed",
      detail: `${protectedEvidence.length} piece(s) of protected evidence, referenced without extraction.`,
    };
  },
};

/**
 * HIVE-INV-FINANCIAL-INTEGRITY-001 — money figures agree across the hop.
 *
 * Needs producer and consumer to record the same figure under the same label.
 * Compared to the cent, deliberately: a tolerance here is how a rounding
 * difference becomes a reconciliation problem nobody can find.
 */
export const financialIntegrityDetector: InvariantDetector = {
  invariantId: "HIVE-INV-FINANCIAL-INTEGRITY-001",
  name: "monetary-agreement-across-hops",
  detect(evidence) {
    const monetary = evidence.filter(
      (e) => typeof e.facts.monetaryLabel === "string" && typeof e.facts.amountMinor === "number",
    );
    if (monetary.length < 2) return null;

    const byLabel = new Map<string, Set<number>>();
    for (const e of monetary) {
      const label = String(e.facts.monetaryLabel);
      const set = byLabel.get(label) ?? new Set<number>();
      set.add(Number(e.facts.amountMinor));
      byLabel.set(label, set);
    }

    const disagreeing = [...byLabel.entries()].filter(([, amounts]) => amounts.size > 1);

    if (disagreeing.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: ids(monetary),
        confidence: "confirmed",
        detail: disagreeing
          .map(([label, amounts]) => `${label} recorded as ${[...amounts].sort((a, b) => a - b).join(" and ")} minor units`)
          .join("; "),
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: ids(monetary),
      confidence: "confirmed",
      detail: `${byLabel.size} monetary figure(s), consistent across every hop that recorded them.`,
    };
  },
};

/**
 * HIVE-INV-INVENTORY-001 — stock is conserved.
 *
 * on-hand must equal available + reserved. Needs all three recorded together.
 * The classic failure is a reservation that decrements on-hand as well, which
 * this catches as arithmetic rather than as a story about intent.
 */
export const inventoryConservationDetector: InvariantDetector = {
  invariantId: "HIVE-INV-INVENTORY-001",
  name: "stock-conservation",
  detect(evidence) {
    const snapshots = evidence.filter(
      (e) =>
        typeof e.facts.onHand === "number" &&
        typeof e.facts.available === "number" &&
        typeof e.facts.reserved === "number",
    );
    if (snapshots.length === 0) return null;

    const broken = snapshots.filter(
      (e) => Number(e.facts.onHand) !== Number(e.facts.available) + Number(e.facts.reserved),
    );

    if (broken.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: ids(broken),
        confidence: "confirmed",
        detail: broken
          .map(
            (e) =>
              `on-hand ${String(e.facts.onHand)} != available ${String(e.facts.available)} + reserved ${String(e.facts.reserved)}`,
          )
          .join("; "),
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: ids(snapshots),
      confidence: "confirmed",
      detail: `${snapshots.length} inventory snapshot(s), each conserving stock.`,
    };
  },
};

/**
 * HIVE-INV-LIFECYCLE-001 — state moves along declared edges.
 *
 * Needs the executor to record each transition AND whether the edge is
 * declared. Asking this module to know every engine's state machine would be
 * inventing domain knowledge it does not have.
 */
export const lifecycleDetector: InvariantDetector = {
  invariantId: "HIVE-INV-LIFECYCLE-001",
  name: "declared-transitions-only",
  detect(evidence) {
    const transitions = evidence.filter(
      (e) =>
        typeof e.facts.transitionFrom === "string" &&
        typeof e.facts.transitionTo === "string" &&
        typeof e.facts.transitionDeclared === "boolean",
    );
    if (transitions.length === 0) return null;

    const undeclared = transitions.filter((e) => e.facts.transitionDeclared === false);

    if (undeclared.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: ids(undeclared),
        confidence: "confirmed",
        detail: undeclared
          .map((e) => `${String(e.facts.transitionFrom)} -> ${String(e.facts.transitionTo)} is not a declared edge`)
          .join("; "),
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: ids(transitions),
      confidence: "confirmed",
      detail: `${transitions.length} transition(s), all along declared edges.`,
    };
  },
};

/**
 * HIVE-INV-DEGRADED-001 — a degraded component says so.
 *
 * The failure this catches is the worst kind: a component that has lost a
 * dependency and returns a confident answer anyway. Silent degradation is
 * worse than an outage, because nobody responds to it.
 */
export const degradedHonestyDetector: InvariantDetector = {
  invariantId: "HIVE-INV-DEGRADED-001",
  name: "degradation-is-declared",
  detect(evidence) {
    const answers = withBoolFact(evidence, "answeredSuccessfully");
    const degradedFlags = withBoolFact(evidence, "operatingDegraded");
    if (answers.length === 0 || degradedFlags.length === 0) return null;

    const degradedComponents = new Set(
      degradedFlags.filter((e) => e.facts.operatingDegraded === true).map((e) => e.componentId),
    );
    if (degradedComponents.size === 0) {
      return {
        verdict: "HELD",
        evidenceIds: ids(degradedFlags),
        confidence: "confirmed",
        detail: "No component reported degraded operation.",
      };
    }

    const silentlyConfident = answers.filter(
      (e) =>
        degradedComponents.has(e.componentId) &&
        e.facts.answeredSuccessfully === true &&
        e.facts.resultMarkedDegraded !== true,
    );

    if (silentlyConfident.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: ids(silentlyConfident),
        confidence: "confirmed",
        detail: `${silentlyConfident.length} answer(s) from a degraded component were returned without being marked degraded. Silent degradation is worse than an outage, because nobody responds to it.`,
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: [...ids(answers), ...ids(degradedFlags)],
      confidence: "confirmed",
      detail: "Every answer from a degraded component was marked as such.",
    };
  },
};

/**
 * HIVE-INV-FAILURE-ISOLATION-001 — a failure stays in its blast radius.
 *
 * Needs the executor to record which component failed and which components
 * subsequently failed as a result.
 */
export const failureIsolationDetector: InvariantDetector = {
  invariantId: "HIVE-INV-FAILURE-ISOLATION-001",
  name: "failure-does-not-cascade",
  detect(evidence) {
    const failures = withBoolFact(evidence, "componentFailed").filter(
      (e) => e.facts.componentFailed === true,
    );
    if (failures.length === 0) return null;

    const cascaded = failures.filter((e) => e.facts.failedBecauseUpstreamFailed === true);
    // One originating failure plus cascades is expected; what is not expected
    // is a cascade that nothing declared as isolated.
    const uncontained = cascaded.filter((e) => e.facts.containedByDeclaredBoundary !== true);

    if (uncontained.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: ids(uncontained),
        confidence: "probable",
        detail: `${uncontained.length} component(s) failed as a consequence of an upstream failure without a declared containment boundary. Confidence is probable rather than confirmed: a missing boundary declaration and a genuine cascade look the same from here.`,
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: ids(failures),
      confidence: "confirmed",
      detail: `${failures.length} failure(s), each contained.`,
    };
  },
};

/**
 * HIVE-INV-TRUSTED-IDENTITY-001 — a consequential action names its actor.
 *
 * Distinct from AUTHORITY: this asks WHO, not WHETHER. An authorized action by
 * an unnamed actor is unattributable afterwards.
 */
export const trustedIdentityDetector: InvariantDetector = {
  invariantId: "HIVE-INV-TRUSTED-IDENTITY-001",
  name: "consequential-actions-name-an-actor",
  detect(evidence) {
    const consequential = evidence.filter((e) => e.facts.consequential === true);
    if (consequential.length === 0) return null;

    const anonymous = consequential.filter((e) => typeof e.facts.actorId !== "string");

    if (anonymous.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: ids(anonymous),
        confidence: "confirmed",
        detail: `${anonymous.length} consequential action(s) name no actor. An authorized action by an unnamed actor is unattributable afterwards.`,
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: ids(consequential),
      confidence: "confirmed",
      detail: "Every consequential action names its actor.",
    };
  },
};

/**
 * HIVE-INV-RECOVERY-001 — after a failure, state is restored or declared.
 *
 * The half-finished workflow is the thing this catches: a failure that left
 * some writes committed and some not, with nothing recording which.
 */
export const recoveryDetector: InvariantDetector = {
  invariantId: "HIVE-INV-RECOVERY-001",
  name: "no-silent-partial-state",
  detect(evidence) {
    const partials = withBoolFact(evidence, "partialWriteOccurred").filter(
      (e) => e.facts.partialWriteOccurred === true,
    );
    if (partials.length === 0) return null;

    const unresolved = partials.filter(
      (e) => e.facts.compensated !== true && e.facts.markedIncomplete !== true,
    );

    if (unresolved.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: ids(unresolved),
        confidence: "confirmed",
        detail: `${unresolved.length} partial write(s) were neither compensated nor marked incomplete. A half-finished workflow that looks finished is the hardest kind of failure to find later.`,
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: ids(partials),
      confidence: "confirmed",
      detail: `${partials.length} partial write(s), each compensated or explicitly marked incomplete.`,
    };
  },
};

/**
 * HIVE-INV-NO-BLIND-REPLAY-001 — replay requires idempotency or authorization.
 *
 * Replaying events to rebuild state is legitimate and useful. Replaying them
 * into consumers that will act on them again is how a recovery causes a second
 * incident.
 */
export const noBlindReplayDetector: InvariantDetector = {
  invariantId: "HIVE-INV-NO-BLIND-REPLAY-001",
  name: "replay-is-guarded",
  detect(evidence) {
    const replays = withBoolFact(evidence, "isReplay").filter((e) => e.facts.isReplay === true);
    if (replays.length === 0) return null;

    const unguarded = replays.filter(
      (e) => e.facts.consumerIsIdempotent !== true && typeof e.facts.replayAuthorizedBy !== "string",
    );

    if (unguarded.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: ids(unguarded),
        confidence: "confirmed",
        detail: `${unguarded.length} replayed event(s) reached a consumer that is neither idempotent nor covered by a replay authorization. A recovery that causes a second incident is not a recovery.`,
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: ids(replays),
      confidence: "confirmed",
      detail: `${replays.length} replayed event(s), each guarded.`,
    };
  },
};

/**
 * HIVE-INV-VALIDATION-001 — input is validated before consequential use.
 *
 * Needs the executor to record whether the input that drove an action was
 * validated first.
 */
export const inputValidationDetector: InvariantDetector = {
  invariantId: "HIVE-INV-VALIDATION-001",
  name: "validate-before-acting",
  detect(evidence) {
    const consequential = evidence.filter(
      (e) => e.facts.consequential === true && typeof e.facts.inputValidated === "boolean",
    );
    if (consequential.length === 0) return null;

    const unvalidated = consequential.filter((e) => e.facts.inputValidated === false);

    if (unvalidated.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: ids(unvalidated),
        confidence: "confirmed",
        detail: `${unvalidated.length} consequential action(s) proceeded on unvalidated input.`,
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: ids(consequential),
      confidence: "confirmed",
      detail: "Every consequential action validated its input first.",
    };
  },
};

/**
 * HIVE-INV-RESOURCE-INTEGRITY-001 — a resource is not committed twice.
 *
 * Double-booking a machine or a person, which is arithmetic once the executor
 * records the reservations.
 */
export const resourceIntegrityDetector: InvariantDetector = {
  invariantId: "HIVE-INV-RESOURCE-INTEGRITY-001",
  name: "no-double-booking",
  detect(evidence) {
    const reservations = evidence.filter(
      (e) => typeof e.facts.resourceId === "string" && typeof e.facts.reservedForWindow === "string",
    );
    if (reservations.length === 0) return null;

    const seen = new Map<string, Evidence[]>();
    for (const e of reservations) {
      const key = `${String(e.facts.resourceId)}@${String(e.facts.reservedForWindow)}`;
      seen.set(key, [...(seen.get(key) ?? []), e]);
    }

    const clashing = [...seen.entries()].filter(([, list]) => list.length > 1);

    if (clashing.length > 0) {
      return {
        verdict: "VIOLATED",
        evidenceIds: clashing.flatMap(([, list]) => ids(list)),
        confidence: "confirmed",
        detail: clashing.map(([key, list]) => `${key} reserved ${list.length} times`).join("; "),
      };
    }

    return {
      verdict: "HELD",
      evidenceIds: ids(reservations),
      confidence: "confirmed",
      detail: `${seen.size} reservation(s), no clash.`,
    };
  },
};

/**
 * Invariants nothing here can decide, and why.
 *
 * Exported so the gap is queryable rather than folklore. A caller assembling a
 * classifier can report exactly which invariants will come back NOT_ASSESSED
 * and what it would take to change that.
 */
export const UNDETECTABLE_INVARIANTS: Readonly<Record<string, string>> = Object.freeze({
  "HIVE-INV-APPROVAL-001":
    "Needs to know which version was approved, which is domain state this subsystem does not hold.",
  "HIVE-INV-ASSET-LINEAGE-001": "Needs the asset derivation graph, which no evidence fact carries.",
  "HIVE-INV-CHARTER-001":
    "Needs behaviour compared against charter text. That is a drift-detection question, not a runtime one.",
  "HIVE-INV-CONSTITUTION-001":
    "Needs implementation behaviour compared against constitutional meaning. Nothing in a runtime evidence fact can say whether an implementation has silently changed what a clause means.",
  "HIVE-INV-PORTABILITY-001":
    "Needs dependency and import analysis rather than runtime evidence. The drift detector answers this.",
});

/** The extended detector set. 16 of the catalog's 26. */
export const EXTENDED_DETECTORS: readonly InvariantDetector[] = Object.freeze([
  governanceOrderDetector,
  ownershipDetector,
  noDuplicationDetector,
  versionLineageDetector,
  provenanceDetector,
  dataMinimizationDetector,
  financialIntegrityDetector,
  inventoryConservationDetector,
  lifecycleDetector,
  degradedHonestyDetector,
  failureIsolationDetector,
  trustedIdentityDetector,
  recoveryDetector,
  noBlindReplayDetector,
  inputValidationDetector,
  resourceIntegrityDetector,
]);
