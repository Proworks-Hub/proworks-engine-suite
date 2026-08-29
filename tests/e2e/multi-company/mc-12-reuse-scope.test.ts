// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { afterAll, describe, expect, it } from "vitest";

import {
  createExperienceStore,
  createPatternLibrary,
  findReusableKnowledge,
} from "@proworks-hub/repair-learning";

import { assertMustFailDidNotHappen, pass, printReport, scenario } from "./harness.js";
import { repairCaseFor, signatureFor } from "./repairFixtures.js";

// ─────────────────────────────────────────────────────────────────────────────
// MC-12 — repair-reuse-scope. brighton may reuse a ksix LESSON, never its CASE.
//
//   startingState  ksix proven repair stored; stripped lesson exists
//   inject         brighton hits duplicate-delivery with the same signature
//   mustPass       matchedOn exact signature hash;
//                  brighton cannot fetch the ksix experience record
//   mustFail       brighton reads the ksix raw case
//
// The distinction the whole knowledge pipeline rests on. A lesson has been
// minimized, stripped and put in front of Governance, and is shareable BECAUSE
// it is no longer anybody's case. The raw case is the opposite: root cause,
// provenance, the order number, written for the tenant it belongs to.
//
// THE DEFECT THIS SCENARIO FOUND
//
// On its first run this returned ksix's entire RepairCase to brighton.
// `signatureSimilarity` weights tenantScope at 0.05, so an otherwise identical
// failure scored ~0.95 against a 0.6 threshold, and `crossTenantLearningApproved`
// was stored as false with nothing reading it -- a field declared and never
// read, the same shape as three other defects in this suite.
//
// MIS-MC12 made `readingTenant` required on `similarTo` and
// `findReusableKnowledge`, and applied the gate BEFORE scoring rather than
// filtering after. Filtering a scored list would mean the similarity pass had
// already read every tenant's case.
// ─────────────────────────────────────────────────────────────────────────────

const KSIX = "ksix";
const BRIGHTON = "brighton-signs";

describe("MC-12 — reuse by signature, never by tenant data", () => {
  it("refuses brighton the ksix case while leaving its own retrieval intact", () => {
    const s = scenario("MC-12");

    const store = createExperienceStore();
    const ksixCase = store.record(repairCaseFor(KSIX));
    if (!ksixCase.recorded) throw new Error("fixture failed to record");

    // The ksix case holds exactly what must not travel.
    expect(ksixCase.case.rootCause).toContain(KSIX);
    expect(ksixCase.case.rootCause).toContain("388");
    expect(ksixCase.case.applicabilityScope.crossTenantLearningApproved).toBe(false);

    // ── The premise: the two signatures are genuinely near-identical ──────
    //
    // Same symptom, same error code, same component. Only the tenant differs.
    // This is what makes the scenario hard -- if the signatures were plainly
    // different, nothing would have matched and the gate would be untested.
    const ksixSig = signatureFor(KSIX);
    const brightonSig = signatureFor(BRIGHTON);
    expect(brightonSig.signatureHash).not.toBe(ksixSig.signatureHash);
    expect(brightonSig.primarySymptom).toBe(ksixSig.primarySymptom);
    expect(brightonSig.affectedComponents).toEqual(ksixSig.affectedComponents);

    // ── mustPass: brighton cannot fetch the ksix experience record ────────
    const finding = findReusableKnowledge({
      readingTenant: BRIGHTON,
      signature: brightonSig,
      store,
      library: createPatternLibrary(),
      currentVersions: {},
    });

    expect(finding.bestPriorCase).toBeNull();
    expect(finding.priorCases).toEqual([]);
    expect(finding.reusable).toBe(false);
    // Even when nothing is reusable, revalidation is not waived.
    expect(finding.stillRequiresValidation).toBe(true);

    // Nothing of ksix's reached brighton by any field, not merely by case id.
    expect(JSON.stringify(finding).toLowerCase()).not.toContain("388");

    // ── The gate is the tenant, NOT the absence of a match ────────────────
    //
    // Without this, an empty result is equally consistent with a store that
    // never returns anything. ksix asking for ksix's own case still gets it.
    const ksixOwn = store.similarTo(ksixSig, KSIX);
    expect(ksixOwn).toHaveLength(1);
    expect(ksixOwn[0]!.case.caseId).toBe(ksixCase.case.caseId);
    expect(ksixOwn[0]!.matchedOn).toContain("exact signature hash");

    // ── mustPass: matchedOn exact signature hash ──────────────────────────
    //
    // brighton's OWN case, once it has one. The gate must refuse the neighbour
    // without breaking legitimate retrieval -- a boundary that also blocked
    // brighton from its own history would be a different bug, not a fix.
    const brightonCase = store.record(repairCaseFor(BRIGHTON));
    if (!brightonCase.recorded) throw new Error("fixture failed to record");

    const own = store.similarTo(brightonSig, BRIGHTON);
    expect(own).toHaveLength(1);
    expect(own[0]!.case.caseId).toBe(brightonCase.case.caseId);
    expect(own[0]!.matchedOn).toContain("exact signature hash");
    expect(own[0]!.similarity).toBe(1);

    // ── mustFail: brighton reads the ksix raw case ────────────────────────
    //
    // Asked of the store directly, and now with BOTH cases present -- the
    // arrangement where a similarity pass would have surfaced ksix alongside
    // brighton's own.
    const brightonView = store.similarTo(brightonSig, BRIGHTON);
    assertMustFailDidNotHappen(
      s,
      "brighton reads ksix raw case",
      brightonView.some((c) => c.case.caseId === ksixCase.case.caseId) ||
        JSON.stringify(brightonView).includes(ksixCase.case.caseId),
    );

    // Symmetric: the gate is a boundary, not a one-way rule about brighton.
    const ksixView = store.similarTo(ksixSig, KSIX);
    expect(ksixView.some((c) => c.case.caseId === brightonCase.case.caseId)).toBe(false);

    pass(s, "cross-tenant case retrieval refused both ways; own-tenant exact match intact");
  });
});

afterAll(() => printReport());
