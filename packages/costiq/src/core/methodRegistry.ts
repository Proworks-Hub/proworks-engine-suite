/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/methodRegistry.ts
 * Module:   cost-iq-engine / core
 * Purpose:  Ways of costing, registered by id AND version, so a formula
 *           change never silently rewrites the past.
 */

import type { ZodType, ZodTypeDef } from "zod";

import type { CostAssumption } from "../domain/provenance.js";
import type { CostComponent, CostPolicy } from "../domain/costModel.js";
import type { UnitRegistry } from "../domain/quantity.js";
import type { CurrencyPrecisionProvider } from "../domain/money.js";

// ─────────────────────────────────────────────────────────────────────────────
// WHY A REGISTRY AND NOT A SWITCH
//
// Ten costing methods in one function is a function nobody can change safely:
// every method's edge cases live in the same scope, and a fix to landed cost
// can break should-cost. Worse, the switch has no version — so improving a
// formula changes every estimate ever made with it, including the ones a
// customer accepted.
//
// WHY VERSION IS PART OF THE IDENTITY
//
// This is the rule that makes replay possible. A method is `DIRECT_JOB@1.0.0`,
// not `DIRECT_JOB`. If the formula changes in a way that alters results, it
// becomes `1.1.0` and BOTH remain registered. An estimate recorded against
// 1.0.0 can be recomputed against 1.0.0 forever.
//
// Without that, "reproduce last March's quote" means "run today's code on last
// March's inputs", which answers a different question and answers it
// confidently.
//
// METHODS ARE PURE
//
// A method receives canonical data and a policy and returns components. It
// does no I/O, reads no clock and looks nothing up. Everything it needs was
// resolved before it was called — which is what makes a calculation
// reproducible, testable without fixtures, and safe to run anywhere.
// ─────────────────────────────────────────────────────────────────────────────

/** Everything a method may use that is not its own input. */
export interface CostMethodContext {
  readonly policy: CostPolicy;
  /**
   * The instant the caller says this calculation happens at.
   *
   * SUPPLIED, never read from a clock. The predictability contract requires
   * canonical output to be independent of wall time, and a replay supplies the
   * original instant so effective-dated rates resolve as they did then.
   */
  readonly asOf: Date;
  readonly units: UnitRegistry;
  readonly currencyPrecision: CurrencyPrecisionProvider;
}

/** What a method produces. Components and the assumptions it had to make. */
export interface CostMethodOutput {
  readonly components: readonly CostComponent[];
  readonly assumptions: readonly CostAssumption[];
  /**
   * Notes about how the calculation went that are not assumptions.
   *
   * A fallback that was used, an input that was clamped, a conversion that was
   * applied. Distinct from assumptions because an assumption is about the
   * WORLD and these are about the CALCULATION, and conflating them makes both
   * lists useless.
   */
  readonly diagnostics: readonly string[];
}

export type CostMethodResult =
  | { readonly ok: true; readonly output: CostMethodOutput }
  | { readonly ok: false; readonly reason: string; readonly issues: readonly string[] };

/**
 * One way of working out what something costs.
 *
 * Generic in its input so each method states its own shape and validates it,
 * rather than every method receiving a union and narrowing by hand.
 */
export interface CostMethod<TInput = unknown> {
  readonly id: string;
  /**
   * Semantic version of the FORMULA.
   *
   * A change that alters results requires a new version. A change that does
   * not — a faster implementation, a clearer error message — does not.
   */
  readonly version: string;
  /** Human description, for the methods specification and explanations. */
  readonly summary: string;
  /**
   * Validates and narrows the input at the boundary.
   *
   * Typed with `unknown` on the INPUT side rather than `TInput`, because that
   * is what a public boundary actually receives — and because a schema using
   * `.default()` legitimately parses a shape narrower than the one it
   * produces. Requiring them to match would forbid defaults.
   */
  readonly inputSchema: ZodType<TInput, ZodTypeDef, unknown>;
  /** Pure. No I/O, no clock, no lookups. */
  compute(input: TInput, context: CostMethodContext): CostMethodResult;
}

const KEY = (id: string, version: string) => `${id}@${version}`;

export interface MethodRegistry {
  register(method: CostMethod<never>): void;
  /**
   * The method for an id and version.
   *
   * Version is REQUIRED. There is no "latest" lookup, because "latest" is how
   * an estimate silently gets recomputed by different maths than it was
   * approved with.
   */
  get(id: string, version: string): CostMethod<never> | null;
  /** Every registered version of an id, newest registration last. */
  versionsOf(id: string): readonly string[];
  /** Every method, for the specification document and diagnostics. */
  all(): readonly CostMethod<never>[];
}

export function createMethodRegistry(initial: readonly CostMethod<never>[] = []): MethodRegistry {
  const byKey = new Map<string, CostMethod<never>>();
  const versionsById = new Map<string, string[]>();

  const registry: MethodRegistry = {
    register(method) {
      const key = KEY(method.id, method.version);
      if (byKey.has(key)) {
        throw new Error(
          `Method ${key} is already registered. Re-registering a version would replace maths that existing estimates were computed with, and those estimates would stop being reproducible.`,
        );
      }
      byKey.set(key, method);
      const versions = versionsById.get(method.id) ?? [];
      versions.push(method.version);
      versionsById.set(method.id, versions);
    },

    get: (id, version) => byKey.get(KEY(id, version)) ?? null,
    versionsOf: (id) => versionsById.get(id) ?? [],
    all: () => [...byKey.values()],
  };

  for (const m of initial) registry.register(m);
  return registry;
}

/**
 * Runs a method by id and version.
 *
 * FAILS SAFELY on an unknown method — a named refusal, never a fallback to
 * something similar. Costing with the wrong method produces a plausible number
 * that answers a different question, and "we could not find DIRECT_JOB@1.0.0"
 * is far better than a silent substitution.
 */
export function runMethod(
  registry: MethodRegistry,
  id: string,
  version: string,
  input: unknown,
  context: CostMethodContext,
): CostMethodResult {
  const method = registry.get(id, version);
  if (!method) {
    const known = registry.versionsOf(id);
    return {
      ok: false,
      reason:
        known.length > 0
          ? `No method ${id}@${version}. Registered versions of ${id}: ${known.join(", ")}. Refusing to substitute a different version — an estimate computed by maths it did not record is not reproducible.`
          : `No method registered with id ${id}.`,
      issues: [],
    };
  }

  const parsed = method.inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Input rejected by ${id}@${version}.`,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }

  return method.compute(parsed.data as never, context);
}

/**
 * The registry as a specification document.
 *
 * R1 requires a formal, versioned Costing Methods Specification. Generating it
 * from the registry rather than maintaining it separately means it cannot drift
 * — a document that disagrees with the code is worse than no document, because
 * it is believed.
 */
export function methodsSpecification(registry: MethodRegistry): string {
  const methods = [...registry.all()].sort((a, b) =>
    a.id === b.id ? a.version.localeCompare(b.version) : a.id.localeCompare(b.id),
  );
  const lines = ["# CostIQ Costing Methods Specification", ""];
  for (const m of methods) {
    lines.push(`## ${m.id}@${m.version}`, "", m.summary, "");
  }
  return lines.join("\n");
}
