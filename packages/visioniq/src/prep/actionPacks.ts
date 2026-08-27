// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Entirely DOM-free
// already — the three "document" matches an automated scan flagged here are the
// English word, in comments about Photoshop documents.

/**
 * Prep Studio Pro — Photoshop Action Pack Architecture
 *
 * This module defines the three initial Photoshop action packs:
 *   1. DTF_PREP      — Direct-to-Film artwork preparation
 *   2. UV_PREP       — UV flatbed / UV-DTF artwork preparation
 *   3. GENERAL_CLEANUP — substrate-agnostic edge & artifact cleanup
 *
 * Each action pack is driven entirely by the InvoFlow OS `JobRecipe` values
 * that are downloaded as part of the Job Package (GET /api/jobs/:id/package).
 *
 * The panel reads the recipe once when the job package is loaded, then passes
 * the relevant fields into `runActionPack()` at execution time.  No Photoshop
 * action pack hardcodes a value — every numeric parameter is sourced from the
 * recipe or from a derived expression of recipe fields.
 *
 *  PHOTOSHOP API LAYER USED:
 *    - UXP Photoshop DOM (app.activeDocument, layer operations)
 *    - batchPlay (Action Manager) for operations without a DOM equivalent
 *    - Photoshop API executeAsModal() for all write operations
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Mirror of the InvoFlow OS JobRecipe interface (api-server/src/store.ts).
 * This is the authoritative shape of the recipe object downloaded as part of
 * GET /api/jobs/:id/package.  Keep in sync with the server-side definition.
 *
 * All fields are non-optional here because the panel must validate the
 * package manifest before any action pack is run.
 */
export interface JobRecipe {
  /** InvoFlow OS print-mode key: 'DTF' | 'UV' | 'UVDTF' | 'LASER' */
  printMode:         string;
  /** Whether the artwork background should be / has been removed */
  backgroundRemoved: boolean;
  /** Cleanup aggressiveness — 0 (minimal) to 100 (maximum) */
  cleanupLevel:      number;
  /** Edge-sharpening strength — 0 (none) to 100 (maximum) */
  edgeStrength:      number;
  /** Whether to generate a W1 white-ink / white-underbase channel */
  generateWhite:     boolean;
  /** Whether to generate a UV varnish spot channel */
  generateVarnish:   boolean;
  /** Whether to generate a foil/metallic spot channel */
  generateFoil:      boolean;
  /** White-channel choke (inward shrink) in pixels */
  choke:             number;
  /** White-channel expand (outward grow) in pixels */
  expand:            number;
  /** Whether to preserve soft fades and gradients in masks */
  preserveFades:     boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core types
// ─────────────────────────────────────────────────────────────────────────────

/** Which print-mode family an action pack belongs to. */
export type PrintModeKey = 'DTF' | 'UV' | 'UVDTF' | 'LASER' | 'ANY';

/** Severity of a step result — mirrors Prep Studio audit log. */
export type StepSeverity = 'info' | 'warning' | 'error';

/** A single atomic operation inside an action pack. */
export interface ActionStep {
  /**
   * Stable machine-readable ID. Used as a key in audit logs and progress
   * callbacks.  Must be unique within a pack; recommended format: VERB_NOUN.
   */
  id: string;

  /** Human-readable label shown in the Prep Studio Pro panel during execution. */
  label: string;

  /**
   * Full description for tooltip / documentation display.
   * Should explain what Photoshop operation is performed and why.
   */
  description: string;

  /**
   * Photoshop API surface used to implement this step.
   *   "dom"        — UXP Photoshop DOM APIs (layer, document, pixel manipulation)
   *   "batchPlay"  — Action Manager descriptor via batchPlay()
   *   "hybrid"     — uses both (e.g. selects via DOM, applies via batchPlay)
   */
  apiSurface: 'dom' | 'batchPlay' | 'hybrid';

  /**
   * The `JobRecipe` fields that parametrize this step.
   * A step with an empty array uses a fixed internal constant and is NOT
   * affected by the recipe (e.g. color-mode conversion always targets RGBA).
   */
  recipeFields: Array<keyof JobRecipe>;

  /**
   * How the recipe fields map to step parameters.
   * Keys are parameter names internal to the step; values are expressions
   * that derive them from one or more recipe fields.
   *
   * Convention for expressions:
   *   - Bare field name:     direct pass-through  (e.g. "recipe.choke")
   *   - Math expression:     e.g. "Math.round(recipe.cleanupLevel * 2.55)"
   *   - Conditional:         e.g. "recipe.preserveFades ? 'linear' : 'hard'"
   */
  parameterMapping: Record<string, string>;

  /**
   * Whether this step may be skipped based on recipe values.
   * A skippable step defines a `skipWhen` guard expression.
   * Non-skippable steps always execute (e.g. convert-to-RGB is always required).
   */
  skippable: boolean;

  /**
   * JavaScript guard expression (evaluated against the recipe) that, when
   * truthy, causes the step to be skipped.
   * Only relevant when `skippable === true`.
   * Examples:
   *   "!recipe.backgroundRemoved"
   *   "!recipe.generateWhite"
   *   "recipe.cleanupLevel < 10"
   */
  skipWhen?: string;

  /**
   * Estimated contribution to overall pack progress (0–100, unitless weight).
   * Used by the progress bar; all weights in a pack should sum to 100.
   */
  progressWeight: number;
}

/** Possible UXP execution contexts for the full pack. */
export type ExecutionContext = 'activeDocument' | 'newDocument' | 'any';

/** Full definition of a named action pack. */
export interface ActionPack {
  /**
   * Stable machine-readable ID used as a key in the UXP panel registry.
   * Format: SCREAMING_SNAKE_CASE
   */
  id: string;

  /** Display name shown in the Prep Studio Pro panel. */
  label: string;

  /**
   * Detailed purpose statement.  Answers: "What does this pack prepare the
   * artwork for, and what does a complete run guarantee about the output?"
   */
  purpose: string;

  /** Which InvoFlow OS print-mode key triggers this pack automatically. */
  triggerPrintMode: PrintModeKey;

  // ── Input contract ─────────────────────────────────────────────────────────

  /**
   * Expected Photoshop document state before the pack is run.
   * The panel MUST validate these conditions and block execution if any fail.
   */
  expectedInput: {
    /** Required color mode of the open document. */
    colorMode: 'RGB' | 'CMYK' | 'Grayscale' | 'any';
    /** Required bits-per-channel. */
    bitsPerChannel: 8 | 16 | 32 | 'any';
    /** Whether an alpha / transparency channel must be present. */
    requiresAlpha: boolean;
    /** Whether a smart object or embedded layer is acceptable as source. */
    acceptsSmartObject: boolean;
    /** Minimum DPI required. 0 = no minimum. */
    minDpi: number;
    /** Free-form notes on input expectations shown to the operator. */
    notes: string[];
  };

  // ── Output contract ────────────────────────────────────────────────────────

  /**
   * Guaranteed document state after a successful pack run.
   * The panel verifies these postconditions before enabling the Upload button.
   */
  expectedOutput: {
    /** Output color mode. */
    colorMode: 'RGB' | 'CMYK' | 'Grayscale';
    /** Output bits-per-channel. */
    bitsPerChannel: 8 | 16;
    /**
     * Named layers / channels that MUST exist in the output document.
     * The panel checks for these by name after execution.
     */
    requiredLayers: string[];
    /**
     * Named layers / channels that are present only when the recipe dictates.
     * Format: `"<layerName> when <recipeCondition>"`
     */
    conditionalLayers: string[];
    /** File formats the finished document may be exported as. */
    acceptedExportFormats: Array<'TIFF' | 'PSD' | 'PNG' | 'PDF' | 'SVG'>;
    /** Free-form notes on output guarantees shown to the operator. */
    notes: string[];
  };

  // ── Recipe field usage ─────────────────────────────────────────────────────

  /**
   * All `JobRecipe` fields consumed by at least one step in this pack.
   * Serves as a quick-reference for the panel to highlight which recipe
   * values are relevant when the pack is selected.
   */
  usedRecipeFields: Array<keyof JobRecipe>;

  /** The ordered sequence of steps that constitute this pack. */
  steps: ActionStep[];

  /**
   * Execution context required by this pack.
   * "activeDocument" — operates on whatever document is currently open.
   */
  executionContext: ExecutionContext;

  /**
   * Whether the pack creates a working copy of the document before running,
   * leaving the original untouched.
   */
  createsWorkingCopy: boolean;

  /**
   * Maximum time in seconds the pack is expected to take on a
   * reference machine (2021 M1 MacBook Pro, 300 DPI A4 document).
   * Used to calibrate the panel's timeout guard.
   */
  estimatedDurationSeconds: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper — derive Photoshop choke/spread radius from recipe
// These expressions are stored as strings in `parameterMapping` so the
// generated UXP code can eval() them at runtime with the live recipe object.
// ─────────────────────────────────────────────────────────────────────────────

const EXPR = {
  /** cleanupLevel 0-100 → Gaussian blur radius 0-5 px (subtle artifact removal) */
  blurRadius:      'Math.round(recipe.cleanupLevel / 20)',
  /** cleanupLevel 0-100 → Dust & Scratches radius 1-4 px */
  dustRadius:      'Math.max(1, Math.round(recipe.cleanupLevel / 25))',
  /** cleanupLevel 0-100 → black threshold for cleanup mask (0=lenient, 255=strict) */
  cleanupThresh:   'Math.round(recipe.cleanupLevel * 2.0)',
  /** edgeStrength 0-100 → Unsharp Mask amount % */
  usmAmount:       'Math.round(recipe.edgeStrength * 1.5)',
  /** edgeStrength 0-100 → Unsharp Mask radius px (0.3–3.0) */
  usmRadius:       '(0.3 + recipe.edgeStrength / 50).toFixed(1)',
  /** choke px — direct pass-through */
  choke:           'recipe.choke',
  /** expand px — direct pass-through */
  expand:          'recipe.expand',
  /** preserveFades → layer mask feather amount */
  fadeFeather:     'recipe.preserveFades ? 4 : 0',
  /** preserveFades → luminosity blend mode string */
  blendMode:       "recipe.preserveFades ? 'luminosity' : 'normal'",
  /** backgroundRemoved guard */
  skipIfNoBgRemov: '!recipe.backgroundRemoved',
  /** generateWhite guard */
  skipIfNoWhite:   '!recipe.generateWhite',
  /** generateVarnish guard */
  skipIfNoVarnish: '!recipe.generateVarnish',
  /** generateFoil guard */
  skipIfNoFoil:    '!recipe.generateFoil',
};

// ─────────────────────────────────────────────────────────────────────────────
// ACTION PACK 1 — DTF_PREP
// ─────────────────────────────────────────────────────────────────────────────

export const DTF_PREP_PACK: ActionPack = {
  id:              'DTF_PREP',
  label:           'DTF Prep',
  triggerPrintMode: 'DTF',
  executionContext: 'activeDocument',
  createsWorkingCopy: true,
  estimatedDurationSeconds: 45,

  purpose: `
    Prepares artwork for Direct-to-Film (DTF) printing.

    DTF transfers require a clean RGBA file with:
      • A transparent background (no white fill or substrate simulation)
      • A W1 white-ink channel derived from artwork luminosity
      • Sharp, well-defined edges that hold up at print resolution
      • No residual halos, low-opacity fringe pixels, or semi-transparent noise

    A complete DTF_PREP run guarantees:
      1. Background is fully removed and document is in 8-bit RGBA mode
      2. Edge-cleanup pass removes sub-threshold pixel fringe based on cleanupLevel
      3. W1 White Ink channel is generated from luminosity (if generateWhite is true)
      4. Choke / expand applied to W1 mask to ensure white underbase coverage
      5. Unsharp mask applied to artwork channels at edgeStrength-derived parameters
      6. Document is ready to export as TIFF or PNG for RIP software ingestion
  `.trim(),

  expectedInput: {
    colorMode:        'RGB',
    bitsPerChannel:   8,
    requiresAlpha:    false,
    acceptsSmartObject: false,
    minDpi:           150,
    notes: [
      'Source should be a flattened or merged composite layer before running',
      'Smart Objects must be rasterized first (panel will prompt)',
      'Background layer will be automatically unlocked if locked',
      'CMYK documents are auto-converted to RGB 8-bit at pack start',
    ],
  },

  expectedOutput: {
    colorMode:      'RGB',
    bitsPerChannel:  8,
    requiredLayers:  ['Artwork', 'W1 White'],
    conditionalLayers: [
      'W1 White — present when recipe.generateWhite === true',
      'Varnish — present when recipe.generateVarnish === true',
    ],
    acceptedExportFormats: ['TIFF', 'PNG', 'PSD'],
    notes: [
      'Output has a transparent background (Alpha channel active)',
      'W1 White layer is a luminosity-derived grayscale mask in Multiply mode',
      'Choke/expand applied as layer mask on W1 White per recipe values',
      'Document will NOT be flattened — export step handles merging per RIP requirements',
    ],
  },

  usedRecipeFields: [
    'backgroundRemoved',
    'cleanupLevel',
    'edgeStrength',
    'generateWhite',
    'generateVarnish',
    'choke',
    'expand',
    'preserveFades',
  ],

  steps: [
    {
      id:          'CONVERT_RGB',
      label:       'Convert to RGB 8-bit',
      description: 'Ensures the document is in RGB color mode at 8 bits per channel. '
                 + 'Converts from CMYK, Grayscale, or 16-bit if needed. This step is always '
                 + 'required regardless of recipe values.',
      apiSurface:  'batchPlay',
      recipeFields: [],
      parameterMapping: {},
      skippable:   false,
      progressWeight: 4,
    },
    {
      id:          'UNLOCK_BACKGROUND',
      label:       'Unlock background layer',
      description: 'Converts the locked "Background" layer to a normal layer named "Artwork" '
                 + 'so that transparency operations can be applied.',
      apiSurface:  'dom',
      recipeFields: [],
      parameterMapping: {},
      skippable:   true,
      skipWhen:    'doc.backgroundLayer === null',
      progressWeight: 2,
    },
    {
      id:          'REMOVE_BACKGROUND',
      label:       'Remove background',
      description: 'Removes the document background. For raster art, applies a subject-selection '
                 + 'plus refine-edge pass. For logos/vectors, applies a color-range selection on '
                 + 'the substrate color. Uses Photoshop Remove Background (Neural Filter) when '
                 + 'available, falling back to Select Subject + Refine Mask.',
      apiSurface:  'hybrid',
      recipeFields: ['backgroundRemoved', 'cleanupLevel'],
      parameterMapping: {
        enabled:        'recipe.backgroundRemoved',
        refineTolerance: EXPR.cleanupThresh,
      },
      skippable:   true,
      skipWhen:    EXPR.skipIfNoBgRemov,
      progressWeight: 18,
    },
    {
      id:          'CLEANUP_FRINGE',
      label:       'Remove edge fringe',
      description: 'Applies a contract-selection + Minimum filter pass to the layer mask to '
                 + 'eliminate semi-transparent fringe pixels left by background removal. '
                 + 'Radius is derived from cleanupLevel (higher = more aggressive contraction).',
      apiSurface:  'batchPlay',
      recipeFields: ['cleanupLevel'],
      parameterMapping: {
        contractPx: EXPR.blurRadius,
        threshold:  EXPR.cleanupThresh,
      },
      skippable:   true,
      skipWhen:    'recipe.cleanupLevel < 5',
      progressWeight: 8,
    },
    {
      id:          'REMOVE_DUST',
      label:       'Remove dust & artifacts',
      description: 'Runs a Dust & Scratches filter on the artwork layer to remove isolated '
                 + 'pixel noise. Radius and threshold are derived from cleanupLevel.',
      apiSurface:  'batchPlay',
      recipeFields: ['cleanupLevel'],
      parameterMapping: {
        radius:    EXPR.dustRadius,
        threshold: 'Math.round(recipe.cleanupLevel / 10)',
      },
      skippable:   true,
      skipWhen:    'recipe.cleanupLevel < 20',
      progressWeight: 6,
    },
    {
      id:          'SHARPEN_EDGES',
      label:       'Sharpen edges',
      description: 'Applies Unsharp Mask to the composite artwork channels using parameters '
                 + 'derived from edgeStrength. Higher edgeStrength → higher amount and radius. '
                 + 'Skipped when edgeStrength is below 10 (no meaningful sharpening needed).',
      apiSurface:  'batchPlay',
      recipeFields: ['edgeStrength'],
      parameterMapping: {
        amount:    EXPR.usmAmount,
        radius:    EXPR.usmRadius,
        threshold: '2',
      },
      skippable:   true,
      skipWhen:    'recipe.edgeStrength < 10',
      progressWeight: 8,
    },
    {
      id:          'GENERATE_W1',
      label:       'Generate W1 white ink channel',
      description: 'Creates a new layer group "W1 White" containing a luminosity-derived grayscale '
                 + 'layer in Multiply blend mode. This represents the white ink underbase that '
                 + 'DTF RIP software ingests as the opacity map for white ink placement. '
                 + 'Soft fades are preserved when recipe.preserveFades is true (feathered mask '
                 + 'vs. hard-edge mask). Choke and expand are applied to the mask.',
      apiSurface:  'hybrid',
      recipeFields: ['generateWhite', 'choke', 'expand', 'preserveFades'],
      parameterMapping: {
        enabled:     'recipe.generateWhite',
        chokePx:     EXPR.choke,
        expandPx:    EXPR.expand,
        feather:     EXPR.fadeFeather,
        blendMode:   EXPR.blendMode,
      },
      skippable:   true,
      skipWhen:    EXPR.skipIfNoWhite,
      progressWeight: 22,
    },
    {
      id:          'GENERATE_VARNISH',
      label:       'Generate varnish channel',
      description: 'Creates a "Varnish" spot channel layer representing the UV varnish overprint '
                 + 'mask. For DTF this is an optional accent. The channel is built from the '
                 + 'artwork alpha channel with a small positive expand applied.',
      apiSurface:  'hybrid',
      recipeFields: ['generateVarnish', 'expand'],
      parameterMapping: {
        enabled:  'recipe.generateVarnish',
        expandPx: EXPR.expand,
      },
      skippable:   true,
      skipWhen:    EXPR.skipIfNoVarnish,
      progressWeight: 8,
    },
    {
      id:          'PREFLIGHT_CHECK',
      label:       'Run preflight check',
      description: 'Verifies the finished document meets DTF output requirements: '
                 + 'alpha channel present, no locked layers, W1 layer exists if recipe requires it, '
                 + 'no remaining white background areas. Writes results to the Prep Studio '
                 + 'panel audit log.',
      apiSurface:  'dom',
      recipeFields: ['generateWhite', 'backgroundRemoved'],
      parameterMapping: {
        requireAlpha: 'true',
        requireW1:    'recipe.generateWhite',
      },
      skippable:   false,
      progressWeight: 12,
    },
    {
      id:          'RENAME_DOCUMENT',
      label:       'Rename & mark ready',
      description: 'Appends "-DTF-READY" to the document title and writes a metadata note '
                 + 'to the document\'s file info (IPTC description field) recording the '
                 + 'InvoFlow job ID, recipe version, and timestamp.',
      apiSurface:  'batchPlay',
      recipeFields: [],
      parameterMapping: {},
      skippable:   false,
      progressWeight: 12,
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// ACTION PACK 2 — UV_PREP
// ─────────────────────────────────────────────────────────────────────────────

export const UV_PREP_PACK: ActionPack = {
  id:              'UV_PREP',
  label:           'UV Prep',
  triggerPrintMode: 'UV',
  executionContext: 'activeDocument',
  createsWorkingCopy: true,
  estimatedDurationSeconds: 55,

  purpose: `
    Prepares artwork for UV flatbed and UV-DTF printing.

    UV printing differs from DTF in three critical ways:
      • The substrate is rigid or semi-rigid — artwork is often NOT transparent-background
      • CMYK color mode is native; RGB is converted at the end if the RIP requires it
      • Spot channels (varnish, foil, W1) are used as true Photoshop spot channels,
        not as regular layers

    A complete UV_PREP run guarantees:
      1. Document is in CMYK 8-bit mode (converted from RGB if needed)
      2. Soft gradients and fades are preserved (recipe.preserveFades drives this)
      3. W1 white underbase spot channel created if recipe.generateWhite is true
      4. Varnish spot channel created if recipe.generateVarnish is true
      5. Foil / metallic spot channel created if recipe.generateFoil is true
      6. All spot channels have choke/expand masks per recipe values
      7. Document is export-ready as TIFF (with spot channels) or PSD
  `.trim(),

  expectedInput: {
    colorMode:        'any',
    bitsPerChannel:   'any',
    requiresAlpha:    false,
    acceptsSmartObject: false,
    minDpi:           150,
    notes: [
      'RGB documents are converted to CMYK 8-bit at pack start using the workspace profile',
      'Background may remain — UV prints directly onto substrate',
      'Smart Objects must be rasterized before spot channels can be added',
      'Embedded ICC profile is preserved through conversion',
    ],
  },

  expectedOutput: {
    colorMode:      'CMYK',
    bitsPerChannel:  8,
    requiredLayers:  ['Artwork'],
    conditionalLayers: [
      'W1 White — spot channel present when recipe.generateWhite === true',
      'Varnish — spot channel present when recipe.generateVarnish === true',
      'Foil — spot channel present when recipe.generateFoil === true',
    ],
    acceptedExportFormats: ['TIFF', 'PSD', 'PDF'],
    notes: [
      'Spot channels are saved as true Photoshop spot color channels (not alpha channels)',
      'Varnish channel uses custom ink color #FFEB3B (yellow preview) at 100% solidity',
      'Foil channel uses custom ink color #C0C0C0 (silver preview) at 100% solidity',
      'W1 channel uses custom ink color #FFFFFF (white preview) at 100% solidity',
      'Exported TIFF must use "Save with spot colors" option for RIP compatibility',
    ],
  },

  usedRecipeFields: [
    'backgroundRemoved',
    'cleanupLevel',
    'edgeStrength',
    'generateWhite',
    'generateVarnish',
    'generateFoil',
    'choke',
    'expand',
    'preserveFades',
  ],

  steps: [
    {
      id:          'CONVERT_CMYK',
      label:       'Convert to CMYK 8-bit',
      description: 'Converts the document to CMYK color mode using the active workspace color '
                 + 'profile. 16-bit documents are downsampled to 8-bit. The conversion preserves '
                 + 'embedded ICC profiles where possible.',
      apiSurface:  'batchPlay',
      recipeFields: [],
      parameterMapping: {},
      skippable:   false,
      progressWeight: 5,
    },
    {
      id:          'UNLOCK_BACKGROUND',
      label:       'Unlock background layer',
      description: 'Converts the locked "Background" layer to an editable layer named "Artwork". '
                 + 'Required before spot channels or masks can be applied.',
      apiSurface:  'dom',
      recipeFields: [],
      parameterMapping: {},
      skippable:   true,
      skipWhen:    'doc.backgroundLayer === null',
      progressWeight: 2,
    },
    {
      id:          'REMOVE_BACKGROUND_UV',
      label:       'Remove background (UV)',
      description: 'Removes the background only when recipe.backgroundRemoved is true — '
                 + 'many UV prints include the substrate background intentionally. '
                 + 'Uses a combination of Select Subject and a Magic Eraser pass.',
      apiSurface:  'hybrid',
      recipeFields: ['backgroundRemoved', 'cleanupLevel'],
      parameterMapping: {
        enabled:   'recipe.backgroundRemoved',
        tolerance: EXPR.cleanupThresh,
      },
      skippable:   true,
      skipWhen:    EXPR.skipIfNoBgRemov,
      progressWeight: 12,
    },
    {
      id:          'PRESERVE_FADES',
      label:       'Configure fade / gradient handling',
      description: 'When recipe.preserveFades is true, switches the cleanup and masking '
                 + 'strategy to preserve gradient transparency. Soft masks use feathered '
                 + 'edges rather than hard threshold cuts. Directly affects how W1/Varnish '
                 + 'channels are built in subsequent steps.',
      apiSurface:  'dom',
      recipeFields: ['preserveFades'],
      parameterMapping: {
        featherAmount: EXPR.fadeFeather,
        blendMode:     EXPR.blendMode,
      },
      skippable:   true,
      skipWhen:    '!recipe.preserveFades',
      progressWeight: 4,
    },
    {
      id:          'SHARPEN_EDGES_UV',
      label:       'Sharpen edges (UV)',
      description: 'Applies Unsharp Mask to all CMYK channels. UV prints at high resolution '
                 + 'on rigid substrates — fine edges are critical for registration accuracy. '
                 + 'Parameters derived from recipe.edgeStrength.',
      apiSurface:  'batchPlay',
      recipeFields: ['edgeStrength'],
      parameterMapping: {
        amount:    EXPR.usmAmount,
        radius:    EXPR.usmRadius,
        threshold: '1',
      },
      skippable:   true,
      skipWhen:    'recipe.edgeStrength < 10',
      progressWeight: 7,
    },
    {
      id:          'CREATE_W1_SPOT',
      label:       'Create W1 white spot channel',
      description: 'Adds a Photoshop spot color channel named "W1 White" with ink color #FFFFFF. '
                 + 'The channel content is derived from the artwork luminosity map. '
                 + 'Choke/expand from the recipe are applied as a pixel-level shrink/grow '
                 + 'using the Minimum/Maximum filters respectively. '
                 + 'Soft-fade mode uses a Gaussian blur mask instead of a hard threshold.',
      apiSurface:  'hybrid',
      recipeFields: ['generateWhite', 'choke', 'expand', 'preserveFades'],
      parameterMapping: {
        enabled:      'recipe.generateWhite',
        inkColor:     '"#FFFFFF"',
        solidity:     '100',
        chokePx:      EXPR.choke,
        expandPx:     EXPR.expand,
        softFade:     'recipe.preserveFades',
        feather:      EXPR.fadeFeather,
      },
      skippable:   true,
      skipWhen:    EXPR.skipIfNoWhite,
      progressWeight: 16,
    },
    {
      id:          'CREATE_VARNISH_SPOT',
      label:       'Create varnish spot channel',
      description: 'Adds a spot color channel named "Varnish" with preview ink color #FFEB3B '
                 + '(yellow, 100% solidity). Content mirrors the artwork alpha or, when '
                 + 'backgroundRemoved is false, is built from a luminosity threshold. '
                 + 'Expand from the recipe ensures the varnish slightly overprints the '
                 + 'CMYK artwork to prevent gap rings on the finished print.',
      apiSurface:  'hybrid',
      recipeFields: ['generateVarnish', 'expand', 'backgroundRemoved'],
      parameterMapping: {
        enabled:   'recipe.generateVarnish',
        inkColor:  '"#FFEB3B"',
        solidity:  '100',
        expandPx:  EXPR.expand,
      },
      skippable:   true,
      skipWhen:    EXPR.skipIfNoVarnish,
      progressWeight: 14,
    },
    {
      id:          'CREATE_FOIL_SPOT',
      label:       'Create foil spot channel',
      description: 'Adds a spot color channel named "Foil" with preview ink color #C0C0C0 '
                 + '(silver, 100% solidity). The foil mask is derived from selected '
                 + 'highlight areas (luminosity > 200) or from an operator-selected layer '
                 + 'if one is pre-named "Foil Source" in the document.',
      apiSurface:  'hybrid',
      recipeFields: ['generateFoil', 'choke'],
      parameterMapping: {
        enabled:  'recipe.generateFoil',
        inkColor: '"#C0C0C0"',
        solidity: '100',
        chokePx:  EXPR.choke,
      },
      skippable:   true,
      skipWhen:    EXPR.skipIfNoFoil,
      progressWeight: 12,
    },
    {
      id:          'PREFLIGHT_CHECK_UV',
      label:       'Run UV preflight check',
      description: 'Validates the document for UV output: CMYK mode confirmed, '
                 + 'required spot channels present, no RGB layers remaining (embedded '
                 + 'Smart Objects would cause profile mismatch on export), '
                 + 'no overflowing ink coverage (total ink ≤ 320%).',
      apiSurface:  'dom',
      recipeFields: ['generateWhite', 'generateVarnish', 'generateFoil'],
      parameterMapping: {
        checkW1:      'recipe.generateWhite',
        checkVarnish: 'recipe.generateVarnish',
        checkFoil:    'recipe.generateFoil',
        maxInkPct:    '320',
      },
      skippable:   false,
      progressWeight: 14,
    },
    {
      id:          'RENAME_DOCUMENT_UV',
      label:       'Rename & mark ready',
      description: 'Appends "-UV-READY" to the document title and writes InvoFlow '
                 + 'job ID, recipe version, and timestamp to the document IPTC metadata.',
      apiSurface:  'batchPlay',
      recipeFields: [],
      parameterMapping: {},
      skippable:   false,
      progressWeight: 14,
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// ACTION PACK 3 — GENERAL_CLEANUP
// ─────────────────────────────────────────────────────────────────────────────

export const GENERAL_CLEANUP_PACK: ActionPack = {
  id:              'GENERAL_CLEANUP',
  label:           'General Cleanup',
  triggerPrintMode: 'ANY',
  executionContext: 'activeDocument',
  createsWorkingCopy: false,
  estimatedDurationSeconds: 20,

  purpose: `
    Substrate-agnostic artwork cleanup designed to run as either:
      (a) A standalone quick-clean before a full DTF or UV prep pass, or
      (b) An automated pre-step triggered by any print mode when the
          InvoFlow preflight score is below 70 (indicating cleanup is needed).

    The pack applies only non-destructive, recipe-parametric cleanup operations:
      • Dust & artifact removal (cleanupLevel-scaled)
      • Edge refinement and fringe cleanup
      • Optional background removal (backgroundRemoved)
      • Sharpening pass (edgeStrength-scaled)

    It does NOT create white, varnish, or foil channels — those belong to the
    mode-specific packs above.  It does NOT convert color modes.

    After GENERAL_CLEANUP the document is ready to hand off to DTF_PREP or
    UV_PREP, or to export directly if no further mode-specific processing is needed.
  `.trim(),

  expectedInput: {
    colorMode:        'any',
    bitsPerChannel:   'any',
    requiresAlpha:    false,
    acceptsSmartObject: false,
    minDpi:           0,
    notes: [
      'Operates on whatever document is currently open — mode and depth are not changed',
      'Smart Objects should be rasterized if edge cleanup is required',
      'Safe to run multiple times (operations are idempotent at the same cleanupLevel)',
    ],
  },

  expectedOutput: {
    colorMode:      'RGB',
    bitsPerChannel:  8,
    requiredLayers:  [],
    conditionalLayers: [],
    acceptedExportFormats: ['TIFF', 'PNG', 'PSD', 'PDF'],
    notes: [
      'Color mode and depth are unchanged from input — output colorMode above is informational',
      'Document is cleaner, sharper, and has reduced pixel noise',
      'No spot channels or mode-specific layers are created',
    ],
  },

  usedRecipeFields: [
    'backgroundRemoved',
    'cleanupLevel',
    'edgeStrength',
    'preserveFades',
  ],

  steps: [
    {
      id:          'DEFRINGE',
      label:       'Defringe layer edges',
      description: 'Applies Layer > Matting > Defringe with a radius derived from cleanupLevel '
                 + 'to remove color-bleed halos. Operates on all non-background raster layers.',
      apiSurface:  'batchPlay',
      recipeFields: ['cleanupLevel'],
      parameterMapping: {
        radius: 'Math.max(1, Math.round(recipe.cleanupLevel / 30))',
      },
      skippable:   true,
      skipWhen:    'recipe.cleanupLevel < 10',
      progressWeight: 15,
    },
    {
      id:          'DUST_SCRATCH',
      label:       'Remove dust & scratches',
      description: 'Applies Dust & Scratches filter to composite pixels. Radius and threshold '
                 + 'are scaled from cleanupLevel.',
      apiSurface:  'batchPlay',
      recipeFields: ['cleanupLevel'],
      parameterMapping: {
        radius:    EXPR.dustRadius,
        threshold: 'Math.round(recipe.cleanupLevel / 10)',
      },
      skippable:   true,
      skipWhen:    'recipe.cleanupLevel < 15',
      progressWeight: 20,
    },
    {
      id:          'REMOVE_BG_CLEANUP',
      label:       'Remove background',
      description: 'Subject-select + Refine Mask background removal. Applied only when '
                 + 'recipe.backgroundRemoved is true.',
      apiSurface:  'hybrid',
      recipeFields: ['backgroundRemoved', 'cleanupLevel'],
      parameterMapping: {
        enabled:   'recipe.backgroundRemoved',
        tolerance: EXPR.cleanupThresh,
      },
      skippable:   true,
      skipWhen:    EXPR.skipIfNoBgRemov,
      progressWeight: 30,
    },
    {
      id:          'SHARPEN_CLEANUP',
      label:       'Sharpen edges',
      description: 'Applies Smart Sharpen (or Unsharp Mask) scaled from recipe.edgeStrength. '
                 + 'Uses a Luminosity blend to prevent color fringing on saturated artwork.',
      apiSurface:  'batchPlay',
      recipeFields: ['edgeStrength'],
      parameterMapping: {
        amount:    EXPR.usmAmount,
        radius:    EXPR.usmRadius,
        threshold: '2',
      },
      skippable:   true,
      skipWhen:    'recipe.edgeStrength < 10',
      progressWeight: 20,
    },
    {
      id:          'CLEANUP_REPORT',
      label:       'Write cleanup report',
      description: 'Writes a short summary of all applied steps and skipped steps to the '
                 + 'Prep Studio Pro panel audit log, along with the pre/post pixel noise '
                 + 'delta if measurable.',
      apiSurface:  'dom',
      recipeFields: [],
      parameterMapping: {},
      skippable:   false,
      progressWeight: 15,
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Pack registry — single lookup table used by the panel
// ─────────────────────────────────────────────────────────────────────────────

export const ACTION_PACK_REGISTRY: Record<string, ActionPack> = {
  [DTF_PREP_PACK.id]:       DTF_PREP_PACK,
  [UV_PREP_PACK.id]:        UV_PREP_PACK,
  [GENERAL_CLEANUP_PACK.id]: GENERAL_CLEANUP_PACK,
};

/**
 * Resolve which action pack should run for a given print-mode key.
 *
 * Resolution order:
 *   1. Exact match on `triggerPrintMode`
 *   2. 'UVDTF' maps to UV_PREP (closest output profile)
 *   3. 'ANY' packs are never auto-resolved — they must be called explicitly
 *
 * Returns `null` if no pack handles the given mode.
 */
export function resolvePackForPrintMode(printMode: string): ActionPack | null {
  const direct = Object.values(ACTION_PACK_REGISTRY).find(
    p => p.triggerPrintMode === printMode,
  );
  if (direct) return direct;

  if (printMode === 'UVDTF') return UV_PREP_PACK;

  return null;
}

/**
 * Returns the subset of ActionSteps that will actually execute given a recipe.
 * Evaluates each step's `skipWhen` expression against the recipe.
 *
 * NOTE: This is a preview utility for the panel UI — the UXP runtime must
 * perform its own evaluation at execution time using the live Photoshop
 * document state.
 */
export function getActiveSteps(pack: ActionPack, recipe: JobRecipe): ActionStep[] {
  return pack.steps.filter(step => {
    if (!step.skippable || !step.skipWhen) return true;
    try {
      const fn = new Function('recipe', `return !!(${step.skipWhen})`);
      return !fn(recipe);
    } catch {
      return true;
    }
  });
}

/**
 * Returns the total estimated progress weight for the active steps,
 * normalised so that the first step starts at 0 and the last ends at 100.
 */
export function buildProgressMap(
  pack: ActionPack,
  recipe: JobRecipe,
): Array<{ stepId: string; startPct: number; endPct: number }> {
  const active = getActiveSteps(pack, recipe);
  const totalWeight = active.reduce((s, st) => s + st.progressWeight, 0);
  let cursor = 0;
  return active.map(step => {
    const startPct = Math.round((cursor / totalWeight) * 100);
    cursor += step.progressWeight;
    const endPct = Math.round((cursor / totalWeight) * 100);
    return { stepId: step.id, startPct, endPct };
  });
}
