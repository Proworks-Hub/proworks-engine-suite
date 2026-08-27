// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { compileFormula, type CompiledFormula, type FormulaScope } from "../formula/expression.js";

// ─────────────────────────────────────────────────────────────────────────────
// The merchant's logic, evaluated in the engine.
//
// `visibleWhen` already existed on option groups, with a comment saying it was
// "parsed and stored now, enforced by the UI in a later phase." Enforcing it in
// the UI is the thing to avoid: a rule that only exists in a React component is
// a rule the API does not apply, so a configuration posted directly bypasses it
// — and every host that renders the configurator has to reimplement it.
//
// So rules run here, and a host renders the OUTCOME.
//
// RULES ARE DATA, NOT CODE. Each condition is a formula string evaluated by the
// sandboxed expression engine, and each effect is a named, closed operation. A
// merchant cannot express "run this function"; there is no function to run.
//
// EVALUATION RUNS TO A FIXPOINT. One rule's effect can satisfy another's
// condition — selecting a large size requires heavy mounting, which requires a
// bracket option to become visible. A single pass would apply the first and
// miss the second, and which rules fired would depend on the order a merchant
// happened to add them.
// ─────────────────────────────────────────────────────────────────────────────

/** Iterations before a rule set is declared circular. */
export const MAX_RULE_PASSES = 10;

export const ruleEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hide"), target: z.string() }).strict(),
  z.object({ kind: z.literal("show"), target: z.string() }).strict(),
  z.object({ kind: z.literal("require"), target: z.string() }).strict(),
  z.object({ kind: z.literal("optional"), target: z.string() }).strict(),
  /** Forces a value. The merchant's "automatic selection". */
  z.object({ kind: z.literal("setValue"), target: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
  /** Removes a choice without hiding the whole group. */
  z.object({ kind: z.literal("excludeValue"), target: z.string(), value: z.string() }).strict(),
  /** Surfaced to the customer. Does not block. */
  z.object({ kind: z.literal("warn"), message: z.string() }).strict(),
  /** Blocks the configuration. */
  z.object({ kind: z.literal("block"), message: z.string() }).strict(),
]);
export type RuleEffect = z.infer<typeof ruleEffectSchema>;

export const configuratorRuleSchema = z
  .object({
    id: z.string().min(1),
    /** What a merchant called it, shown in explanations. */
    label: z.string().optional(),
    /** A formula returning true or false. */
    when: z.string().min(1),
    then: z.array(ruleEffectSchema).min(1),
    otherwise: z.array(ruleEffectSchema).default([]),
  })
  .strict();
export type ConfiguratorRule = z.infer<typeof configuratorRuleSchema>;

/** Why something happened, in the merchant's own words where possible. */
export interface RuleExplanation {
  readonly ruleId: string;
  readonly label?: string;
  readonly effect: RuleEffect;
  /** The condition that fired, verbatim, so a merchant can see what matched. */
  readonly because: string;
}

export interface RuleOutcome {
  readonly hidden: ReadonlySet<string>;
  readonly required: ReadonlySet<string>;
  /** Values the rules forced. */
  readonly assigned: Readonly<Record<string, string | number | boolean>>;
  /** `groupId` → the value ids ruled out. */
  readonly excluded: Readonly<Record<string, ReadonlySet<string>>>;
  readonly warnings: ReadonlyArray<string>;
  readonly blocks: ReadonlyArray<string>;
  /**
   * Every effect that fired and why.
   *
   * §31: when ForgeIQ changes something automatically, the merchant must be
   * able to understand why. An unexplained automatic change is indistinguishable
   * from a bug, and gets reported as one.
   */
  readonly explanations: ReadonlyArray<RuleExplanation>;
  /**
   * True when the rules never settled.
   *
   * The outcome is still returned — the last pass is usually sensible — but a
   * caller must not publish a configurator that reports this.
   */
  readonly unstable: boolean;
}

export interface CompiledRule {
  readonly rule: ConfiguratorRule;
  readonly condition: CompiledFormula;
}

/**
 * Compiles rules once, at publish time.
 *
 * A rule with a broken condition should stop a merchant publishing, not fail
 * during a customer's checkout.
 */
export function compileRules(rules: ReadonlyArray<ConfiguratorRule>): CompiledRule[] {
  return rules.map((rule) => ({ rule, condition: compileFormula(rule.when) }));
}

/**
 * Runs the rules against a configuration until nothing more changes.
 *
 * `setValue` effects feed back into the scope between passes, which is what
 * lets one rule's consequence satisfy another's condition. Everything else is
 * accumulated: an option hidden by any rule stays hidden, because a rule that
 * hides something is expressing a constraint, and a later rule showing it would
 * make the result depend on authoring order.
 */
export function evaluateRules(
  compiled: ReadonlyArray<CompiledRule>,
  configuration: FormulaScope,
): RuleOutcome {
  const hidden = new Set<string>();
  const required = new Set<string>();
  const excluded = new Map<string, Set<string>>();
  const warnings: string[] = [];
  const blocks: string[] = [];
  const explanations: RuleExplanation[] = [];
  let assigned: Record<string, string | number | boolean> = {};

  let unstable = true;

  for (let pass = 0; pass < MAX_RULE_PASSES; pass += 1) {
    const before = JSON.stringify(assigned);

    // Rebuilt each pass so a rule can react to what an earlier one assigned.
    const scope: FormulaScope = { ...configuration, ...assigned };

    // Reset the non-assignment sets each pass: they are derived from the
    // current scope, and keeping stale entries would leave a group hidden by a
    // condition that no longer holds.
    hidden.clear();
    required.clear();
    excluded.clear();
    warnings.length = 0;
    blocks.length = 0;
    explanations.length = 0;

    const nextAssigned: Record<string, string | number | boolean> = {};

    for (const { rule, condition } of compiled) {
      let matched: boolean;
      try {
        matched = Boolean(condition.evaluate(scope));
      } catch {
        // A condition that cannot be evaluated — usually a field the customer
        // has not filled in yet — is treated as not matching. Blocking the
        // whole configurator because one optional field is empty would make a
        // half-filled form unusable.
        continue;
      }

      const effects = matched ? rule.then : rule.otherwise;
      const because = matched ? rule.when : `not (${rule.when})`;

      for (const effect of effects) {
        explanations.push({ ruleId: rule.id, label: rule.label, effect, because });

        switch (effect.kind) {
          case "hide": hidden.add(effect.target); break;
          case "show": hidden.delete(effect.target); break;
          case "require": required.add(effect.target); break;
          case "optional": required.delete(effect.target); break;
          case "setValue": nextAssigned[effect.target] = effect.value; break;
          case "excludeValue": {
            const set = excluded.get(effect.target) ?? new Set<string>();
            set.add(effect.value);
            excluded.set(effect.target, set);
            break;
          }
          case "warn": warnings.push(effect.message); break;
          case "block": blocks.push(effect.message); break;
        }
      }
    }

    assigned = nextAssigned;

    if (JSON.stringify(assigned) === before) {
      unstable = false;
      break;
    }
  }

  return {
    hidden,
    required,
    assigned,
    excluded: Object.fromEntries(excluded),
    warnings,
    blocks,
    explanations,
    unstable,
  };
}

/**
 * Finds rules that contradict each other, without running a configuration.
 *
 * For the pre-publish check in §18. Two rules assigning different values to the
 * same target under conditions that can both hold is a configurator that
 * behaves differently depending on rule order — which a merchant will
 * experience as randomness.
 *
 * This is deliberately a SYNTACTIC check. Proving two arbitrary conditions can
 * hold simultaneously is undecidable in general, so it reports *candidates* for
 * a human to look at rather than claiming certainty.
 */
export interface RuleConflict {
  readonly target: string;
  readonly ruleIds: ReadonlyArray<string>;
  readonly detail: string;
}

export function findRuleConflicts(rules: ReadonlyArray<ConfiguratorRule>): RuleConflict[] {
  const assignments = new Map<string, Array<{ ruleId: string; value: unknown }>>();
  const conflicts: RuleConflict[] = [];

  for (const rule of rules) {
    for (const effect of [...rule.then, ...rule.otherwise]) {
      if (effect.kind !== "setValue") continue;
      const list = assignments.get(effect.target) ?? [];
      list.push({ ruleId: rule.id, value: effect.value });
      assignments.set(effect.target, list);
    }
  }

  for (const [target, list] of assignments) {
    const distinct = new Set(list.map((a) => JSON.stringify(a.value)));
    if (distinct.size > 1) {
      conflicts.push({
        target,
        ruleIds: list.map((a) => a.ruleId),
        detail: `${list.length} rules assign ${distinct.size} different values to "${target}"`,
      });
    }
  }

  // A group both hidden and required is unsatisfiable: the customer is asked
  // for something they cannot see.
  const hides = new Set<string>();
  const requires = new Set<string>();
  for (const rule of rules) {
    for (const effect of [...rule.then, ...rule.otherwise]) {
      if (effect.kind === "hide") hides.add(effect.target);
      if (effect.kind === "require") requires.add(effect.target);
    }
  }
  for (const target of hides) {
    if (requires.has(target)) {
      conflicts.push({
        target,
        ruleIds: rules
          .filter((r) =>
            [...r.then, ...r.otherwise].some(
              (e) => (e.kind === "hide" || e.kind === "require") && e.target === target,
            ),
          )
          .map((r) => r.id),
        detail: `"${target}" is hidden by one rule and required by another; a customer would be asked for something they cannot see`,
      });
    }
  }

  return conflicts;
}

/**
 * Turns the legacy `visibleWhen` shape into a rule.
 *
 * Backward compatibility, per §36: the field is already stored on option
 * groups, and existing definitions must keep working. This gives it an
 * implementation instead of leaving it as a promise about the UI.
 *
 * The semantics are the obvious reading of the original shape — every listed
 * group must hold one of the listed values, or the group is hidden.
 */
export function ruleFromVisibleWhen(
  groupId: string,
  visibleWhen: ReadonlyArray<{ groupId: string; valueIdIn: ReadonlyArray<string> }>,
): ConfiguratorRule {
  const condition = visibleWhen
    .map((clause) =>
      "(" +
      clause.valueIdIn.map((valueId) => `${clause.groupId} == '${valueId}'`).join(" || ") +
      ")",
    )
    .join(" && ");

  return {
    id: `visible-when:${groupId}`,
    label: `Show ${groupId} only for certain selections`,
    when: condition,
    then: [{ kind: "show", target: groupId }],
    otherwise: [{ kind: "hide", target: groupId }],
  };
}
