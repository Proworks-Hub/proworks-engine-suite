// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import {
  type MachineClass,
  type ProductionAsset,
  type ProductionAssetManifest,
} from "./productionAsset.js";

// ─────────────────────────────────────────────────────────────────────────────
// What a preparation run produced.
//
// PROMOTED, NOT INVENTED. This shape already existed in three places:
//
//   ksix-prep-studio/types/PrepResult.ts    the canonical definition
//   prep-studio/types/PrepResult.ts         a deprecated shim re-exporting it
//   prowork-hub .../types/PrepResult.ts     an independent copy
//
// The canonical one and ProWorks' copy were compared field by field and are
// IDENTICAL — no drift, despite living in separate repositories with no shared
// package between them. That is the argument for promoting it rather than
// designing something new: two teams already agree, and fourteen ProWorks
// components consume it today.
//
// HOW IT RELATES TO ProductionAssetManifest. They are complementary, not
// competing, and conflating them would lose something real:
//
//   PrepResult  — the OUTCOME of preparing one asset. Carries the judgement:
//                 readiness, issues, recommendations, which recipe ran.
//   Manifest    — the SET of files that reach machines, and what each is for.
//
// A PrepResult answers "did this go well and what should somebody know". A
// manifest answers "what do I send, and where". `prepResultToProductionAsset`
// below bridges them without merging them.
// ─────────────────────────────────────────────────────────────────────────────

export const prepIssueSeveritySchema = z.enum(["info", "warning", "critical"]);
export type PrepIssueSeverity = z.infer<typeof prepIssueSeveritySchema>;

export const prepIssueSchema = z
  .object({
    /** Open string: the taxonomy lives in the engine and grows faster than this. */
    type: z.string().min(1),
    severity: prepIssueSeveritySchema,
    message: z.string(),
  })
  .strict();
export type PrepIssue = z.infer<typeof prepIssueSchema>;

export const prepRecommendationSchema = z
  .object({
    type: z.string().min(1),
    message: z.string(),
  })
  .strict();
export type PrepRecommendation = z.infer<typeof prepRecommendationSchema>;

/**
 * Where a prep result came from.
 *
 * Kept as an open string rather than the original two-value union. The union
 * named two specific Studios, and the whole point of extracting VisionIQ is
 * that a third party can produce one of these — a closed list would make the
 * contract refuse the licensee it was extracted for.
 */
export const prepSourceSchema = z.string().min(1);

export const CURRENT_PREP_RESULT_SCHEMA_VERSION = 2;

export const prepResultSchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.number().optional(),
    /** The tenant. Named `workspaceId` because that is what both hosts call it. */
    workspaceId: z.string().min(1),
    userId: z.string().optional(),
    source: prepSourceSchema,
    /** Preserved verbatim — the customer's own filename, never parsed for meaning. */
    originalFileName: z.string(),
    processedFileUrl: z.string(),
    previewUrl: z.string().optional(),
    fileType: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    /**
     * Effective resolution at production size, not a declared metadata value.
     *
     * The distinction the directive is emphatic about: re-stamping a file's
     * header to 300 does not create detail, and a consumer that cannot tell the
     * two apart will believe a 72 DPI photo is print-ready.
     */
    dpi: z.number().optional(),
    colorProfile: z.string().optional(),
    machinePreset: z.string().optional(),
    /** 0–100. How ready this is to run, in the engine's own judgement. */
    readinessScore: z.number().optional(),
    issues: z.array(prepIssueSchema),
    recommendations: z.array(prepRecommendationSchema),
    /** Which recipe actually ran. */
    recipeUsed: z.string().optional(),
    /** Which one was asked for — differs when a migration redirected it. */
    recipeRequested: z.string().optional(),
    /** The recipe this one superseded. Recipes have already migrated once. */
    recipeMigrationFrom: z.string().optional(),
    processingTime: z.number().optional(),
    createdAt: z.string(),
  })
  .strict();
export type PrepResult = z.infer<typeof prepResultSchema>;

export const prepResultInboundPayloadSchema = z
  .object({
    prepResult: prepResultSchema,
    quoteId: z.string().optional(),
    workOrderId: z.string().optional(),
  })
  .strict();
export type PrepResultInboundPayload = z.infer<typeof prepResultInboundPayloadSchema>;

export function validatePrepResult(input: unknown): PrepResult {
  return prepResultSchema.parse(input);
}

/**
 * Whether this result should run without a human looking first.
 *
 * A `critical` issue blocks regardless of score, because a high score with a
 * critical issue means the scorer and the checker disagree — and when they
 * disagree the safe reading is the pessimistic one.
 */
export function isProductionReady(result: PrepResult, minimumScore = 70): boolean {
  if (result.issues.some((issue) => issue.severity === "critical")) return false;
  if (result.readinessScore === undefined) return false;
  return result.readinessScore >= minimumScore;
}

/** Issues a person must resolve, worst first. */
export function blockingIssues(result: PrepResult): PrepIssue[] {
  return result.issues.filter((issue) => issue.severity === "critical");
}

/**
 * Turns a prep result into the production asset a manifest carries.
 *
 * The bridge between the two contracts. `machineClass` is supplied by the
 * caller rather than parsed out of `machinePreset`: a preset name is a host's
 * label — "DTF", "LASER_ENGRAVING", whatever a shop typed — and inferring a
 * machine class from it would be filename-sniffing wearing a different hat.
 *
 * Returns `undefined` when there is no processed file, because a prep run that
 * produced only findings has no asset to put in a manifest, and inventing an
 * entry with an empty URI would put a broken row in front of an operator.
 */
export function prepResultToProductionAsset(
  result: PrepResult,
  machineClass: MachineClass,
  role: ProductionAsset["role"] = "print",
): ProductionAsset | undefined {
  if (!result.processedFileUrl) return undefined;

  return {
    assetId: result.id,
    role,
    machineClass,
    uri: result.processedFileUrl,
    filename: result.originalFileName,
    mediaType: result.fileType ?? "application/octet-stream",
    ...(result.width !== undefined && result.height !== undefined && result.dpi
      ? {
          dimensions: {
            widthIn: result.width / result.dpi,
            heightIn: result.height / result.dpi,
          },
        }
      : {}),
    ...(result.dpi !== undefined ? { dpi: result.dpi } : {}),
    // A prep result carries no version of its own; the schema version is about
    // the CONTRACT, not the asset. Version 1 until a producer tracks revisions.
    version: 1,
    meta: {
      ...(result.recipeUsed ? { recipeUsed: result.recipeUsed } : {}),
      ...(result.readinessScore !== undefined
        ? { readinessScore: result.readinessScore }
        : {}),
      ...(result.machinePreset ? { machinePreset: result.machinePreset } : {}),
    },
  };
}

/** Collects prep results into one manifest for a subject. */
export function prepResultsToManifest(
  results: ReadonlyArray<{ result: PrepResult; machineClass: MachineClass; role?: ProductionAsset["role"] }>,
  subject: {
    organizationId: string;
    subjectRef: string;
    subjectType: ProductionAssetManifest["subjectType"];
    producedBy: ProductionAssetManifest["producedBy"];
    generatedAt: string;
  },
): ProductionAssetManifest {
  const assets = results
    .map(({ result, machineClass, role }) =>
      prepResultToProductionAsset(result, machineClass, role),
    )
    .filter((asset): asset is ProductionAsset => asset !== undefined);

  return {
    manifestVersion: 1,
    organizationId: subject.organizationId,
    subjectRef: subject.subjectRef,
    subjectType: subject.subjectType,
    producedBy: subject.producedBy,
    generatedAt: subject.generatedAt,
    assets,
  };
}
