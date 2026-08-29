// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  adviceSchema,
  type Advice,
  type AdviceResult,
  type ObservationRef,
} from "./advice.js";

// ─────────────────────────────────────────────────────────────────────────────
// The ARIA engine.
//
// It reads what it is GIVEN. It imports no engine and holds no handle to one —
// not because the dependency law forbids it (ARIA is platform tier, and the law
// forbids importing anything in the tier system) but because an advisor that
// could reach into Governance or Sentinel on its own initiative would be
// deciding what to look at, and "what to look at" is most of a judgement.
//
// A host hands it observations. That is the whole input surface.
//
// WHAT IS DELIBERATELY ABSENT
//
// No `authorize`. No `permit`. No `decide`. No `execute`. Not omitted for now —
// absent by design, and asserted absent by a test, because the difference
// between an advisor and an authority is a difference in what can be called.
//
// The failure this shape prevents is gradual: an advisory component gets good,
// callers stop reading its output and start branching on it, and one day the
// authorization path has a dependency nobody chartered. Keeping the answer
// unexecutable is what keeps that from being possible rather than merely
// discouraged.
// ─────────────────────────────────────────────────────────────────────────────

export interface AriaObservations {
  /** Governance decisions the host has seen. References, not copies. */
  readonly governanceDecisions?: readonly ObservationRef[];
  /** Sentinel findings the host has seen. */
  readonly sentinelFindings?: readonly ObservationRef[];
  /** Foundry promotions and refusals. */
  readonly foundryPromotions?: readonly ObservationRef[];
}

export interface AriaOptions {
  readonly now?: () => Date;
  readonly generateId?: () => string;
}

export interface Aria {
  readonly name: "aria";

  /**
   * Offers advice, or abstains and says why.
   *
   * Never throws and never returns nothing. An advisor that returns nothing is
   * indistinguishable from one that is broken, and the difference matters to
   * whoever is waiting on it.
   */
  advise(input: {
    question: string;
    observations: AriaObservations;
    addressedTo: Advice["addressedTo"];
  }): AdviceResult;

  /** Everything it has said, so its advice can be reviewed as a body. */
  history(): readonly Advice[];
}

const countOf = (o: AriaObservations): number =>
  (o.governanceDecisions?.length ?? 0) +
  (o.sentinelFindings?.length ?? 0) +
  (o.foundryPromotions?.length ?? 0);

export function createAria(options: AriaOptions = {}): Aria {
  const now = options.now ?? (() => new Date());
  const said: Advice[] = [];
  let n = 0;
  const generateId = options.generateId ?? (() => `advice_${(n += 1)}`);

  return {
    name: "aria",

    advise({ question, observations, addressedTo }) {
      const all: ObservationRef[] = [
        ...(observations.governanceDecisions ?? []),
        ...(observations.sentinelFindings ?? []),
        ...(observations.foundryPromotions ?? []),
      ];

      // ── Nothing to go on ──────────────────────────────────────────────
      //
      // The single most important branch in this engine. Producing advice is
      // what ARIA is for, which makes it the component most tempted to fill a
      // silence — and advice assembled from no observations is an opinion with
      // a citation field.
      if (all.length === 0) {
        return {
          advised: false,
          abstention: {
            abstained: true,
            reason: `Nothing was observed, so there is nothing to advise about "${question}".`,
            wouldNeed: [
              "at least one Governance decision, Sentinel finding, or Foundry promotion to reason from",
            ],
          },
        };
      }

      // ── Confidence follows the evidence, not the question ─────────────
      //
      // A single observation supports noticing something; it does not support
      // a conclusion. The thresholds are crude on purpose — a sophisticated
      // confidence model would be a source of unearned certainty, and the
      // honest failure mode for an advisor is to under-claim.
      const confidence =
        all.length >= 3 ? "well-supported" : all.length === 2 ? "suggestive" : "speculative";

      const parsed = adviceSchema.safeParse({
        adviceId: generateId(),
        observation: `${all.length} observation(s) bear on "${question}": ${all
          .map((o) => o.sourceKind)
          .join(", ")}.`,
        suggestion: `Consider reviewing ${all.map((o) => o.locator).join(", ")} together before deciding.`,
        confidence,
        ...(confidence === "well-supported"
          ? {}
          : {
              uncertainty:
                confidence === "speculative"
                  ? "One observation. This is a thing worth noticing, not a pattern, and ARIA cannot tell the two apart from a single point."
                  : "Two observations. They may be related or coincident; ARIA has no way to establish which.",
            }),
        basedOn: all,
        addressedTo,
        producedAt: now().toISOString(),
      });

      if (!parsed.success) {
        // ARIA refusing its own malformed advice. The alternative is an engine
        // that emits something shaped wrongly and lets a reader discover it.
        return {
          advised: false,
          abstention: {
            abstained: true,
            reason: `ARIA could not form well-shaped advice: ${JSON.stringify(parsed.error.flatten())}`,
            wouldNeed: [],
          },
        };
      }

      said.push(parsed.data);
      return { advised: true, advice: parsed.data };
    },

    history: () => [...said],
  };
}

/**
 * Whether ARIA's advice authorizes anything.
 *
 * Always false. The thirteenth of these in the repository, and the one whose
 * subject is most likely to drift: an advisory engine becomes load-bearing not
 * by being given authority but by being consulted where authority is decided,
 * one caller at a time.
 */
export function adviceGrantsAuthority(): false {
  return false;
}

/**
 * Whether ARIA may be consulted on an authorization decision.
 *
 * Always false, and separate from the above on purpose. "Its advice does not
 * authorize" and "it is not asked whether to authorize" are different claims,
 * and only the second one prevents ARIA becoming a dependency of the
 * authorization path.
 */
export function ariaParticipatesInAuthorization(): false {
  return false;
}

/**
 * Whether an unavailable ARIA blocks anything.
 *
 * Always false. Overwatch's no-authority-accumulation principle in the other
 * direction: if the Hive stopped while its advisor was down, the advisor would
 * have become required, and a required advisor is an authority.
 */
export function ariaUnavailabilityBlocksWork(): false {
  return false;
}
