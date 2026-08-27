// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

/*
 * Copyright © 2026 Steven. All Rights Reserved.
 *
 * This file was created under the sole direction and vision of Steven.
 * All product decisions, business logic, workflows, and architecture
 * were defined by Steven. AI tools (Cursor, Perplexity, ChatGPT)
 * were used strictly as a coding assistant, similar to working with
 * a hired developer.
 *
 * Owner: Steven
 * Project: MakerOps / ProWorks Hub
 * Created: 2026
 */

/**
 * PRIME Engine — resolveTemplate use case
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.2 (Template Resolver Module).
 *
 * End-to-end resolution: takes a `PrimeWorkOrderDraft` (from Intake §3.1),
 * fans each line item through its matched `ProcessTemplate`, and produces a
 * flat `TentativeStep[]` ready for Routing (§3.3).
 *
 * Contract:
 * - One tentative step per (line item × template step). N line items sharing
 *   the same template produce N × steps.length tentative steps. Each is
 *   independently schedulable.
 * - `dependsOn` on tentative steps is remapped from `templateStepId` to
 *   tentative-step ids, scoped to the owning line item. Cross-line-item
 *   dependencies are NOT inferred at this layer.
 * - If any line item fails to resolve (no template / empty template), the
 *   whole resolution fails — we return the errors and do NOT emit
 *   `work_order.template.resolved`. Partial WOs don't advance. Per spec §16
 *   there is no `template.resolution_failed` event, so the failure is
 *   returned to the caller, not logged.
 * - On success, exactly one `work_order.template.resolved` event is emitted,
 *   with a summary payload (template ids, step count, line item count). The
 *   full tentative-step list travels with the use-case result; it is not
 *   embedded in the event payload by design (keeps events small; the list is
 *   rebuildable from the log by replaying intake + re-resolving if needed).
 */

import type {
  EventActor,
} from "../../models/events.js";
import type {
  Clock,
  EventLog,
  IdGenerator,
} from "../logging/eventLog.js";
import type { PrimeWorkOrderDraft } from "../intake/intakeTypes.js";
import type {
  TemplateLibrary,
  TemplateResolutionError,
  TemplateResolvedPayload,
  TentativeStep,
} from "./templateTypes.js";

// ---------- Public surface ----------

export type ResolveTemplateResult =
  | {
      readonly ok: true;
      readonly tentativeSteps: ReadonlyArray<TentativeStep>;
    }
  | {
      readonly ok: false;
      readonly errors: ReadonlyArray<TemplateResolutionError>;
    };

export interface ResolveTemplateUseCaseDeps {
  readonly eventLog: EventLog;
  readonly library: TemplateLibrary;
  /** Generator for tentative-step ids. Defaults to crypto.randomUUID with `step_` prefix. */
  readonly stepIdGenerator?: IdGenerator;
  /** Reserved for future use (e.g. time-boxed matching). Currently unused. */
  readonly clock?: Clock;
}

export interface ResolveTemplateUseCase {
  execute(
    draft: PrimeWorkOrderDraft,
    actor: EventActor
  ): Promise<ResolveTemplateResult>;
}

// ---------- Factory ----------

export function createResolveTemplateUseCase(
  deps: ResolveTemplateUseCaseDeps
): ResolveTemplateUseCase {
  const { eventLog, library } = deps;
  const genStepId: IdGenerator =
    deps.stepIdGenerator ?? defaultStepIdGenerator;

  return {
    async execute(draft, actor) {
      const errors: TemplateResolutionError[] = [];
      const tentativeSteps: TentativeStep[] = [];
      const usedTemplateIds: string[] = [];

      for (const lineItem of draft.lineItems) {
        const template = await library.findForLineItem(lineItem);

        if (!template) {
          errors.push({
            code: "template_not_found",
            message: `No template matched line item '${lineItem.label}' (id=${lineItem.id})`,
            lineItemId: lineItem.id,
          });
          continue;
        }

        if (template.steps.length === 0) {
          errors.push({
            code: "template_empty",
            message: `Template '${template.id}' has no steps`,
            lineItemId: lineItem.id,
          });
          continue;
        }

        usedTemplateIds.push(template.id);

        // Mint one tentative-step id per template-step, scoped to this line item.
        // Keep a local map so we can remap dependsOn immediately.
        const idByTemplateStepId = new Map<string, string>();
        for (const step of template.steps) {
          idByTemplateStepId.set(step.id, genStepId());
        }

        for (const step of template.steps) {
          const tentativeId = idByTemplateStepId.get(step.id);
          // Guaranteed by the loop above — narrowing only.
          if (!tentativeId) continue;

          const dependsOn = (step.dependsOn ?? []).reduce<string[]>(
            (acc, depId) => {
              const mapped = idByTemplateStepId.get(depId);
              // Silently drop dangling deps — the template authoring layer
              // should catch those, not resolution. An assertion here would
              // block a WO over a template-library bug.
              if (mapped) acc.push(mapped);
              return acc;
            },
            []
          );

          tentativeSteps.push(
            Object.freeze({
              id: tentativeId,
              lineItemId: lineItem.id,
              templateId: template.id,
              templateStepId: step.id,
              label: step.label,
              workstationClass: step.workstationClass,
              requiredSkillTags: step.requiredSkillTags,
              estimatedDurationMinutes: step.estimatedDurationMinutes,
              dependsOn,
              optional: step.optional ?? false,
            })
          );
        }
      }

      if (errors.length > 0) {
        return { ok: false, errors };
      }

      const uniqueTemplateIds = Array.from(new Set(usedTemplateIds));

      await eventLog.append<TemplateResolvedPayload>({
        workOrderId: draft.workOrderId,
        type: "work_order.template.resolved",
        actor,
        payload: {
          templateIds: uniqueTemplateIds,
          stepCount: tentativeSteps.length,
          lineItemCount: draft.lineItems.length,
        },
      });

      return { ok: true, tentativeSteps };
    },
  };
}

// ---------- Defaults ----------

function defaultStepIdGenerator(): string {
  if (
    typeof globalThis !== "undefined" &&
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return `step_${globalThis.crypto.randomUUID()}`;
  }
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `step_${time}_${rand}`;
}
