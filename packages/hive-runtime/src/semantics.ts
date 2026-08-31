// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// The vocabulary a participant uses to describe what it DOES, as distinct from
// what it is.
//
// These are separated from identity and charter because they are the axes a
// reviewer actually reasons about under pressure: can this be retried, does it
// spend money, is the answer the same twice. Bundling them into prose is how
// an engine ends up retried by a caller who did not know it was irreversible.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How sensitive the data a participant handles is.
 *
 * Manifesto §11 baseline. Domain overlays are allowed to ADD, never to
 * reinterpret these four — an overlay that redefines RESTRICTED downward is a
 * declassification wearing the clothes of a taxonomy.
 */
export const dataClassificationSchema = z.enum([
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
]);
export type DataClassification = z.infer<typeof dataClassificationSchema>;

/**
 * Whether the same input yields the same output.
 *
 * `PROBABILISTIC` exists so a model-backed capability cannot be described as
 * deterministic by omission. A caller that retries a probabilistic operation
 * expecting idempotence gets a second, different answer and treats it as
 * corruption.
 */
export const determinismSchema = z.enum([
  "DETERMINISTIC",
  "BOUNDED_NONDETERMINISTIC",
  "PROBABILISTIC",
  "HUMAN_JUDGMENT",
]);
export type Determinism = z.infer<typeof determinismSchema>;

/**
 * What happens in the world when this runs.
 *
 * Ordered by how hard it is to take back, and that ordering is the point: it
 * is what lets a rule say "an operation at or above EXTERNAL_CONSEQUENCE must
 * declare an authorization requirement" without enumerating every operation.
 */
export const sideEffectSchema = z.enum([
  "READ_ONLY",
  "REVERSIBLE_MUTATION",
  "EXTERNAL_CONSEQUENCE",
  "FINANCIAL_CONSEQUENCE",
  "SECURITY_CONSEQUENCE",
  "IRREVERSIBLE",
]);
export type SideEffect = z.infer<typeof sideEffectSchema>;

/** Side effects that leave the participant's own boundary, hardest-to-undo first. */
export const CONSEQUENTIAL_SIDE_EFFECTS: readonly SideEffect[] = [
  "IRREVERSIBLE",
  "SECURITY_CONSEQUENCE",
  "FINANCIAL_CONSEQUENCE",
  "EXTERNAL_CONSEQUENCE",
];

/**
 * True for effects the Hive treats as consequential.
 *
 * A predicate rather than a set membership test at each call site, so the
 * definition of "consequential" lives in one place and a rule cannot quietly
 * use a narrower one.
 */
export function isConsequential(effect: SideEffect): boolean {
  return CONSEQUENTIAL_SIDE_EFFECTS.includes(effect);
}

/**
 * What the transport promises.
 *
 * `EXACTLY_ONCE` is deliberately absent. Nothing delivers exactly once across
 * a network partition; the honest form is at-least-once plus an idempotent
 * consumer, which is what `EFFECTIVELY_ONCE` names. Offering the stronger word
 * would let a participant claim a guarantee no implementation can keep.
 */
export const deliverySemanticsSchema = z.enum([
  "AT_MOST_ONCE",
  "AT_LEAST_ONCE",
  "EFFECTIVELY_ONCE",
  "REPEATABLE",
]);
export type DeliverySemantics = z.infer<typeof deliverySemanticsSchema>;

/**
 * How a participant behaves when something it needs is gone.
 *
 * `REQUIRED` is the only class that may stop the participant. Everything else
 * has to keep working in some reduced form, and saying which is the difference
 * between a degraded Hive and a cascading one.
 */
export const dependencyClassSchema = z.enum([
  /** Absence stops the participant. Must be justified; every one is a coupling. */
  "REQUIRED",
  /** Absence reduces function. The participant must say into what. */
  "DEGRADABLE",
  /** Absence changes nothing observable. */
  "OPTIONAL",
  /** Build and test only. Never present at runtime. */
  "DEVELOPMENT",
  /** An external vendor or model behind a port. Replaceable by contract. */
  "PROVIDER",
]);
export type DependencyClass = z.infer<typeof dependencyClassSchema>;

/**
 * Whether a component is expected to be running and reporting.
 *
 * Manifesto §40, verbatim, because this vocabulary is quoted in charters and a
 * paraphrase would become a second name for the same thing.
 *
 * This is the axis that distinguishes "deployed and gone quiet" — an incident
 * — from "built but never started", which is not. Collapsing them is how a
 * console shows thirty permanent alarms nobody can act on, and how operators
 * learn to stop reading it.
 */
export const maturityLevelSchema = z.enum([
  /** M0 — investigation only. */
  "RESEARCH",
  /** M1 — charter/architecture proposed. */
  "PROPOSED",
  /** M2 — contracts, state, failure and integration specified. */
  "ARCHITECTED",
  /** M3 — code exists and local verification passes. */
  "IMPLEMENTED",
  /** M4 — proven through a real governed Hive path. */
  "INTEGRATED",
  /** M5 — hard gates, adversarial and failure tests, documentation all pass. */
  "CERTIFIED",
  /** M6 — representative operational evidence meets defined SLOs. */
  "OPERATIONALLY_PROVEN",
  /** M7 — measured against public standards with reproducible evidence. */
  "WORLD_CLASS_BENCHMARKED",
]);
export type MaturityLevel = z.infer<typeof maturityLevelSchema>;

/** Ordered M0..M7, so "at least M4" is expressible without a lookup table. */
export const MATURITY_ORDER: readonly MaturityLevel[] = [
  "RESEARCH",
  "PROPOSED",
  "ARCHITECTED",
  "IMPLEMENTED",
  "INTEGRATED",
  "CERTIFIED",
  "OPERATIONALLY_PROVEN",
  "WORLD_CLASS_BENCHMARKED",
];

/**
 * Whether a component is expected to be running in a live Hive.
 *
 * True from `INTEGRATED` up: M4 is the first level that means "proven through
 * a real governed path", which is the first point at which silence is a fault
 * rather than an accurate description of something that was never started.
 *
 * Below M4 a component still exists and should still be shown — invisible is
 * its own dishonesty — but it must not be counted among what is expected to
 * report, and its silence must not raise an alarm.
 */
export function isExpectedToReport(maturity: MaturityLevel): boolean {
  return MATURITY_ORDER.indexOf(maturity) >= MATURITY_ORDER.indexOf("INTEGRATED");
}

/**
 * Runtime lifecycle, which is a different question from maturity.
 *
 * Maturity asks what a component has PROVEN; this asks what it is doing right
 * now. A CERTIFIED engine can be STOPPED, and an IMPLEMENTED one can be READY
 * in a developer's sandbox — so neither can be derived from the other.
 */
export const runtimeStateSchema = z.enum([
  "INITIALIZING",
  "READY",
  "DEGRADED",
  "MAINTENANCE",
  "STOPPING",
  "STOPPED",
  "FAILED",
  /** No recent report. Never treated as healthy. */
  "UNKNOWN",
]);
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
