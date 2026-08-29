// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createCharterRegistry, isBinding } from "@proworks-hub/contracts";

// The committed registry must parse. A malformed governing reference that
// nothing checks is how a charter silently stops governing.
const records = JSON.parse(
  readFileSync(join(process.cwd(), "charters/registry.json"), "utf8"),
) as unknown[];

describe("the approved charter registry", () => {
  const registry = createCharterRegistry(records);

  it("loads every record without a problem", () => {
    expect(registry.problems()).toEqual([]);
    // 58 engine charters + 1 framework document. The framework does not
    // increase the engine count and must not: Overwatch is a relationship.
    expect(registry.all()).toHaveLength(59);
    expect(registry.all().filter((r) => r.canonicalEngineId).length).toBe(58);
  });

  it("matches the approved registry counts exactly", () => {
    const by = (c: string) => registry.all().filter((r) => r.classification === c).length;
    expect(by("CONSTITUTIONAL_GOVERNANCE")).toBe(1);
    expect(by("CONSTITUTIONAL_SENTINEL")).toBe(1);
    expect(by("CONSTITUTIONAL_EVOLUTION")).toBe(1);
    expect(by("CONSTITUTIONAL_INTELLIGENCE")).toBe(1);
    expect(by("CONSTITUTIONAL_ORCHESTRATION")).toBe(1);
    expect(by("CORE")).toBe(8);
    expect(by("SHARED_PLATFORM")).toBe(12);
    expect(by("SPECIALIZED")).toBe(20);
    expect(by("INDUSTRY")).toBe(13);
  });

  it("carries a verifiable integrity hash on every active charter", () => {
    // The schema enforces this, but asserting it here states the reason: an
    // unverifiable reference to a governing document is how a compromised
    // runtime redefines what counts as constitutional.
    for (const r of registry.all()) {
      expect(r.integrityHash, r.charterId).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("treats every approved-source charter as binding", () => {
    expect(registry.all().every(isBinding)).toBe(true);
  });

  it("does not infer implementation from charter status", () => {
    // Charter ACTIVE + implementation CHARTERED is valid and is the current
    // state of all 58: the architecture is decided, the code mostly is not.
    expect(registry.all().every((r) => r.implementationLifecycle === "CHARTERED")).toBe(true);
  });

  it("charters CustomerIQ, which settles customer ownership", () => {
    const c = registry.forEngine("hive.customeriq");
    expect(c?.classification).toBe("SPECIALIZED");
  });

  it("records Overwatch as a framework, with neither engine id nor classification", () => {
    // The approved framework document says it plainly: "Overwatch is not an
    // independent engine. It possesses no separate sovereignty, data ownership,
    // execution authority, or constitutional power beyond the authority already
    // granted to its participating systems."
    const ow = registry.byId("framework.overwatch");
    expect(ow).not.toBeNull();
    expect(ow!.canonicalEngineId).toBeUndefined();
    expect(ow!.classification).toBeUndefined();
    expect(registry.forEngine("hive.overwatch")).toBeNull();
  });
});
