// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type {
  CloseEvidenceRef,
  CloseTask,
  CloseTemplate,
  EvidenceKind,
} from "../model.js";
import { ok, refuse, type Result } from "../refusals.js";
import { CLOSE_METHODS, satisfies, type SatisfactionContext } from "./evidence.js";

// ─────────────────────────────────────────────────────────────────────────────
// M-10 · template instantiation with the three load-time refusals (§15), and
// the task transitions. The ONLY producer of the `completed` variant is
// completeTask(); there is no partial construction and no bypass.
// Dependency semantics: finish-to-start on `completed` OR `waived`, with the
// waiver distinction exposed so the chain of consequence is traceable.
// ─────────────────────────────────────────────────────────────────────────────

/** Validated at template LOAD, refused not warned: cycles, unreachable tasks, orphaned evidence kinds. */
export function validateTemplate(
  template: CloseTemplate,
  producibleEvidenceKinds: readonly EvidenceKind[],
): Result<"valid"> {
  const M = CLOSE_METHODS.templateInstantiation;
  const ids = new Set(template.tasks.map((t) => t.taskDefinitionId));
  for (const task of template.tasks) {
    for (const predecessor of task.predecessors) {
      if (!ids.has(predecessor)) {
        return refuse(
          "unreachable-task",
          M,
          `Task ${task.taskDefinitionId} depends on ${predecessor}, which is not in the template — its predecessors can never all complete.`,
        );
      }
    }
  }
  // Cycle detection: Kahn's algorithm.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of template.tasks) {
    inDegree.set(task.taskDefinitionId, task.predecessors.length);
    for (const predecessor of task.predecessors) {
      const list = dependents.get(predecessor) ?? [];
      list.push(task.taskDefinitionId);
      dependents.set(predecessor, list);
    }
  }
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    visited++;
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }
  if (visited !== template.tasks.length) {
    return refuse(
      "dag-invalid",
      M,
      "The template contains a cycle: a cyclic close checklist has no valid execution and would deadlock at runtime, where the diagnosis is far harder.",
    );
  }
  // Orphaned evidence requirement: a clause whose kind nothing can produce
  // converts silently into a waiver culture. Caught at load, not at close.
  for (const task of template.tasks) {
    for (const clause of task.evidenceRequirement.clauses) {
      if (!producibleEvidenceKinds.includes(clause.kind)) {
        return refuse(
          "orphaned-evidence-requirement",
          M,
          `Task ${task.taskDefinitionId} requires evidence of kind "${clause.kind}", which no configured port or event can produce — a requirement that can never be met.`,
        );
      }
    }
  }
  return ok("valid");
}

/** Deterministic: same template version + closePeriodId produce the same task set with the same ids. */
export function instantiateTasks(
  template: CloseTemplate,
  closePeriodId: string,
): readonly CloseTask[] {
  const idFor = (definitionId: string) => `${closePeriodId}:${definitionId}`;
  return template.tasks.map((definition) => {
    const common = {
      closeTaskId: idFor(definition.taskDefinitionId),
      closePeriodId,
      definitionRef: {
        taskDefinitionId: definition.taskDefinitionId,
        semanticVersion: definition.semanticVersion,
      },
      name: definition.name,
      taskClass: definition.taskClass,
      criticality: definition.criticality,
      owner: definition.owner,
      ...(definition.reviewer !== undefined ? { reviewer: definition.reviewer } : {}),
      predecessors: definition.predecessors.map(idFor),
      dueOffsetWorkDays: definition.dueOffsetWorkDays,
      // Copied BY VALUE with its version: a later template change does not
      // retroactively change what this period's tasks required.
      evidenceRequirement: definition.evidenceRequirement,
    };
    return definition.predecessors.length === 0
      ? ({ status: "pending", ...common } as CloseTask)
      : ({ status: "blocked", blockedBy: common.predecessors, ...common } as CloseTask);
  });
}

/** Finish-to-start on `completed` OR `waived`. The distinction is the caller's to display. */
export function predecessorsSatisfied(
  task: CloseTask,
  byId: ReadonlyMap<string, CloseTask>,
): { satisfied: boolean; unmet: readonly string[]; unblockedByWaiver: boolean } {
  const unmet: string[] = [];
  let unblockedByWaiver = false;
  for (const predecessorId of task.predecessors) {
    const predecessor = byId.get(predecessorId);
    if (!predecessor || (predecessor.status !== "completed" && predecessor.status !== "waived")) {
      unmet.push(predecessorId);
    } else if (predecessor.status === "waived") {
      unblockedByWaiver = true;
    }
  }
  return { satisfied: unmet.length === 0, unmet, unblockedByWaiver };
}

export function startTask(
  task: CloseTask,
  byId: ReadonlyMap<string, CloseTask>,
  by: string,
  at: string,
): Result<CloseTask> {
  const M = CLOSE_METHODS.templateInstantiation;
  if (task.status !== "pending" && task.status !== "blocked") {
    return refuse("wrong-state", M, `Task ${task.closeTaskId} is ${task.status}, not startable.`);
  }
  const predecessors = predecessorsSatisfied(task, byId);
  if (!predecessors.satisfied) {
    return refuse(
      "predecessors-unmet",
      M,
      `Task ${task.closeTaskId} is blocked by: ${predecessors.unmet.join(", ")}.`,
    );
  }
  const { status: _status, ...common } = task as CloseTask & { blockedBy?: readonly string[] };
  delete (common as { blockedBy?: unknown }).blockedBy;
  return ok({ status: "in-progress", startedBy: by, startedAt: at, ...common } as CloseTask);
}

/**
 * The ONLY producer of the `completed` variant. Takes the requirement and the
 * candidate evidence, calls M-1, and returns the completed task or a typed
 * refusal naming the unmet clauses. No force, no override, no skipValidation.
 */
export function completeTask(
  task: CloseTask,
  byId: ReadonlyMap<string, CloseTask>,
  evidence: readonly CloseEvidenceRef[],
  by: string,
  asOf: string,
  context: SatisfactionContext,
): Result<CloseTask> {
  const M = CLOSE_METHODS.evidenceSatisfaction;
  if (task.status === "completed" || task.status === "waived") {
    return refuse("wrong-state", M, `Task ${task.closeTaskId} is already ${task.status}.`);
  }
  const predecessors = predecessorsSatisfied(task, byId);
  if (!predecessors.satisfied) {
    return refuse("predecessors-unmet", M, `Blocked by: ${predecessors.unmet.join(", ")}.`);
  }
  // M-7's separation check on review tasks: the reviewer must not be the
  // preparer, and a named reviewer is the only principal who may complete.
  if (task.taskClass === "review") {
    const reviewed = task.predecessors
      .map((id) => byId.get(id))
      .find((p) => p && p.status === "completed");
    const preparer =
      reviewed && reviewed.status === "completed"
        ? reviewed.completedBy
        : task.status === "in-progress"
          ? task.startedBy
          : undefined;
    if (preparer !== undefined && preparer === by) {
      return refuse(
        "self-authorization",
        M,
        `${by} prepared the work under review and cannot also review it. A principal granting themselves assurance is the engine granting itself authority.`,
      );
    }
    if (task.reviewer !== undefined && task.reviewer !== by) {
      return refuse("not-permitted", M, `This review names ${task.reviewer}; ${by} is not that principal.`);
    }
  }
  const outcome = satisfies(task.evidenceRequirement, evidence, asOf, context);
  if (!outcome.satisfied) {
    const named = outcome.unmet
      .map((u) => `${u.clauseKind}: needed ${u.needed}, found ${u.found}${u.drops.length > 0 ? ` (${u.drops.join("; ")})` : ""}`)
      .join(" | ");
    return refuse("evidence-unsatisfied", M, `The evidence does not satisfy the requirement — ${named}`);
  }
  const [first, ...rest] = evidence;
  if (!first) {
    return refuse("evidence-unsatisfied", M, "No evidence was supplied. A completed task without evidence does not exist, by type.");
  }
  const { status: _status, ...common } = task as CloseTask & { blockedBy?: readonly string[]; startedBy?: string };
  delete (common as { blockedBy?: unknown }).blockedBy;
  const startedBy = task.status === "in-progress" ? { startedBy: task.startedBy } : {};
  delete (common as { startedBy?: unknown }).startedBy;
  delete (common as { startedAt?: unknown }).startedAt;
  return ok({
    status: "completed",
    evidence: [first, ...rest],
    satisfaction: outcome.verdict,
    completedBy: by,
    completedAt: asOf,
    methodRef: { methodId: M.methodId, semanticVersion: M.semanticVersion },
    ...startedBy,
    ...common,
  } as CloseTask);
}
