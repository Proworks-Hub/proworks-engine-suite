// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  ordinaryOperationRequiresRepairLearning,
  repairLearningHealth,
  withRepairKnowledge,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// §40: "Repair Learning must fail safely. If repair knowledge is unavailable,
// the Hive should still operate. The Repair Learning subsystem must not become
// a hard dependency for ordinary domain execution."
// ─────────────────────────────────────────────────────────────────────────────

const reachable = {
  experienceStoreReachable: true,
  patternLibraryReachable: true,
  harnessOperational: true,
};

describe("health uses the five constitutional states", () => {
  it("is healthy when everything is reachable", () => {
    expect(repairLearningHealth(reachable).state).toBe("healthy");
  });

  it("is degraded, not unavailable, when only the memory is gone", () => {
    // The case that matters. A repair learning system with no memory is one
    // that has not learned anything yet, which is where it began — and it
    // worked then.
    const health = repairLearningHealth({ ...reachable, experienceStoreReachable: false });
    expect(health.state).toBe("degraded");
    expect(health.stillAvailable).toContain("diagnosis");
    expect(health.unavailable).toContain("similar-case retrieval");
  });

  it("is unavailable when it can neither capture nor retrieve", () => {
    const health = repairLearningHealth({
      experienceStoreReachable: false,
      patternLibraryReachable: false,
      harnessOperational: false,
    });
    expect(health.state).toBe("unavailable");
    expect(health.detail).toContain("Ordinary Hive operation continues");
  });

  it("reports isolation distinctly from unavailability", () => {
    // Sentinel containment (§37) is a decision; unavailability is a fault.
    expect(repairLearningHealth({ ...reachable, isolated: true }).state).toBe("isolated");
  });

  it("says what still works in every degraded state", () => {
    for (const inputs of [
      { ...reachable, experienceStoreReachable: false },
      { ...reachable, harnessOperational: false },
    ]) {
      const health = repairLearningHealth(inputs);
      expect(health.state).toBe("degraded");
      expect(health.stillAvailable.length).toBeGreaterThan(0);
    }
  });
});

describe("a lookup can never break its caller", () => {
  it("returns the value when the lookup works", async () => {
    const answer = await withRepairKnowledge(() => "prior case found");
    expect(answer.value).toBe("prior case found");
    expect(answer.degraded).toBe(false);
  });

  it("degrades instead of throwing", async () => {
    // A caller that has to write a try/catch around repair knowledge will
    // eventually write one that rethrows.
    const answer = await withRepairKnowledge(() => {
      throw new Error("store unreachable");
    });
    expect(answer.value).toBeNull();
    expect(answer.degraded).toBe(true);
    expect(answer.reason).toContain("Proceeding without it");
  });

  it("degrades instead of hanging", async () => {
    // Margins deliberately wide. A 20ms budget against a 200ms promise flakes
    // on a loaded machine, and a timing test that fails under load teaches
    // nothing except to distrust the suite.
    const answer = await withRepairKnowledge(
      () => new Promise((resolve) => setTimeout(() => resolve("too late"), 5000)),
      { timeoutMs: 50 },
    );
    expect(answer.value).toBeNull();
    expect(answer.degraded).toBe(true);
    expect(answer.reason).toContain("did not answer within");
  });

  it("gives an unavailable store the same shape as an empty one", async () => {
    // The symmetry is the point: the path where repair learning is down is the
    // same code path as the one where it simply found nothing.
    const empty = await withRepairKnowledge<string | null>(() => null);
    const broken = await withRepairKnowledge<string | null>(() => {
      throw new Error("down");
    });
    expect(empty.value).toBeNull();
    expect(broken.value).toBeNull();
    expect(Object.keys(empty).sort()).toEqual(Object.keys(broken).sort());
  });
});

describe("it is never a hard dependency", () => {
  it("says so in a function rather than a README", () => {
    // Same shape as healthGrantsAuthority() in Foundation and
    // absorbsAuthorityFrom() in Sentinel: a caller wondering whether to block
    // on repair learning finds a function that says no, rather than an absence
    // they resolve by blocking.
    expect(ordinaryOperationRequiresRepairLearning()).toBe(false);
  });
});
