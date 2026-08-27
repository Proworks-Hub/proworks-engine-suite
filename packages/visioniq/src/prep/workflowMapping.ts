// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten, host generated types replaced with the structurally identical ones
// in core/prepSettings.ts, and `ImageData` annotations swapped for PixelBuffer —
// which ImageData satisfies structurally, so a browser host passes its own
// objects straight in.

/**
 * Prep Studio Pro — Photoshop Handoff Workflow Mapping
 *
 * Defines the end-to-end workflow from InvoFlow OS job status through to
 * final production file upload.  Each workflow entry specifies:
 *   - Which InvoFlow job status triggers the handoff step
 *   - Which action pack(s) run, and in what order
 *   - What recipe fields gate each pack or step
 *   - What the expected final output is
 *
 * This file is the single authoritative reference for Prep Studio Pro panel
 * engineers building the UXP panel orchestration layer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  HANDOFF LIFECYCLE (end-to-end)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  InvoFlow OS
 *    ↓  Job reaches PREPPED status
 *    ↓  Operator downloads Job Package  (GET /api/jobs/:id/package)
 *    ↓  Panel parses manifest → extracts JobRecipe + artwork path
 *
 *  Prep Studio Pro (UXP Panel)
 *    ↓  Panel auto-selects action pack based on recipe.printMode
 *    ↓  Operator reviews active steps + can override individual parameters
 *    ↓  Runs GENERAL_CLEANUP (optional, auto-triggered if score < 70)
 *    ↓  Runs mode-specific pack: DTF_PREP | UV_PREP
 *    ↓  Preflight check confirms output
 *    ↓  Operator exports file (TIFF / PSD / PNG / PDF)
 *
 *  InvoFlow OS
 *    ↓  Panel uploads final file (POST /api/jobs/:id/production-file)
 *    ↓  Job status advances to READY_TO_PRINT
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  DTF_PREP_PACK,
  UV_PREP_PACK,
  GENERAL_CLEANUP_PACK,
  resolvePackForPrintMode,
  type ActionPack,
  type JobRecipe,
} from "./actionPacks.js";

// ─────────────────────────────────────────────────────────────────────────────
// Workflow step types
// ─────────────────────────────────────────────────────────────────────────────

/** One entry in a pack execution sequence. */
export interface WorkflowPackEntry {
  /** Resolved action pack. */
  pack: ActionPack;
  /**
   * Whether this pack is optional in the sequence.
   * Optional packs run only when a guard condition is true.
   */
  optional: boolean;
  /**
   * JavaScript guard expression (evaluated against the recipe + context).
   * When truthy, the optional pack IS included.
   * Undefined means always run.
   */
  includeWhen?: string;
  /** Human-readable note shown in the panel's workflow preview. */
  note: string;
}

/** The full workflow for a given print mode. */
export interface PrintModeWorkflow {
  /**
   * InvoFlow OS print-mode key this workflow handles.
   * 'UVDTF' shares UV_PREP with 'UV'.
   */
  printMode:        string;
  /** Display label shown in the panel mode selector. */
  label:            string;
  /** Brief human summary of what this workflow does. */
  summary:          string;
  /**
   * Ordered pack execution sequence.
   * Packs run in array order; optional packs are skipped when their
   * `includeWhen` guard is false.
   */
  packSequence:     WorkflowPackEntry[];
  /**
   * Recipe fields the panel must display in the "Recipe Overview" section
   * when this workflow is active.  Fields are shown in the order listed.
   */
  primaryRecipeFields:  Array<keyof JobRecipe>;
  /**
   * Additional recipe fields shown in the "Advanced" collapsible section.
   */
  secondaryRecipeFields: Array<keyof JobRecipe>;
  /**
   * Accepted output formats for the final export step.
   * The first entry is the default (pre-selected in the export dialog).
   */
  outputFormats:    Array<'TIFF' | 'PSD' | 'PNG' | 'PDF'>;
  /**
   * API endpoint used to upload the finished file back to InvoFlow OS.
   * Template: replace :id with the job ID from the package manifest.
   */
  uploadEndpoint:   string;
  /**
   * InvoFlow job status that the upload endpoint advances the job to.
   */
  advancesStatusTo: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow definitions
// ─────────────────────────────────────────────────────────────────────────────

export const DTF_WORKFLOW: PrintModeWorkflow = {
  printMode: 'DTF',
  label:     'Direct-to-Film (DTF)',
  summary:
    'Removes background, generates W1 white ink layer, and sharpens edges for '
    + 'clean transparent TIFF/PNG output compatible with DTF RIP software.',

  packSequence: [
    {
      pack:        GENERAL_CLEANUP_PACK,
      optional:    true,
      includeWhen: 'context.preflightScore < 70 || recipe.cleanupLevel > 50',
      note:        'Auto-triggered when preflight score < 70 or cleanupLevel > 50',
    },
    {
      pack:     DTF_PREP_PACK,
      optional: false,
      note:     'Core DTF prep — background removal, W1 generation, edge sharpening',
    },
  ],

  primaryRecipeFields: [
    'backgroundRemoved',
    'generateWhite',
    'cleanupLevel',
    'edgeStrength',
  ],

  secondaryRecipeFields: [
    'choke',
    'expand',
    'preserveFades',
    'generateVarnish',
  ],

  outputFormats:    ['TIFF', 'PNG', 'PSD'],
  uploadEndpoint:   'POST /api/jobs/:id/production-file',
  advancesStatusTo: 'READY_TO_PRINT',
};

export const UV_WORKFLOW: PrintModeWorkflow = {
  printMode: 'UV',
  label:     'UV Flatbed / UV Print',
  summary:
    'Converts to CMYK 8-bit, generates white/varnish/foil spot channels, '
    + 'and outputs a production-ready TIFF with all spot color channels '
    + 'intact for UV RIP software.',

  packSequence: [
    {
      pack:        GENERAL_CLEANUP_PACK,
      optional:    true,
      includeWhen: 'context.preflightScore < 70 || recipe.cleanupLevel > 50',
      note:        'Auto-triggered when preflight score < 70 or cleanupLevel > 50',
    },
    {
      pack:     UV_PREP_PACK,
      optional: false,
      note:     'Core UV prep — CMYK conversion, spot channels, ink coverage check',
    },
  ],

  primaryRecipeFields: [
    'generateWhite',
    'generateVarnish',
    'generateFoil',
    'cleanupLevel',
    'edgeStrength',
  ],

  secondaryRecipeFields: [
    'backgroundRemoved',
    'choke',
    'expand',
    'preserveFades',
  ],

  outputFormats:    ['TIFF', 'PSD', 'PDF'],
  uploadEndpoint:   'POST /api/jobs/:id/production-file',
  advancesStatusTo: 'READY_TO_PRINT',
};

export const UVDTF_WORKFLOW: PrintModeWorkflow = {
  printMode: 'UVDTF',
  label:     'UV-DTF (Hybrid)',
  summary:
    'Combines UV spot channel generation with DTF transparent background output. '
    + 'Uses the UV_PREP pack (CMYK mode, spot channels) then finalises to TIFF '
    + 'with transparency for UV-DTF transfer films.',

  packSequence: [
    {
      pack:        GENERAL_CLEANUP_PACK,
      optional:    true,
      includeWhen: 'context.preflightScore < 70',
      note:        'Auto-triggered when preflight score < 70',
    },
    {
      pack:     UV_PREP_PACK,
      optional: false,
      note:     'UV spot channel generation (W1, Varnish, Foil) on CMYK document',
    },
  ],

  primaryRecipeFields: [
    'generateWhite',
    'generateVarnish',
    'generateFoil',
    'backgroundRemoved',
    'cleanupLevel',
  ],

  secondaryRecipeFields: [
    'choke',
    'expand',
    'preserveFades',
    'edgeStrength',
  ],

  outputFormats:    ['TIFF', 'PSD'],
  uploadEndpoint:   'POST /api/jobs/:id/production-file',
  advancesStatusTo: 'READY_TO_PRINT',
};

// ─────────────────────────────────────────────────────────────────────────────
// Workflow registry
// ─────────────────────────────────────────────────────────────────────────────

export const WORKFLOW_REGISTRY: Record<string, PrintModeWorkflow> = {
  DTF:   DTF_WORKFLOW,
  UV:    UV_WORKFLOW,
  UVDTF: UVDTF_WORKFLOW,
};

/**
 * Resolve the workflow for a given print-mode key.
 * Returns null if the mode has no Prep Studio Pro workflow
 * (e.g. LASER, which uses a different toolchain).
 */
export function resolveWorkflow(printMode: string): PrintModeWorkflow | null {
  return WORKFLOW_REGISTRY[printMode] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipe field → display metadata
// Used by the panel to render the Recipe Overview section with correct labels.
// ─────────────────────────────────────────────────────────────────────────────

export interface RecipeFieldMeta {
  label:       string;
  description: string;
  valueType:   'boolean' | 'percentage' | 'pixels';
  /** True when the field is actionable in the panel (has a toggle/slider). */
  editable:    boolean;
}

export const RECIPE_FIELD_META: Record<keyof JobRecipe, RecipeFieldMeta> = {
  printMode: {
    label:       'Print Mode',
    description: 'Determines which action pack runs and which channels are generated.',
    valueType:   'boolean',
    editable:    false,
  },
  backgroundRemoved: {
    label:       'Remove Background',
    description: 'Whether the panel should strip the artwork background.',
    valueType:   'boolean',
    editable:    true,
  },
  cleanupLevel: {
    label:       'Cleanup Level',
    description: 'Controls how aggressively artifacts, fringe pixels, and noise are removed. '
               + '0 = minimal cleanup, 100 = maximum cleanup.',
    valueType:   'percentage',
    editable:    true,
  },
  edgeStrength: {
    label:       'Edge Strength',
    description: 'Controls the Unsharp Mask sharpening pass. '
               + '0 = no sharpening, 100 = maximum sharpening.',
    valueType:   'percentage',
    editable:    true,
  },
  generateWhite: {
    label:       'Generate White Channel',
    description: 'Whether to generate a W1 white ink / white underbase channel.',
    valueType:   'boolean',
    editable:    true,
  },
  generateVarnish: {
    label:       'Generate Varnish',
    description: 'Whether to generate a UV varnish spot channel.',
    valueType:   'boolean',
    editable:    true,
  },
  generateFoil: {
    label:       'Generate Foil',
    description: 'Whether to generate a foil / metallic spot channel.',
    valueType:   'boolean',
    editable:    true,
  },
  choke: {
    label:       'Choke',
    description: 'Inward shrink applied to white / spot channel masks in pixels. '
               + 'Prevents white from bleeding past artwork edges.',
    valueType:   'pixels',
    editable:    true,
  },
  expand: {
    label:       'Expand',
    description: 'Outward grow applied to white / spot channel masks in pixels. '
               + 'Ensures full underbase coverage at the cost of slight bleed.',
    valueType:   'pixels',
    editable:    true,
  },
  preserveFades: {
    label:       'Preserve Fades',
    description: 'When true, masks use feathered / soft edges to retain gradient transparency. '
               + 'When false, masks use hard threshold cuts for clean solid edges.',
    valueType:   'boolean',
    editable:    true,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Context type passed to `includeWhen` guard expressions at runtime
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkflowContext {
  /** InvoFlow preflight score (0–100) from the job package manifest. */
  preflightScore: number;
  /** Current InvoFlow job status string. */
  jobStatus:      string;
  /** InvoFlow job ID. */
  jobId:          string;
}

/**
 * Evaluates which packs in a workflow sequence will actually run given the
 * current recipe and execution context.
 */
export function resolveActivePackSequence(
  workflow:  PrintModeWorkflow,
  recipe:    JobRecipe,
  context:   WorkflowContext,
): WorkflowPackEntry[] {
  return workflow.packSequence.filter(entry => {
    if (!entry.optional || !entry.includeWhen) return true;
    try {
      const fn = new Function('recipe', 'context', `return !!(${entry.includeWhen})`);
      return fn(recipe, context);
    } catch {
      return true;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick-reference: recipe field → action packs that use it
// ─────────────────────────────────────────────────────────────────────────────

type RecipeField = keyof JobRecipe;

/**
 * Maps each recipe field to the IDs of action packs that consume it.
 * Useful for the panel's "Why is this field highlighted?" tooltip.
 */
export const RECIPE_FIELD_TO_PACKS: Record<RecipeField, string[]> = {
  printMode:         [],
  backgroundRemoved: ['DTF_PREP', 'UV_PREP', 'GENERAL_CLEANUP'],
  cleanupLevel:      ['DTF_PREP', 'UV_PREP', 'GENERAL_CLEANUP'],
  edgeStrength:      ['DTF_PREP', 'UV_PREP', 'GENERAL_CLEANUP'],
  generateWhite:     ['DTF_PREP', 'UV_PREP'],
  generateVarnish:   ['DTF_PREP', 'UV_PREP'],
  generateFoil:      ['UV_PREP'],
  choke:             ['DTF_PREP', 'UV_PREP'],
  expand:            ['DTF_PREP', 'UV_PREP'],
  preserveFades:     ['DTF_PREP', 'UV_PREP', 'GENERAL_CLEANUP'],
};

// re-export for convenience
export { resolvePackForPrintMode };
