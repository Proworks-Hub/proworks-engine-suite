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
    // 58 approved engine charters + 1 framework document, plus the 27 Finance
    // Core Engine Program charters ratified 2026-08-30 (DEC-025) and SpendIQ
    // chartered 2026-08-30 by owner ruling (DEC-026, overruling the package's
    // own "module, not engine" verdict -- the conflict is recorded in the
    // decision register, not resolved silently). The framework does not
    // increase the engine count and must not: Overwatch is a relationship.
    expect(registry.all()).toHaveLength(87);
    expect(registry.all().filter((r) => r.canonicalEngineId).length).toBe(86);
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
    // 20 approved + 27 DEC-025 Finance Program charters + SpendIQ (DEC-026).
    expect(by("SPECIALIZED")).toBe(48);
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
    // Charter ACTIVE + implementation CHARTERED is valid: the architecture is
    // decided, the code is not. But it is NOT true of everything — flattening
    // every engine to CHARTERED would erase the distinction the lifecycle
    // vocabulary exists to make.
    const states = new Set(registry.all().map((r) => r.implementationLifecycle));
    expect(states.size).toBeGreaterThan(1);
    expect(states).toContain("CHARTERED");
    expect(states).toContain("EXPERIMENTAL");
  });

  it("marks engines with substantial code as more than CHARTERED", () => {
    // Every engine here has thousands of lines of tested behaviour. Reporting
    // one as CHARTERED would tell a reader nothing is built.
    for (const id of ["hive.forgeiq", "hive.costiq", "hive.workorderiq", "hive.visioniq"]) {
      const r = registry.forEngine(id);
      expect(r?.implementationLifecycle, id).not.toBe("CHARTERED");
    }
  });

  it("leaves unimplemented engines CHARTERED", () => {
    // The other half. If everything drifted upward the vocabulary would be
    // just as useless in the opposite direction.
    // This list has now lost two exemplars to the build catching up with it:
    // `hive.sentinel-iq` in Wave H, and `hive.eventiq` in Wave I. Each time the
    // test failed rather than letting the registry quietly disagree with the
    // repository, which is exactly what it is for. `hive.knowledge-core` and
    // `hive.domain-core` are the current genuinely-unbuilt Cores.
    for (const id of ["hive.knowledge-core", "hive.domain-core", "hive.aria", "hive.healthcareiq"]) {
      const r = registry.forEngine(id);
      if (r) expect(r.implementationLifecycle, id).toBe("CHARTERED");
    }
  });

  it("holds the V1 runtime slice to exactly six engines", () => {
    // The guard requested: scaffolding an out-of-scope engine into the
    // allowlist fails here rather than quietly widening what V1 means.
    const v1 = registry.all().filter((r) => r.v1Runtime).map((r) => r.canonicalEngineId).sort();
    expect(v1).toEqual([
      "hive.costiq", "hive.forgeiq", "hive.inventoryiq",
      "hive.receiptiq", "hive.visioniq", "hive.workorderiq",
    ]);
  });

  it("requires every V1 engine to have real code behind it", () => {
    // A V1 engine that is only CHARTERED would put an unbuilt engine in the
    // shop loop.
    for (const r of registry.all().filter((x) => x.v1Runtime)) {
      expect(r.implementationLifecycle, r.canonicalEngineId).not.toBe("CHARTERED");
    }
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
