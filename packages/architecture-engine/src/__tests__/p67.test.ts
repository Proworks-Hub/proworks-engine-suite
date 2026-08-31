// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { PackageFacts } from "../chambers/conformance.js";
import { collectPackages } from "../modules/collector.js";
import { ARCHITECTURE_CAPABILITIES, currentBuildContext } from "../modules/capabilities.js";
import { adoptionProgress, isWorkspacePackage, planAdoptionQueue } from "../modules/adoption.js";
import { ARCHITECTURE_RULES } from "../rules.js";

const REPO_PACKAGES = join(__dirname, "..", "..", "..");
const pkg = (name: string, deps: string[] = []): PackageFacts => ({ packageName: name, dependencies: deps });

describe("P6 — architecture capabilities exposed to builders", () => {
  it("makes every capability read-only", () => {
    // A capability that could edit the repository would let anything holding
    // it rewrite the code to satisfy the rules instead of satisfying the
    // rules -- and the conformance report improves either way, which is what
    // makes it dangerous.
    for (const capability of ARCHITECTURE_CAPABILITIES) {
      expect(capability.sideEffect, capability.capabilityId).toBe("READ_ONLY");
      expect(capability.idempotent, capability.capabilityId).toBe(true);
    }
  });

  it("exposes no capability that mutates a repository", () => {
    const names = ARCHITECTURE_CAPABILITIES.map((c) => c.capabilityId).join(" ");
    for (const forbidden of ["write", "edit", "apply", "commit", "fix", "mutate"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("leaves them unprotected, because a builder must be able to learn the rules", () => {
    // Protecting these would mean a builder had to be authorized in order to
    // discover the rules it is required to follow.
    expect(ARCHITECTURE_CAPABILITIES.every((c) => !c.requiresAuthorization)).toBe(true);
  });

  it("generates the build context from the live catalog rather than a copy", () => {
    // A hand-maintained context describes the rules as of whenever somebody
    // last remembered to edit it, and a builder follows it confidently into
    // last quarter's standard.
    const context = currentBuildContext();
    const blocking = ARCHITECTURE_RULES.filter((r) => r.severity === "ENGINEERING_GATE").map((r) => r.id);
    expect([...context.blockingRuleIds].sort()).toEqual([...blocking].sort());
  });

  it("keeps governed rules out of the blocking set handed to builders", () => {
    const context = currentBuildContext();
    for (const id of context.governedRuleIds) expect(context.blockingRuleIds).not.toContain(id);
  });

  it("tells a builder what conformance does NOT establish", () => {
    // So nobody concludes that passing every rule means the engine is right.
    const limitations = currentBuildContext().limitations.join(" ");
    expect(limitations).toContain("not correctness");
    expect(limitations).toContain("not permission to deploy");
  });

  it("states how many manifesto rules have no automated check", () => {
    expect(currentBuildContext().limitations.join(" ")).toMatch(/\d+ manifesto rules have no automated check/);
  });
});

describe("P7 — the adoption queue", () => {
  const world = [
    pkg("@proworks-hub/leaf"),
    pkg("@proworks-hub/mid", ["@proworks-hub/foundation"]),
    pkg("@proworks-hub/other", ["@proworks-hub/foundation"]),
    pkg("@proworks-hub/foundation", ["zod"]),
  ];

  it("puts leaves before foundations, because a mistake there is contained", () => {
    const waves = planAdoptionQueue(world);
    const order = waves.flatMap((w) => w.candidates.map((c) => c.packageName));
    expect(order.indexOf("@proworks-hub/leaf")).toBeLessThan(order.indexOf("@proworks-hub/foundation"));
  });

  it("gives every candidate a rationale somebody could argue with", () => {
    // A queue without reasons is a queue people reorder to suit whoever is
    // asking, because there is nothing to argue against.
    for (const wave of planAdoptionQueue(world)) {
      for (const c of wave.candidates) expect(c.rationale.length).toBeGreaterThan(10);
    }
  });

  it("counts dependents only inside the workspace", () => {
    // External packages are not ours to adopt, so `zod` must not appear.
    const names = planAdoptionQueue(world).flatMap((w) => w.candidates.map((c) => c.packageName));
    expect(names).not.toContain("zod");
    expect(isWorkspacePackage("zod")).toBe(false);
  });

  it("separates what is already adopted from what is next", () => {
    const waves = planAdoptionQueue(world, ["@proworks-hub/leaf"]);
    expect(waves[0]?.label).toBe("Already adopted");
    expect(waves[0]?.candidates.map((c) => c.packageName)).toEqual(["@proworks-hub/leaf"]);
  });

  it("names the next packages rather than only a percentage", () => {
    // A percentage tells nobody what to do on Monday.
    const progress = adoptionProgress(planAdoptionQueue(world, ["@proworks-hub/leaf"]));
    expect(progress.adopted).toBe(1);
    expect(progress.nextUp.length).toBeGreaterThan(0);
    expect(progress.nextUp).not.toContain("@proworks-hub/leaf");
  });

  it("reports null progress for an empty world instead of a flattering number", () => {
    expect(adoptionProgress(planAdoptionQueue([])).ratio).toBeNull();
  });

  it("queues the real workspace, with the architecture engine already adopted", () => {
    const packages = collectPackages(REPO_PACKAGES);
    const waves = planAdoptionQueue(packages, ["@proworks-hub/architecture-engine"]);
    const progress = adoptionProgress(waves);
    expect(progress.total).toBeGreaterThan(60);
    expect(progress.adopted).toBe(1);
    expect(progress.remaining).toBe(progress.total - 1);
    // The honest headline: one adopted out of sixty-odd, and the queue says
    // which handful come next.
    expect(progress.nextUp).toHaveLength(5);
  });

  it("puts contracts late, because the whole suite imports it", () => {
    const packages = collectPackages(REPO_PACKAGES);
    const order = planAdoptionQueue(packages).flatMap((w) => w.candidates.map((c) => c.packageName));
    const contracts = order.indexOf("@proworks-hub/contracts");
    expect(contracts).toBeGreaterThan(order.length / 2);
  });
});
