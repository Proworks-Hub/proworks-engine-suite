// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { isPermitted, type GovernanceDecision } from "@proworks-hub/contracts";

import type { CloseTask, EvidenceRequirement } from "../model.js";
import { ok, refuse, type Result } from "../refusals.js";
import { CLOSE_METHODS } from "./evidence.js";

// ─────────────────────────────────────────────────────────────────────────────
// M-7 · close.authorization.hold — the refusal ladder, in order, each with a
// distinct message so the caller fixes the right thing. Modelled on the
// shipped authorizeMaterialChange, because the repository already paid for
// the lesson: a state a thing can enter and never leave is not a gate.
//
// CloseIQ cannot authorize its own held item: engine., service. and model.
// identities are refused BY CLASS; a replayed authorization is refused; an
// event is never authorization.
// ─────────────────────────────────────────────────────────────────────────────

export interface HumanAuthorizationInput {
  readonly by: string;
  readonly reason: string;
  readonly governance: GovernanceDecision | undefined;
  /** The item this authorization binds to. */
  readonly itemId: string;
  /** Governance refs already consumed, for replay detection. */
  readonly consumedGovernanceRefs: ReadonlySet<string>;
  /** The preparer, for the self-authorization refusal. */
  readonly preparedBy?: string;
}

export function requireHumanAuthorization(
  input: HumanAuthorizationInput,
): Result<{ governanceRef: string }> {
  const M = CLOSE_METHODS.authorizationHold;
  if (!input.by.startsWith("human.")) {
    const kind = input.by.startsWith("engine.")
      ? "an engine identity"
      : input.by.startsWith("service.")
        ? "a service identity"
        : input.by.startsWith("model.")
          ? "a model identity"
          : "not a human identity";
    return refuse(
      "not-a-human",
      M,
      `"${input.by}" is ${kind}. A held close item is held for HUMAN authorization; accepting anything else would make the hold ceremonial. Use a human. identity.`,
    );
  }
  if (input.reason.trim().length === 0) {
    return refuse(
      "empty-reason",
      M,
      "An authorization must state its reason. An unexplained approval cannot be reviewed later.",
    );
  }
  if (!input.governance || !isPermitted(input.governance)) {
    return refuse(
      "not-permitted",
      M,
      input.governance
        ? `The governance decision is ${input.governance.decision}: ${input.governance.reason}. Capability does not imply permission.`
        : "No governance decision accompanied the authorization. Capability does not imply permission.",
    );
  }
  const governanceRef = input.governance.decisionId ?? "";
  if (governanceRef.length === 0) {
    return refuse("not-permitted", M, "The governance decision carries no decisionId; an untraceable authorization cannot be audited.");
  }
  if (input.consumedGovernanceRefs.has(governanceRef)) {
    return refuse(
      "replayed-authorization",
      M,
      `Governance decision ${governanceRef} was already consumed by another item. An authorization binds to ONE item and cannot be reused.`,
    );
  }
  if (input.preparedBy !== undefined && input.preparedBy === input.by) {
    return refuse(
      "self-authorization",
      M,
      `${input.by} prepared this item and cannot also authorize it.`,
    );
  }
  return ok({ governanceRef });
}

/** M-8: a waiver never converts to a completion; it records what was NOT met, by value. */
export function buildWaiver(
  task: CloseTask,
  by: string,
  reason: string,
  governance: GovernanceDecision | undefined,
  at: string,
  consumedGovernanceRefs: ReadonlySet<string>,
): Result<CloseTask> {
  const M = CLOSE_METHODS.waiver;
  if (task.status === "completed" || task.status === "waived") {
    return refuse("wrong-state", M, `Task ${task.closeTaskId} is already ${task.status}.`);
  }
  const authorization = requireHumanAuthorization({
    by,
    reason,
    governance,
    itemId: task.closeTaskId,
    consumedGovernanceRefs,
  });
  if (!authorization.ok) return authorization;
  const unmetRequirement: EvidenceRequirement = task.evidenceRequirement;
  const { status: _status, ...common } = task as CloseTask & { blockedBy?: unknown; startedBy?: unknown; startedAt?: unknown };
  delete (common as { blockedBy?: unknown }).blockedBy;
  delete (common as { startedBy?: unknown }).startedBy;
  delete (common as { startedAt?: unknown }).startedAt;
  return ok({
    status: "waived",
    waivedBy: by,
    waivedAt: at,
    reason,
    governanceRef: authorization.value.governanceRef,
    unmetRequirement,
    ...common,
  } as CloseTask);
}
