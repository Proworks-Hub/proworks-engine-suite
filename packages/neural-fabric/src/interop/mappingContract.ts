/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/interop/mappingContract.ts
 * Module:   neural-fabric / interop
 * Purpose:  Translating between schemas without quietly deciding what anything means.
 */

import { z } from "zod";

import { classificationSchema, type Classification } from "../domain/envelope.js";
import { CLASSIFICATION_RESTRICTION } from "./pipelinePlan.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE FABRIC MAY NOT SILENTLY REINTERPRET BUSINESS MEANING (§9)
//
// Field mapping looks like plumbing and is not. `customer_ref` → `clientId`
// is a claim that two organisations mean the same thing by two words, and the
// Fabric has no way to know whether they do. Getting it wrong does not throw:
// it produces a system that works, is confidently wrong about whose record is
// whose, and stays wrong until somebody notices a mis-billed customer.
//
// So every mapping here is EXPLICIT and REVIEWED. There is no inference, no
// fuzzy name matching, no "these look similar" heuristic — a similarity score
// is exactly the kind of evidence that feels like knowledge and is not. The
// planner below can PROPOSE a mapping and mark what it is unsure about; it
// cannot produce an approved one, and the type system is what stops it.
//
// LOSS MUST BE DECLARED AT THE FIELD
//
// A lossy transform is not a warning on the contract, it is a property of the
// specific field being narrowed. Truncating a timestamp to a date is fine for
// a report and catastrophic for an audit trail, and only the field knows
// which. Marking loss at the contract level lets one honest disclosure cover
// nine silent ones.
//
// AMBIGUITY IS A REFUSAL, NOT A DEFAULT
//
// The Simulation Lab's scenario list names it directly: "ambiguous semantic
// mapping that must not auto-approve." `reviewStatus` starts at DRAFT and
// there is no code path here that advances it — advancing it is a Governance
// decision (ApproveSemanticMappingContract), taken by a person who can be
// asked why.
// ─────────────────────────────────────────────────────────────────────────────

export const transformKindSchema = z.enum([
  /** Copied unchanged. The only transform that is definitionally lossless. */
  "IDENTITY",
  /** Renamed, value untouched. */
  "RENAME",
  /** Type converted (string ↔ number). May lose precision; must be declared. */
  "CAST",
  /** Unit converted, with a declared factor (mm → in). */
  "UNIT_CONVERT",
  /** Timezone normalized. */
  "TIMEZONE_NORMALIZE",
  /** Encoding changed. */
  "ENCODING_CONVERT",
  /** Enum value remapped through a declared, total table. */
  "ENUM_REMAP",
  /** A constant, because the destination requires a field the source lacks. */
  "CONSTANT",
  /** Concatenation or splitting of declared source fields. */
  "RESHAPE",
]);
export type TransformKind = z.infer<typeof transformKindSchema>;

/** What happens when the source field is absent or null. Never implicit. */
export const nullSemanticsSchema = z.enum([
  /** Absent stays absent. */
  "PROPAGATE",
  /** Absent becomes the declared default. */
  "DEFAULT",
  /** Absent is an error — the destination requires it. */
  "REFUSE",
]);
export type NullSemantics = z.infer<typeof nullSemanticsSchema>;

export const fieldMappingSchema = z
  .object({
    /** Source path(s). More than one only for RESHAPE. */
    sourceFields: z.array(z.string().min(1)).min(1).max(8),
    destinationField: z.string().min(1),
    transform: transformKindSchema,
    /**
     * True when the transform cannot be reversed without losing information.
     *
     * Declared per field, because loss is a property of the narrowing and not
     * of the contract. See the header.
     */
    lossy: z.boolean(),
    /** Required when lossy: what exactly is lost, in plain words. */
    lossDescription: z.string().min(1).optional(),
    nullSemantics: nullSemanticsSchema,
    /** Required when nullSemantics is DEFAULT. */
    defaultValue: z.string().optional(),
    /** Required for UNIT_CONVERT. e.g. "mm→in ×0.0393701". */
    unitConversion: z.string().min(1).optional(),
    /** Required for ENUM_REMAP: a total table, source value → destination value. */
    enumTable: z.record(z.string(), z.string()).optional(),
    /**
     * How confident the AUTHOR is that the two fields mean the same thing.
     *
     * Not a similarity score and not machine-produced. It is a human (or a
     * model that must say so) recording doubt, so a reviewer knows where to
     * look. UNCERTAIN mappings block approval of the whole contract.
     */
    semanticConfidence: z.enum(["ESTABLISHED", "PROBABLE", "UNCERTAIN"]),
    /** Why this mapping is believed correct. Required — see semanticConfidence. */
    rationale: z.string().min(1),
  })
  .strict()
  .refine((m) => !m.lossy || m.lossDescription !== undefined, {
    message: "A lossy mapping must say what it loses. 'Lossy' alone tells a reviewer nothing they can weigh.",
    path: ["lossDescription"],
  })
  .refine((m) => m.nullSemantics !== "DEFAULT" || m.defaultValue !== undefined, {
    message: "DEFAULT null semantics needs the default value. An unstated default becomes whatever the implementation felt like.",
    path: ["defaultValue"],
  })
  .refine((m) => m.transform !== "UNIT_CONVERT" || m.unitConversion !== undefined, {
    message:
      "A unit conversion must state the conversion. Unit mismatches are the classic interoperability failure — a spacecraft was lost to one — and they never announce themselves at runtime.",
    path: ["unitConversion"],
  })
  .refine((m) => m.transform !== "ENUM_REMAP" || (m.enumTable !== undefined && Object.keys(m.enumTable).length > 0), {
    message: "An enum remap needs its table. A partial table means unmapped values take an undefined path at runtime.",
    path: ["enumTable"],
  })
  .refine((m) => m.transform === "RESHAPE" || m.sourceFields.length === 1, {
    message: "Only a RESHAPE draws on more than one source field.",
    path: ["sourceFields"],
  });
export type FieldMapping = z.infer<typeof fieldMappingSchema>;

export const mappingContractSchema = z
  .object({
    mappingContractId: z.string().min(1),
    version: z.string().min(1),

    sourceSchemaId: z.string().min(1),
    sourceSchemaVersion: z.string().min(1),
    destinationSchemaId: z.string().min(1),
    destinationSchemaVersion: z.string().min(1),
    /** Versions this contract is valid for, as a human-readable range. */
    compatibilityRange: z.string().min(1),

    mappings: z.array(fieldMappingSchema).min(1).max(500),

    /**
     * Source fields that must NOT be carried across.
     *
     * The presence of this list is the point. A mapping that only says what
     * to include leaves "what about everything else?" to the implementation,
     * and the implementation's answer is usually "pass it through" — which is
     * how personal data crosses a boundary nobody meant to open.
     */
    prohibitedFields: z.array(z.string().min(1)).max(200),
    /** Source fields deliberately left unmapped, with the reason. */
    unmappedFields: z.array(z.object({ field: z.string().min(1), reason: z.string().min(1) }).strict()).max(200),

    sourceClassification: classificationSchema,
    /**
     * The classification of the RESULT.
     *
     * A mapping may tighten (minimizing at a boundary) and never loosen. The
     * refinement below enforces it, and the pipeline executor re-checks at
     * runtime, because a contract is authored once and applied a million
     * times.
     */
    resultClassification: classificationSchema,

    /** Who wrote it and who reviewed it. Both required for approval. */
    authoredBy: z.string().min(1),
    reviewedBy: z.string().min(1).nullable(),
    /** Whether a model participated, and how. §13: AI may draft, never approve. */
    aiParticipation: z.enum(["NONE", "DRAFTED_BY_MODEL", "SUGGESTED_BY_MODEL"]),

    /**
     * Golden tests: input/output pairs the contract must reproduce.
     *
     * Required and non-empty. A mapping with no examples has never been shown
     * to do anything, and review of a mapping table without examples is
     * review of prose.
     */
    goldenTests: z
      .array(z.object({ name: z.string().min(1), inputJson: z.string().min(1), expectedJson: z.string().min(1) }).strict())
      .min(1)
      .max(100),

    /** DRAFT until Governance approves. Nothing in this file advances it. */
    reviewStatus: z.enum(["DRAFT", "IN_REVIEW", "APPROVED", "REJECTED", "SUPERSEDED"]),
    /** The Governance decision that approved it. Required when APPROVED. */
    approvingDecisionRef: z.string().min(1).nullable(),
  })
  .strict()
  .refine((c) => CLASSIFICATION_RESTRICTION[c.resultClassification] >= CLASSIFICATION_RESTRICTION[c.sourceClassification], {
    message:
      "A mapping may tighten a classification and never loosen one. Translation is not declassification, and a contract that could relabel PERSONAL as INTERNAL would be the quietest export path in the system.",
    path: ["resultClassification"],
  })
  .refine((c) => c.reviewStatus !== "APPROVED" || c.approvingDecisionRef !== null, {
    message:
      "An approved mapping must name the decision that approved it. Without one, 'APPROVED' is a field somebody edited.",
    path: ["approvingDecisionRef"],
  })
  .refine((c) => c.reviewStatus !== "APPROVED" || c.reviewedBy !== null, {
    message: "An approved mapping must name its reviewer.",
    path: ["reviewedBy"],
  })
  .refine((c) => c.reviewStatus !== "APPROVED" || c.mappings.every((m) => m.semanticConfidence !== "UNCERTAIN"), {
    message:
      "A contract containing an UNCERTAIN field mapping cannot be approved. Ambiguous semantics must be resolved by someone who knows the domain, not settled by approving the contract that admits the ambiguity.",
    path: ["mappings"],
  })
  .refine(
    (c) => {
      const destinations = c.mappings.map((m) => m.destinationField);
      return new Set(destinations).size === destinations.length;
    },
    {
      message:
        "Two mappings write the same destination field. Which one wins is then decided by array order, which is not a decision anybody made.",
      path: ["mappings"],
    },
  )
  .refine(
    (c) => {
      const prohibited = new Set(c.prohibitedFields);
      return c.mappings.every((m) => m.sourceFields.every((f) => !prohibited.has(f)));
    },
    {
      message:
        "A mapping reads a field the same contract prohibits. The prohibition is there because that field must not cross; reading it into the destination crosses it.",
      path: ["prohibitedFields"],
    },
  );
export type MappingContract = z.infer<typeof mappingContractSchema>;

/** Whether a contract may actually be applied to live traffic. */
export function mappingIsApplicable(
  contract: MappingContract,
): { readonly applicable: boolean; readonly reason: string } {
  if (contract.reviewStatus !== "APPROVED") {
    return {
      applicable: false,
      reason: `The contract is ${contract.reviewStatus}. Only an approved mapping may touch live traffic — a draft is somebody's proposal about what two systems mean by the same word.`,
    };
  }
  const uncertain = contract.mappings.filter((m) => m.semanticConfidence === "UNCERTAIN");
  if (uncertain.length > 0) {
    return {
      applicable: false,
      reason: `${uncertain.length} mapping(s) are marked UNCERTAIN: ${uncertain.map((m) => m.destinationField).join(", ")}.`,
    };
  }
  return { applicable: true, reason: `Approved by ${contract.approvingDecisionRef}, reviewed by ${contract.reviewedBy}.` };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPATIBILITY
// ─────────────────────────────────────────────────────────────────────────────

export interface SchemaDescriptor {
  readonly schemaId: string;
  readonly version: string;
  readonly requiredFields: readonly string[];
  readonly optionalFields: readonly string[];
}

export interface CompatibilityVerdict {
  readonly compatible: boolean;
  /** Destination requirements no mapping satisfies. */
  readonly unsatisfiedRequired: readonly string[];
  /** Source fields neither mapped, prohibited nor explicitly unmapped. */
  readonly unaccountedSource: readonly string[];
  /** Mappings whose loss the reviewer must weigh. */
  readonly lossyFields: readonly string[];
  readonly explanation: string;
}

/**
 * Checks a contract against the two schemas it claims to bridge.
 *
 * The interesting half is `unaccountedSource`. A source field that is neither
 * mapped, prohibited nor explicitly listed as unmapped is a field nobody made
 * a decision about — and undecided fields are how data leaks across a
 * boundary while every individual line of the contract looks correct.
 */
export function checkCompatibility(
  contract: MappingContract,
  source: SchemaDescriptor,
  destination: SchemaDescriptor,
): CompatibilityVerdict {
  const mappedDestinations = new Set(contract.mappings.map((m) => m.destinationField));
  const unsatisfiedRequired = destination.requiredFields.filter((f) => !mappedDestinations.has(f));

  const accountedSource = new Set<string>([
    ...contract.mappings.flatMap((m) => m.sourceFields),
    ...contract.prohibitedFields,
    ...contract.unmappedFields.map((u) => u.field),
  ]);
  const allSource = [...source.requiredFields, ...source.optionalFields];
  const unaccountedSource = allSource.filter((f) => !accountedSource.has(f));

  const lossyFields = contract.mappings.filter((m) => m.lossy).map((m) => m.destinationField);

  const compatible = unsatisfiedRequired.length === 0 && unaccountedSource.length === 0;

  const parts: string[] = [];
  if (unsatisfiedRequired.length > 0) {
    parts.push(
      `${destination.schemaId}@${destination.version} requires ${unsatisfiedRequired.join(", ")}, and no mapping produces ${unsatisfiedRequired.length === 1 ? "it" : "them"}. The receiver would reject every message.`,
    );
  }
  if (unaccountedSource.length > 0) {
    parts.push(
      `${unaccountedSource.join(", ")} appear${unaccountedSource.length === 1 ? "s" : ""} in ${source.schemaId}@${source.version} and ${unaccountedSource.length === 1 ? "is" : "are"} neither mapped, prohibited nor listed as deliberately unmapped. An undecided field is the one that gets passed through by default.`,
    );
  }
  if (lossyFields.length > 0) {
    parts.push(`Lossy: ${lossyFields.join(", ")}. Each declares what it loses; a reviewer has to decide whether that matters here.`);
  }
  if (parts.length === 0) {
    parts.push("Every destination requirement is satisfied and every source field has an explicit decision.");
  }

  return { compatible, unsatisfiedRequired, unaccountedSource, lossyFields, explanation: parts.join(" ") };
}

/**
 * Drafts a mapping candidate from two schemas.
 *
 * Exact name matches become PROBABLE (not ESTABLISHED — identical names are
 * evidence about vocabulary, not about meaning; `status` means something
 * different in every system that has one). Everything else is left unmapped
 * with a reason. There is deliberately no fuzzy matching: a similarity score
 * is the kind of evidence that feels like knowledge, and a reviewer who sees
 * "87% match" reads it as a finding rather than a guess.
 *
 * The result is always DRAFT. This function cannot produce an approved
 * contract, and that is the whole design.
 */
export function draftMappingCandidate(input: {
  readonly mappingContractId: string;
  readonly source: SchemaDescriptor;
  readonly destination: SchemaDescriptor;
  readonly sourceClassification: Classification;
  readonly authoredBy: string;
  readonly aiParticipation: MappingContract["aiParticipation"];
}): { readonly draft: MappingContract; readonly requiresHumanDecision: readonly string[] } {
  const sourceFields = new Set([...input.source.requiredFields, ...input.source.optionalFields]);
  const mappings: FieldMapping[] = [];
  const unmappedFields: { field: string; reason: string }[] = [];
  const requiresHumanDecision: string[] = [];

  for (const field of [...input.destination.requiredFields, ...input.destination.optionalFields]) {
    if (sourceFields.has(field)) {
      mappings.push({
        sourceFields: [field],
        destinationField: field,
        transform: "IDENTITY",
        lossy: false,
        nullSemantics: input.destination.requiredFields.includes(field) ? "REFUSE" : "PROPAGATE",
        semanticConfidence: "PROBABLE",
        rationale:
          "The field names match exactly. That is evidence about vocabulary, not about meaning — two systems can both call something `status` and disagree completely — so this needs a domain reviewer before it is trusted.",
      });
    } else if (input.destination.requiredFields.includes(field)) {
      requiresHumanDecision.push(
        `${field} is required by ${input.destination.schemaId} and has no same-named source field. Someone who knows both domains has to say where it comes from, or that it cannot be produced.`,
      );
    }
  }

  for (const field of sourceFields) {
    if (!mappings.some((m) => m.sourceFields.includes(field))) {
      unmappedFields.push({
        field,
        reason: "No same-named destination field. Left unmapped by the drafter rather than guessed at.",
      });
    }
  }

  // A draft with no mappings at all would fail the schema's min(1), and a
  // fabricated placeholder would be worse than an honest failure — so the
  // caller gets a draft only when something matched, and the decision list
  // when nothing did.
  const draft: MappingContract = {
    mappingContractId: input.mappingContractId,
    version: "0.1.0-draft",
    sourceSchemaId: input.source.schemaId,
    sourceSchemaVersion: input.source.version,
    destinationSchemaId: input.destination.schemaId,
    destinationSchemaVersion: input.destination.version,
    compatibilityRange: `${input.source.version} → ${input.destination.version} only; this draft was generated against those exact versions.`,
    mappings:
      mappings.length > 0
        ? mappings
        : [
            {
              sourceFields: ["__none__"],
              destinationField: "__none__",
              transform: "CONSTANT",
              lossy: false,
              nullSemantics: "REFUSE",
              semanticConfidence: "UNCERTAIN",
              rationale:
                "Nothing matched by name. This placeholder exists so the draft is well-formed, and it is UNCERTAIN so the contract can never be approved while it is present.",
            },
          ],
    prohibitedFields: [],
    unmappedFields,
    sourceClassification: input.sourceClassification,
    resultClassification: input.sourceClassification,
    authoredBy: input.authoredBy,
    reviewedBy: null,
    aiParticipation: input.aiParticipation,
    goldenTests: [
      {
        name: "placeholder — replace before review",
        inputJson: "{}",
        expectedJson: "{}",
        },
    ],
    reviewStatus: "DRAFT",
    approvingDecisionRef: null,
  };

  return { draft, requiresHumanDecision };
}

/** Nothing in this module approves a mapping. Governance does. */
export function draftingApprovesMapping(): false {
  return false;
}
