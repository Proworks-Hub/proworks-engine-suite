// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { AccountReconciliation, AdjustmentRequest, CloseTask } from "../model.js";
import { CLOSE_METHODS } from "./evidence.js";

// ─────────────────────────────────────────────────────────────────────────────
// M-2 · readiness. Seven gates, each evaluated independently and reported
// individually. Verdict precedence: undeterminable > not-ready >
// ready-with-waivers > ready — an engine that reports "not ready" when it
// actually cannot tell has understated its ignorance, because "not ready"
// implies "and I know why". percentComplete is ABSENT when undeterminable —
// not zero and not a best guess.
// ─────────────────────────────────────────────────────────────────────────────

export type ReadinessVerdict = "ready" | "ready-with-waivers" | "not-ready" | "undeterminable";

export interface GateResult {
  readonly gate: string;
  readonly outcome: "pass" | "fail" | "undeterminable";
  readonly detail: string;
}

export interface ReadinessAssessment {
  readonly verdict: ReadinessVerdict;
  readonly gates: readonly GateResult[];
  readonly waivers: readonly { taskId: string; governanceRef: string }[];
  /** Per-taskClass counts — `informational` tasks are visibly not assurance. */
  readonly perTaskClass: Readonly<Record<string, { total: number; completed: number; waived: number }>>;
  /** ABSENT whenever the verdict is undeterminable. */
  readonly percentComplete?: number;
  readonly readinessFingerprint: string;
  readonly methodRef: { methodId: string; semanticVersion: string };
}

export function assessReadiness(input: {
  readonly tasks: readonly CloseTask[];
  readonly reconciliations: readonly AccountReconciliation[];
  /** Accounts whose profile demands certification this period. */
  readonly requiredCertifications: readonly string[];
  readonly adjustments: readonly AdjustmentRequest[];
  readonly openExceptionCount: number;
  readonly materialityBound: boolean;
  readonly requiredPortsBound: boolean;
}): ReadinessAssessment {
  const gates: GateResult[] = [];

  const blocking = input.tasks.filter((t) => t.criticality === "blocking");
  const blockingDone = blocking.filter((t) => t.status === "completed");
  gates.push({
    gate: "G1-blocking-tasks",
    outcome: blocking.length === blockingDone.length ? "pass" : "fail",
    detail: `${blockingDone.length}/${blocking.length} blocking tasks completed. A waived blocking task does NOT pass this gate.`,
  });

  const required = input.tasks.filter((t) => t.criticality === "required");
  const requiredSettled = required.filter((t) => t.status === "completed" || t.status === "waived");
  gates.push({
    gate: "G2-required-tasks",
    outcome: required.length === requiredSettled.length ? "pass" : "fail",
    detail: `${requiredSettled.length}/${required.length} required tasks completed or waived.`,
  });

  const unsubstantiated = input.reconciliations.some((r) => r.state === "unsubstantiated-unknown");
  const certified = new Set(
    input.reconciliations.filter((r) => r.state === "certified").map((r) => r.accountRef),
  );
  const uncovered = input.requiredCertifications.filter((accountRef) => !certified.has(accountRef));
  gates.push({
    gate: "G3-reconciliation-coverage",
    outcome: unsubstantiated ? "undeterminable" : uncovered.length === 0 ? "pass" : "fail",
    detail: unsubstantiated
      ? "A subject is unsubstantiated-unknown: the difference is not zero, it is unknown."
      : uncovered.length === 0
        ? "Every required account is certified."
        : `Uncertified: ${uncovered.join(", ")}.`,
  });

  gates.push({
    gate: "G4-open-exceptions",
    outcome: !input.materialityBound
      ? "undeterminable"
      : input.openExceptionCount === 0
        ? "pass"
        : "fail",
    detail: !input.materialityBound
      ? "The severity floor requires a materiality policy, and none is bound."
      : `${input.openExceptionCount} open exceptions.`,
  });

  const pendingPostings = input.adjustments.filter(
    (a) => a.state === "authorized" || a.state === "submitted-as-proposal",
  );
  gates.push({
    gate: "G5-unposted-adjustments",
    outcome: pendingPostings.length === 0 ? "pass" : "fail",
    detail: `${pendingPostings.length} authorized-but-unposted adjustments. Always determinable.`,
  });

  gates.push({
    gate: "G7-port-health",
    outcome: input.requiredPortsBound ? "pass" : "undeterminable",
    detail: input.requiredPortsBound ? "Required ports bound." : "A required port is unbound.",
  });

  const waivers = input.tasks
    .filter((t): t is Extract<CloseTask, { status: "waived" }> => t.status === "waived")
    .map((t) => ({ taskId: t.closeTaskId, governanceRef: t.governanceRef }));

  const perTaskClass: Record<string, { total: number; completed: number; waived: number }> = {};
  for (const task of input.tasks) {
    const cell = perTaskClass[task.taskClass] ?? { total: 0, completed: 0, waived: 0 };
    cell.total++;
    if (task.status === "completed") cell.completed++;
    if (task.status === "waived") cell.waived++;
    perTaskClass[task.taskClass] = cell;
  }

  const anyUndeterminable = gates.some((g) => g.outcome === "undeterminable");
  const anyFail = gates.some((g) => g.outcome === "fail");
  const verdict: ReadinessVerdict = anyUndeterminable
    ? "undeterminable"
    : anyFail
      ? "not-ready"
      : waivers.length > 0
        ? "ready-with-waivers"
        : "ready";

  const settled = input.tasks.filter((t) => t.status === "completed").length;
  const percentComplete =
    verdict === "undeterminable" || input.tasks.length === 0
      ? undefined
      : (settled * 100) / input.tasks.length;

  const readinessFingerprint = [
    ...gates.map((g) => `${g.gate}:${g.outcome}`),
    `waivers:${waivers.length}`,
    `tasks:${settled}/${input.tasks.length}`,
  ].join("|");

  return {
    verdict,
    gates,
    waivers,
    perTaskClass,
    ...(percentComplete !== undefined ? { percentComplete } : {}),
    readinessFingerprint,
    methodRef: {
      methodId: CLOSE_METHODS.readiness.methodId,
      semanticVersion: CLOSE_METHODS.readiness.semanticVersion,
    },
  };
}
