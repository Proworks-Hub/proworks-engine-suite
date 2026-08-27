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
 * PRIME Engine — Template Resolver types
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.2 (Template Resolver Module).
 *
 * Concepts:
 * - `ProcessTemplate` is an ordered, dependency-aware list of steps that says
 *   "this kind of job needs these steps, on these workstation classes, with
 *   these skills, in roughly this order." It is the abstract recipe.
 * - A `ProcessTemplate.kind` of `recipe` means it came from the finished-product
 *   catalog; `template` means it came from the custom-process library. PRIME
 *   treats both uniformly.
 * - Resolution takes a `WorkOrderDraft` (from Intake §3.1) and fans each
 *   line item through its matched template, producing a flat list of
 *   `TentativeStep`s. Tentative steps reference `workstationClass` — NOT a
 *   physical station id. Concrete station assignment is Routing's job (§3.3).
 * - `dependsOn` on a `TentativeStep` is remapped from `templateStepId`s to
 *   tentative-step ids (one layer earlier). Consumers of the tentative graph
 *   never need to look back at the template.
 */

import type { WorkOrderId } from "../../models/events.js";
import type { IntakeLineItem } from "../intake/intakeTypes.js";

// ---------- Workstation & skill primitives ----------

/**
 * Class of workstation a step needs — not a specific physical station.
 * Open-ended `string` so shops can extend without touching this module.
 */
export type WorkstationClass =
  | "laser"
  | "uv_print"
  | "dtf_print"
  | "cnc"
  | "hand_assembly"
  | "hand_finish"
  | "quality_check"
  | "pack_ship"
  | (string & {});

export type SkillTag = string;

// ---------- Process template ----------

export interface ProcessTemplateStep {
  /** Stable within the template; used as a dependency reference. */
  readonly id: string;
  readonly label: string;
  readonly workstationClass: WorkstationClass;
  readonly requiredSkillTags: ReadonlyArray<SkillTag>;
  /** Informational — Routing/Scheduling uses it as a hint, not a commitment. */
  readonly estimatedDurationMinutes?: number;
  /** Ids of other steps in the SAME template that must complete first. */
  readonly dependsOn?: ReadonlyArray<string>;
  /** Operators can skip this step via override without breaking the template contract. */
  readonly optional?: boolean;
}

export interface ProcessTemplate {
  readonly id: string;
  readonly name: string;
  /**
   * Where the template came from:
   * - `recipe`   — catalog finished-product recipe (Finished Products DB)
   * - `template` — custom-process template library
   * - `hybrid`   — composition of a recipe + additional template steps
   */
  readonly kind: "recipe" | "template" | "hybrid";
  readonly steps: ReadonlyArray<ProcessTemplateStep>;
}

// ---------- Tentative step list (output of resolution) ----------

export interface TentativeStep {
  /** Unique within the work order. Generated at resolve time. */
  readonly id: string;
  /** Which Intake line item this step is serving. */
  readonly lineItemId: string;
  /** Template the step came from. */
  readonly templateId: string;
  /** Original step id within the template (for traceability). */
  readonly templateStepId: string;
  readonly label: string;
  readonly workstationClass: WorkstationClass;
  readonly requiredSkillTags: ReadonlyArray<SkillTag>;
  readonly estimatedDurationMinutes?: number;
  /** Tentative-step ids that must finish first. Remapped from the template. */
  readonly dependsOn: ReadonlyArray<string>;
  readonly optional: boolean;
}

// ---------- Resolution errors ----------

export type TemplateResolutionErrorCode =
  | "template_not_found"
  | "template_empty";

export interface TemplateResolutionError {
  readonly code: TemplateResolutionErrorCode;
  readonly message: string;
  readonly lineItemId: string;
}

// ---------- Library port ----------

/**
 * Narrow port so PRIME doesn't depend on a concrete template store.
 * Real-world implementations will hit the finished-products DB and the
 * custom-process template library; test/dev uses `createInMemoryTemplateLibrary`.
 */
export interface TemplateLibrary {
  findForLineItem(lineItem: IntakeLineItem): Promise<ProcessTemplate | null>;
}

// ---------- Event payloads (§16 event catalog) ----------

export interface TemplateResolvedPayload {
  /** De-duplicated set of template ids used across all line items. */
  readonly templateIds: ReadonlyArray<string>;
  readonly stepCount: number;
  readonly lineItemCount: number;
}

/**
 * Payload for `work_order.template.overridden`. Not yet emitted by the
 * initial resolve use case — kept here for when the override flow is built.
 */
export interface TemplateOverriddenPayload {
  readonly workOrderId: WorkOrderId;
  readonly overrideType: "skip_step" | "add_step" | "replace_step" | "reorder";
  readonly affectedStepIds: ReadonlyArray<string>;
  readonly reason?: string;
}
