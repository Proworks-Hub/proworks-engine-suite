// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  compileRules,
  configuratorRuleSchema,
  evaluateRules,
  findRuleConflicts,
  ruleFromVisibleWhen,
  type ConfiguratorRule,
} from "../ruleEngine.js";

const run = (rules: ConfiguratorRule[], config: Record<string, string | number | boolean>) =>
  evaluateRules(compileRules(rules), config);

describe("the rules a merchant writes in the directive", () => {
  it("hides one option and shows another based on material", () => {
    // IF Material = Aluminum THEN Hide Wood Stain, Show Powder Coat.
    const outcome = run(
      [
        {
          id: "r1",
          when: "material == 'aluminum'",
          then: [
            { kind: "hide", target: "woodStain" },
            { kind: "show", target: "powderCoat" },
          ],
          otherwise: [],
        },
      ],
      { material: "aluminum" },
    );

    expect(outcome.hidden.has("woodStain")).toBe(true);
    expect(outcome.hidden.has("powderCoat")).toBe(false);
  });

  it("requires heavy-duty mounting past a width", () => {
    const rules: ConfiguratorRule[] = [
      {
        id: "r2",
        when: "width > 30",
        then: [{ kind: "require", target: "heavyDutyMount" }],
        otherwise: [],
      },
    ];

    expect(run(rules, { width: 36 }).required.has("heavyDutyMount")).toBe(true);
    expect(run(rules, { width: 24 }).required.has("heavyDutyMount")).toBe(false);
  });

  it("requires an upload once an option is chosen", () => {
    const outcome = run(
      [
        {
          id: "r3",
          when: "decoration == 'logo'",
          then: [{ kind: "require", target: "logoUpload" }],
          otherwise: [{ kind: "optional", target: "logoUpload" }],
        },
      ],
      { decoration: "logo" },
    );

    expect(outcome.required.has("logoUpload")).toBe(true);
  });

  it("blocks a configuration that cannot be made", () => {
    const outcome = run(
      [
        {
          id: "r4",
          when: "engraveWidth > safeWidth",
          then: [{ kind: "block", message: "Text exceeds the engraving area" }],
          otherwise: [],
        },
      ],
      { engraveWidth: 12, safeWidth: 10 },
    );

    expect(outcome.blocks).toEqual(["Text exceeds the engraving area"]);
  });
});

describe("rules that depend on other rules", () => {
  it("settles when one rule's effect satisfies another's condition", () => {
    // Large size forces heavy mounting; heavy mounting reveals the bracket
    // option. A single pass would apply the first and miss the second.
    const outcome = run(
      [
        {
          id: "size",
          when: "size == 'large'",
          then: [{ kind: "setValue", target: "mounting", value: "heavy" }],
          otherwise: [],
        },
        {
          id: "bracket",
          when: "mounting == 'heavy'",
          then: [{ kind: "show", target: "bracketCount" }, { kind: "require", target: "bracketCount" }],
          otherwise: [{ kind: "hide", target: "bracketCount" }],
        },
      ],
      { size: "large", mounting: "standard" },
    );

    expect(outcome.assigned["mounting"]).toBe("heavy");
    expect(outcome.required.has("bracketCount")).toBe(true);
    expect(outcome.unstable).toBe(false);
  });

  it("does not depend on the order a merchant added the rules", () => {
    // The reason a fixpoint exists at all: authoring order must not change the
    // answer, or a merchant reordering their list changes what customers see.
    const size: ConfiguratorRule = {
      id: "size",
      when: "size == 'large'",
      then: [{ kind: "setValue", target: "mounting", value: "heavy" }],
      otherwise: [],
    };
    const bracket: ConfiguratorRule = {
      id: "bracket",
      when: "mounting == 'heavy'",
      then: [{ kind: "require", target: "bracketCount" }],
      otherwise: [],
    };

    const forward = run([size, bracket], { size: "large", mounting: "standard" });
    const reversed = run([bracket, size], { size: "large", mounting: "standard" });

    expect(forward.required.has("bracketCount")).toBe(reversed.required.has("bracketCount"));
    expect(forward.required.has("bracketCount")).toBe(true);
  });

  it("reports rules that never settle instead of looping forever", () => {
    // Two rules that flip each other. The outcome still comes back — the last
    // pass is usually sensible — but `unstable` tells a caller not to publish.
    const outcome = run(
      [
        { id: "a", when: "flip == 'x'", then: [{ kind: "setValue", target: "flip", value: "y" }], otherwise: [] },
        { id: "b", when: "flip == 'y'", then: [{ kind: "setValue", target: "flip", value: "x" }], otherwise: [] },
      ],
      { flip: "x" },
    );

    expect(outcome.unstable).toBe(true);
  });
});

describe("a condition that cannot be evaluated yet", () => {
  it("does not fire, and does not break the form", () => {
    // A field the customer has not filled in. Blocking the whole configurator
    // because one optional value is missing makes a half-filled form unusable.
    const outcome = run(
      [
        {
          id: "r",
          when: "customerText != ''",
          then: [{ kind: "require", target: "font" }],
          otherwise: [],
        },
      ],
      {},
    );

    expect(outcome.required.size).toBe(0);
    expect(outcome.blocks).toEqual([]);
  });
});

describe("explaining what happened", () => {
  it("records every effect with the condition that caused it", () => {
    // §31: an unexplained automatic change is indistinguishable from a bug,
    // and gets reported as one.
    const outcome = run(
      [
        {
          id: "mount",
          label: "Wide signs need heavy mounting",
          when: "width > 30",
          then: [{ kind: "setValue", target: "mounting", value: "heavy" }],
          otherwise: [],
        },
      ],
      { width: 36 },
    );

    expect(outcome.explanations).toHaveLength(1);
    expect(outcome.explanations[0]).toMatchObject({
      ruleId: "mount",
      label: "Wide signs need heavy mounting",
      because: "width > 30",
    });
  });

  it("explains the else branch as the negated condition", () => {
    const outcome = run(
      [
        {
          id: "mount",
          when: "width > 30",
          then: [{ kind: "require", target: "heavy" }],
          otherwise: [{ kind: "hide", target: "heavy" }],
        },
      ],
      { width: 12 },
    );

    expect(outcome.explanations[0]?.because).toBe("not (width > 30)");
  });
});

describe("catching a broken configurator before publishing", () => {
  it("finds two rules assigning different values to one field", () => {
    const conflicts = findRuleConflicts([
      { id: "a", when: "width > 30", then: [{ kind: "setValue", target: "mount", value: "heavy" }], otherwise: [] },
      { id: "b", when: "material == 'wood'", then: [{ kind: "setValue", target: "mount", value: "light" }], otherwise: [] },
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.ruleIds).toEqual(["a", "b"]);
  });

  it("does not flag two rules agreeing on the same value", () => {
    const conflicts = findRuleConflicts([
      { id: "a", when: "width > 30", then: [{ kind: "setValue", target: "mount", value: "heavy" }], otherwise: [] },
      { id: "b", when: "height > 30", then: [{ kind: "setValue", target: "mount", value: "heavy" }], otherwise: [] },
    ]);

    expect(conflicts).toEqual([]);
  });

  it("finds a field both hidden and required", () => {
    // The customer is asked for something they cannot see.
    const conflicts = findRuleConflicts([
      { id: "a", when: "x == 1", then: [{ kind: "hide", target: "font" }], otherwise: [] },
      { id: "b", when: "y == 2", then: [{ kind: "require", target: "font" }], otherwise: [] },
    ]);

    expect(conflicts.some((c) => c.detail.includes("cannot see"))).toBe(true);
  });
});

describe("the legacy visibleWhen field", () => {
  it("finally has an implementation rather than a promise about the UI", () => {
    // It shipped with the comment "enforced by the UI in a later phase". A rule
    // only in a React component is a rule the API does not apply.
    const rule = ruleFromVisibleWhen("stainColor", [
      { groupId: "material", valueIdIn: ["oak", "walnut"] },
    ]);

    expect(run([rule], { material: "oak" }).hidden.has("stainColor")).toBe(false);
    expect(run([rule], { material: "aluminum" }).hidden.has("stainColor")).toBe(true);
  });

  it("requires every clause to hold, and any listed value within a clause", () => {
    const rule = ruleFromVisibleWhen("engraving", [
      { groupId: "material", valueIdIn: ["slate", "granite"] },
      { groupId: "finish", valueIdIn: ["honed"] },
    ]);

    expect(run([rule], { material: "slate", finish: "honed" }).hidden.has("engraving")).toBe(false);
    expect(run([rule], { material: "slate", finish: "polished" }).hidden.has("engraving")).toBe(true);
    expect(run([rule], { material: "oak", finish: "honed" }).hidden.has("engraving")).toBe(true);
  });
});

describe("rules are data", () => {
  it("refuses an effect that is not one of the named operations", () => {
    // A merchant cannot express "run this function"; there is no function.
    expect(() =>
      configuratorRuleSchema.parse({
        id: "r",
        when: "true",
        then: [{ kind: "exec", target: "rm -rf /" }],
      }),
    ).toThrow();
  });

  it("refuses a field nobody declared on an effect", () => {
    expect(() =>
      configuratorRuleSchema.parse({
        id: "r",
        when: "true",
        then: [{ kind: "hide", target: "x", script: "alert(1)" }],
      }),
    ).toThrow();
  });

  it("refuses a rule whose condition will not compile, at publish time", () => {
    expect(() => compileRules([{ id: "r", when: "width >", then: [{ kind: "hide", target: "x" }], otherwise: [] }]))
      .toThrow();
  });
});
