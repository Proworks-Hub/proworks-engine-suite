// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  LEARNABLE_TONE_FIELDS,
  diffToneFields,
  toneActionFor,
  withRecorded,
  type ToneValues,
} from "../toneCorrections.js";

// ─────────────────────────────────────────────────────────────────────────────
// This logic lived inside a React hook and had no tests, because testing it
// meant jsdom and the jsdom tests in the host repo are the flaky ones. Pulling
// the decision out of the timer made it ordinary to test — the timer is host
// plumbing, the decision is domain.
// ─────────────────────────────────────────────────────────────────────────────

const proposed: ToneValues = { contrast: 12, brightness: 0, sharpen: 20, threshold: 128 };

describe("deciding what an operator actually corrected", () => {
  it("records a field the operator moved", () => {
    const corrections = diffToneFields(proposed, { ...proposed, contrast: 18 });

    expect(corrections).toEqual([{ field: "contrast", recommended: 12, applied: 18 }]);
  });

  it("records nothing when the operator agreed", () => {
    // The engine was right. Recording agreement as a zero-delta correction
    // would drag every median toward zero and make a real pattern look like
    // noise.
    expect(diffToneFields(proposed, { ...proposed })).toEqual([]);
  });

  it("records several fields from one settle", () => {
    const corrections = diffToneFields(proposed, {
      ...proposed,
      contrast: 18,
      sharpen: 35,
    });

    expect(corrections.map((c) => c.field).sort()).toEqual(["contrast", "sharpen"]);
  });

  it("does not count the same decision twice", () => {
    // A settle can fire more than once for one decision — a re-render, a second
    // timer, a remount. Counting it twice lets one operator's single choice
    // outvote several other people's.
    const current = { ...proposed, contrast: 18 };
    const first = diffToneFields(proposed, current);
    const second = diffToneFields(proposed, current, withRecorded({}, first));

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("does count a second, genuinely different decision", () => {
    // The dedupe is on the VALUE, not the field. An operator who settles at 18,
    // thinks again and settles at 22 has made two decisions.
    const recorded = withRecorded({}, diffToneFields(proposed, { ...proposed, contrast: 18 }));
    const again = diffToneFields(proposed, { ...proposed, contrast: 22 }, recorded);

    expect(again).toEqual([{ field: "contrast", recommended: 12, applied: 22 }]);
  });

  it("ignores a value the engine never proposed", () => {
    // A field the engine said nothing about is a preference, not a correction.
    // Treating it as one teaches that the engine was wrong about something it
    // never said.
    expect(diffToneFields({ contrast: 12 }, { contrast: 12, gamma: 1.4 })).toEqual([]);
  });

  it("ignores a field the operator has not set", () => {
    expect(diffToneFields({ contrast: 12, gamma: 1.0 }, { contrast: 12 })).toEqual([]);
  });

  it("ignores anything that is not a finite number", () => {
    // A slider mid-edit can hand over NaN, and an empty input can hand over a
    // string. Neither is a decision.
    expect(diffToneFields(proposed, { ...proposed, contrast: NaN })).toEqual([]);
    expect(
      diffToneFields(proposed, { ...proposed, contrast: "18" as unknown as number }),
    ).toEqual([]);
  });

  it("returns nothing when either side is missing entirely", () => {
    // The engine has not run yet, or the editor has not loaded. Neither is a
    // correction, and a hook firing early must not invent one.
    expect(diffToneFields(undefined, { contrast: 18 })).toEqual([]);
    expect(diffToneFields(proposed, undefined)).toEqual([]);
  });

  it("looks only at the learnable fields", () => {
    // Not "every numeric field". Folding preferences into learning data dilutes
    // the signal from fields where the engine is genuinely being corrected.
    const corrections = diffToneFields(
      { ...proposed, someOtherKnob: 1 } as ToneValues,
      { ...proposed, someOtherKnob: 99 } as ToneValues,
    );
    expect(corrections).toEqual([]);
  });
});

describe("the record of what has been captured", () => {
  it("does not mutate what it was given", () => {
    // A caller holding this in a ref must not have it marked recorded before
    // the write that records it has succeeded.
    const before: ToneValues = { contrast: 18 };
    const after = withRecorded(before, [
      { field: "sharpen", recommended: 20, applied: 30 },
    ]);

    expect(before).toEqual({ contrast: 18 });
    expect(after).toEqual({ contrast: 18, sharpen: 30 });
  });
});

describe("the action name", () => {
  it("namespaces every learnable field under tone", () => {
    // The action is the key observations aggregate on, so a collision with
    // another subsystem's action would merge unrelated evidence.
    for (const field of LEARNABLE_TONE_FIELDS) {
      expect(toneActionFor(field)).toBe(`tone.${field}`);
    }
  });
});
