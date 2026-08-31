// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// ContractCompatibilityIQ.
//
// Whether a change to a public contract breaks the people using it.
//
// COMPATIBILITY IS DIRECTIONAL, and conflating the two directions is the
// mistake this module exists to prevent:
//
//   BACKWARD_COMPATIBLE  A NEW reader can read OLD data. Safe to deploy the
//                        reader first.
//   FORWARD_COMPATIBLE   An OLD reader can read NEW data. Safe to deploy the
//                        writer first.
//
// Deployment order depends on which one you have, so "compatible" on its own
// is not an answer — and a change can be one and not the other. Adding a
// required field is backward compatible and forward incompatible; removing an
// optional one is the reverse.
// ─────────────────────────────────────────────────────────────────────────────

export const compatibilityClassSchema = z.enum([
  /** New readers read old data, and old readers read new data. Deploy either order. */
  "FULLY_COMPATIBLE",
  /** New reader, old data. Deploy readers first. */
  "BACKWARD_COMPATIBLE",
  /** Old reader, new data. Deploy writers first. */
  "FORWARD_COMPATIBLE",
  /** Neither direction holds, but an adapter can bridge it. */
  "ADAPTER_REQUIRED",
  /** Neither direction holds and no adapter can bridge it. Consumers migrate. */
  "BREAKING",
]);
export type CompatibilityClass = z.infer<typeof compatibilityClassSchema>;

/** A contract described structurally, so any schema language can be compared. */
export interface ContractShape {
  readonly contractId: string;
  readonly version: string;
  readonly fields: readonly {
    readonly name: string;
    readonly type: string;
    readonly required: boolean;
  }[];
  /** Closed enumerations, by field name. Widening and narrowing differ. */
  readonly enums?: Readonly<Record<string, readonly string[]>>;
}

export interface CompatibilityChange {
  readonly kind:
    | "FIELD_ADDED_REQUIRED"
    | "FIELD_ADDED_OPTIONAL"
    | "FIELD_REMOVED_REQUIRED"
    | "FIELD_REMOVED_OPTIONAL"
    | "FIELD_TYPE_CHANGED"
    | "FIELD_MADE_REQUIRED"
    | "FIELD_MADE_OPTIONAL"
    | "ENUM_WIDENED"
    | "ENUM_NARROWED";
  readonly field: string;
  readonly detail: string;
}

export interface CompatibilityResult {
  readonly contractId: string;
  readonly from: string;
  readonly to: string;
  readonly classification: CompatibilityClass;
  readonly changes: readonly CompatibilityChange[];
  /** What a release engineer has to do, in one sentence. */
  readonly deploymentGuidance: string;
  /**
   * Set when the classification is BREAKING.
   *
   * A breaking change requires an ADR, a consumer inventory and a migration
   * plan. Naming them here means the requirement travels with the finding
   * rather than living in a document somebody has to remember to open.
   */
  readonly requiredArtifacts: readonly string[];
}

/**
 * Compares two versions of a contract.
 *
 * Enum widening is the case most often got wrong, so it is worth stating: a
 * writer emitting a NEW enum member breaks an OLD reader that has no branch
 * for it. Widening is therefore backward compatible and forward INcompatible,
 * which is the opposite of most people's first instinct — adding a value feels
 * additive, and additive feels safe.
 */
export function compareContracts(before: ContractShape, after: ContractShape): CompatibilityResult {
  const changes: CompatibilityChange[] = [];
  const beforeFields = new Map(before.fields.map((f) => [f.name, f]));
  const afterFields = new Map(after.fields.map((f) => [f.name, f]));

  for (const [name, field] of afterFields) {
    const old = beforeFields.get(name);
    if (!old) {
      changes.push({
        kind: field.required ? "FIELD_ADDED_REQUIRED" : "FIELD_ADDED_OPTIONAL",
        field: name,
        detail: `added ${field.required ? "required" : "optional"} ${field.type}`,
      });
      continue;
    }
    if (old.type !== field.type) {
      changes.push({
        kind: "FIELD_TYPE_CHANGED",
        field: name,
        detail: `${old.type} → ${field.type}`,
      });
    }
    if (!old.required && field.required) {
      changes.push({ kind: "FIELD_MADE_REQUIRED", field: name, detail: "optional → required" });
    }
    if (old.required && !field.required) {
      changes.push({ kind: "FIELD_MADE_OPTIONAL", field: name, detail: "required → optional" });
    }
  }

  for (const [name, field] of beforeFields) {
    if (afterFields.has(name)) continue;
    changes.push({
      kind: field.required ? "FIELD_REMOVED_REQUIRED" : "FIELD_REMOVED_OPTIONAL",
      field: name,
      detail: `removed ${field.required ? "required" : "optional"} ${field.type}`,
    });
  }

  for (const [name, values] of Object.entries(after.enums ?? {})) {
    const old = before.enums?.[name];
    if (!old) continue;
    const added = values.filter((v) => !old.includes(v));
    const removed = old.filter((v) => !values.includes(v));
    if (added.length > 0) {
      changes.push({
        kind: "ENUM_WIDENED",
        field: name,
        detail: `added ${added.join(", ")} — an old reader has no branch for these`,
      });
    }
    if (removed.length > 0) {
      changes.push({
        kind: "ENUM_NARROWED",
        field: name,
        detail: `removed ${removed.join(", ")} — old data carrying these no longer parses`,
      });
    }
  }

  // A new reader fails on old data when the old data lacks something now
  // required, or carries a value the new reader no longer accepts.
  const breaksBackward = changes.some((c) =>
    ["FIELD_ADDED_REQUIRED", "FIELD_MADE_REQUIRED", "FIELD_TYPE_CHANGED", "ENUM_NARROWED"].includes(
      c.kind,
    ),
  );

  // An old reader fails on new data when something it required is gone, or a
  // value it cannot interpret arrives.
  const breaksForward = changes.some((c) =>
    ["FIELD_REMOVED_REQUIRED", "FIELD_TYPE_CHANGED", "FIELD_MADE_OPTIONAL", "ENUM_WIDENED"].includes(
      c.kind,
    ),
  );

  // A type change is the one nothing bridges by defaulting: there is no value
  // to supply, only a conversion that may lose information. Everything else
  // that breaks both directions is a shape difference an adapter can absorb.
  const typeChanged = changes.some((c) => c.kind === "FIELD_TYPE_CHANGED");

  const classification: CompatibilityClass =
    !breaksBackward && !breaksForward
      ? "FULLY_COMPATIBLE"
      : breaksBackward && breaksForward
        ? typeChanged
          ? "BREAKING"
          : "ADAPTER_REQUIRED"
        : breaksForward
          ? "BACKWARD_COMPATIBLE"
          : "FORWARD_COMPATIBLE";

  const guidance: Record<CompatibilityClass, string> = {
    FULLY_COMPATIBLE: "Deploy in any order.",
    BACKWARD_COMPATIBLE: "Deploy readers before writers.",
    FORWARD_COMPATIBLE: "Deploy writers before readers.",
    ADAPTER_REQUIRED: "Neither order is safe; bridge the shapes with an adapter.",
    BREAKING: "Consumers must migrate. No deployment order makes this safe.",
  };

  return {
    contractId: after.contractId,
    from: before.version,
    to: after.version,
    classification,
    changes,
    deploymentGuidance: guidance[classification],
    requiredArtifacts:
      classification === "BREAKING"
        ? ["ADR recording the decision", "consumer inventory", "migration plan", "retirement evidence"]
        : [],
  };
}
