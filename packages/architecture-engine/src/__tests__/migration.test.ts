// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { COSTIQ_CHARTER } from "@proworks-hub/costiq";
import { participantRuntimeSchema } from "@proworks-hub/hive-runtime";
import { describe, expect, it } from "vitest";

import { evaluateConformance } from "../chambers/conformance.js";
import { adaptCharterToRuntime } from "../modules/migration.js";

// P4 — migrating one real existing engine. CostIQ: meaningful contracts, real
// tests, manageable consequence, and not the most constitutionally dangerous
// engine to attempt first.

const costiq = adaptCharterToRuntime({
  charter: COSTIQ_CHARTER,
  stableId: "hive.costiq",
  instanceId: "instance.reference",
  version: "0.23.0",
  environment: "development",
  mission: "Cost calculation and cost intelligence. The only place money is computed.",
  owner: "Finance Core",
  // Honest and deliberately not derived: CostIQ is integrated through a real
  // governed path (the ForgeIQ -> CostIQ -> Prime vertical slice) and is not
  // certified against the manifesto's hard gates.
  maturity: "INTEGRATED",
  runtimeState: "READY",
  evidenceRefs: ["test:packages/forgeiq/tests/verticalSlice.test.ts"],
});

describe("P4: adapting CostIQ onto the Common Runtime Standard", () => {
  it("produces a declaration without CostIQ being modified", () => {
    // The whole point of the adapter route. CostIQ's source is untouched: its
    // charter predates V5 and already said everything the standard asks.
    expect(participantRuntimeSchema.safeParse(costiq).success).toBe(true);
  });

  it("carries the charter's boundary across, including who owns what it does not", () => {
    expect(costiq.charter.owns.length).toBeGreaterThan(0);
    expect(costiq.charter.doesNotOwn.length).toBeGreaterThan(0);
    // "We do not own pricing" is an abstraction. "...owned by PricingIQ" is a
    // routing instruction for the next person who asks CostIQ for a price.
    expect(costiq.charter.doesNotOwn.every((d) => d.includes("owned by"))).toBe(true);
  });

  it("declares no capabilities, because a charter does not describe a capability surface", () => {
    // Inventing capability declarations from responsibility statements would
    // fabricate an interface nobody wrote -- the same failure as adding an
    // event mapping before its emitter exists.
    expect(costiq.collaboration.offers).toEqual([]);
  });

  it("passes the architecture gates once adopted", () => {
    const findings = evaluateConformance({
      packages: [
        { packageName: "@proworks-hub/costiq", dependencies: ["@proworks-hub/contracts", "zod"], participant: costiq },
      ],
      adopted: ["@proworks-hub/costiq"],
      observedAt: "2026-08-31",
    });
    const failures = findings.filter((f) => f.status === "FAIL");
    expect(failures.map((f) => `${f.ruleId}: ${f.facts.join()}`)).toEqual([]);
    expect(findings.find((f) => f.ruleId === "ARCH-RUNTIME-METADATA")?.status).toBe("PASS");
    expect(findings.find((f) => f.ruleId === "ARCH-CHARTER-BOUNDARY")?.status).toBe("PASS");
  });

  it("does not let the adapter invent a maturity", () => {
    // A charter says what a component is FOR; maturity says what it has
    // PROVEN. Deriving one from the other would manufacture false confidence
    // at scale, silently, for every engine adapted after this one.
    const lower = adaptCharterToRuntime({
      charter: COSTIQ_CHARTER,
      stableId: "hive.costiq",
      instanceId: "i",
      version: "0.23.0",
      environment: "development",
      mission: "m",
      owner: "o",
      maturity: "IMPLEMENTED",
      runtimeState: "READY",
    });
    expect(lower.maturity).toBe("IMPLEMENTED");
    expect(costiq.maturity).toBe("INTEGRATED");
  });
});
