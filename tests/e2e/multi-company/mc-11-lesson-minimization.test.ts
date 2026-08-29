// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { afterAll, describe, expect, it } from "vitest";

import { createExperienceStore, generalize } from "@proworks-hub/repair-learning";

import {
  assertMustFailDidNotHappen,
  engineDefect,
  pass,
  printReport,
  scenario,
} from "./harness.js";
import { PERMISSIVE_AUTHORITY, repairCaseFor } from "./repairFixtures.js";

// ─────────────────────────────────────────────────────────────────────────────
// MC-11 — repair-minimize. A lesson from a ksix miss must not contain ksix.
//
//   startingState  ksix duplicate-delivery failure recorded
//   inject         promote a generalized lesson from that case
//   mustPass       no tenantId in lesson title/body/applicableComponents;
//                  status PROPOSED, not APPROVED
//   mustFail       ksix or order number in the stored lesson
//   faultClass     confused-deputy
//   blastRadius    HIVE
//
// Minimization is a containment boundary, not tidying. A lesson is the one
// artefact that crosses from one tenant to all of them, so whatever is left in
// it crosses too. "Do not name the tenant" is not politeness -- the name is the
// payload that turns shared learning into a disclosure.
//
// And the lesson lands PROPOSED. Surviving minimization earns it a place in the
// queue, not force. Approval is Governance's, and a pipeline that promoted
// straight to APPROVED would make the review step decorative.
// ─────────────────────────────────────────────────────────────────────────────

const KSIX = "ksix";

describe("MC-11 — lesson minimization", () => {
  it("refuses a lesson carrying a tenant or an order id, and proposes the clean one", () => {
    const s = scenario("MC-11");

    const store = createExperienceStore();
    const recorded = store.record(repairCaseFor(KSIX));
    if (!recorded.recorded) throw new Error("fixture failed to record");

    // The source case names the tenant and the order. It is supposed to: that
    // is what makes minimization load-bearing rather than a formality.
    expect(recorded.case.rootCause).toContain(KSIX);
    expect(recorded.case.rootCause).toContain("388");

    // ── The leaky lesson is refused, and refused AT MINIMIZATION ──────────
    //
    // The stage matters. Refused for some other reason -- ineligible case,
    // missing authority -- would leave minimization itself unproven.
    const leaky = generalize({
      ruleId: "rule_leaky",
      repairCase: recorded.case,
      authority: PERMISSIVE_AUTHORITY,
      proposed: {
        title: "KSix order 388 duplicated",
        description: "Tenant ksix order 388 created two work orders.",
        failureClass: "DUPLICATE_DELIVERY",
        applicableComponents: ["event-consumer"],
        preconditions: ["at-least-once delivery"],
        recommendedResponse: "Key on a delivery identifier.",
        forbiddenResponses: ["disable the duplicate check"],
      },
      proposedBy: "foundry.generalizer",
      proposedAt: "2026-08-29T11:00:00.000Z",
      constitutionVersion: "1.0",
    });
    expect(leaky.generalized).toBe(false);
    if (!leaky.generalized) expect(leaky.stage).toBe("minimization");

    // ── The minimized lesson is accepted ──────────────────────────────────
    const clean = generalize({
      ruleId: "rule_clean",
      repairCase: recorded.case,
      authority: PERMISSIVE_AUTHORITY,
      proposed: {
        title: "Idempotent consumers under at-least-once delivery",
        description:
          "Consumers of at-least-once event delivery must make consequential state transitions idempotent.",
        failureClass: "DUPLICATE_DELIVERY",
        applicableComponents: ["event-consumer", "work-order-intake"],
        preconditions: ["the transport guarantees at-least-once delivery"],
        recommendedResponse: "Key the transition on a delivery identifier.",
        forbiddenResponses: ["disable the duplicate check"],
      },
      proposedBy: "foundry.generalizer",
      proposedAt: "2026-08-29T11:00:00.000Z",
      constitutionVersion: "1.0",
    });
    expect(clean.generalized).toBe(true);
    if (!clean.generalized) return;

    // ── mustPass: no tenant id anywhere in the STORED LESSON ──────────────
    //
    // The whole rule is serialized, not three hand-picked fields. A scan that
    // named the fields it checked would keep passing while a tenant id sat in
    // `preconditions`, `recommendedResponse`, or any field added later -- and
    // the fields added later are exactly the ones nobody thinks to re-check.
    //
    // Widening it from three fields to all sixteen is what surfaced the
    // provenance channel recorded at the bottom of this test.
    const serialized = JSON.stringify(clean.rule);
    expect(serialized.length).toBeGreaterThan(0);

    expect(serialized.toLowerCase()).not.toContain(KSIX);
    expect(serialized).not.toContain("388");

    // The named fields, still asserted individually so a failure says which one.
    expect(clean.rule.title.toLowerCase()).not.toContain(KSIX);
    expect(clean.rule.description.toLowerCase()).not.toContain(KSIX);
    for (const component of clean.rule.applicableComponents) {
      expect(component.toLowerCase()).not.toContain(KSIX);
    }

    // No other tenant leaked in either -- a lesson naming brighton would be
    // just as much a disclosure, and "does not say ksix" would not catch it.
    for (const other of ["brighton", "longmont", "family-table", "makerops"]) {
      expect(serialized.toLowerCase(), `lesson names ${other}`).not.toContain(other);
    }

    // ── mustPass: PROPOSED, not APPROVED ──────────────────────────────────
    expect(clean.rule.status).toBe("PROPOSED");
    expect(clean.rule.status).not.toBe("APPROVED");

    // ── mustFail: ksix or an order number in the stored lesson ────────────
    assertMustFailDidNotHappen(
      s,
      "ksix or order number in stored lesson",
      /ksix|388/i.test(serialized),
    );

    // ── The provenance channel ────────────────────────────────────────────
    //
    // Minimization scrubs what the lesson SAYS. It does not constrain what the
    // lesson REFERS TO: `provenance.derivedFromCaseIds` carries the source case
    // id through untouched, and that is mostly right -- a rule nobody can trace
    // to its evidence cannot be reviewed or withdrawn when the diagnosis turns
    // out to be wrong.
    //
    // But the lesson is the artefact that crosses to every tenant, and the case
    // id crosses with it. Whether that discloses anything depends entirely on
    // how the host mints case ids, which minimization neither sees nor
    // constrains. Naming a case after its tenant is the natural thing to do and
    // nothing here refuses it.
    //
    // Demonstrated rather than asserted, because it is a design question, not a
    // failed rule: the fix is either opaque case ids by contract, or a shared
    // view of a lesson that carries a provenance reference the reader cannot
    // resolve. Both are decisions above a test's authority.
    expect(clean.rule.provenance.derivedFromCaseIds).toEqual([recorded.case.caseId]);

    const tenantNamed = createExperienceStore();
    const named = tenantNamed.record(repairCaseFor(KSIX, { caseId: `case_${KSIX}_388` }));
    if (!named.recorded) throw new Error("fixture failed to record");
    const fromNamed = generalize({
      ruleId: "rule_from_named",
      repairCase: named.case,
      authority: PERMISSIVE_AUTHORITY,
      proposed: {
        title: "Idempotent consumers under at-least-once delivery",
        description:
          "Consumers of at-least-once event delivery must make consequential state transitions idempotent.",
        failureClass: "DUPLICATE_DELIVERY",
        applicableComponents: ["event-consumer", "work-order-intake"],
        preconditions: ["the transport guarantees at-least-once delivery"],
        recommendedResponse: "Key the transition on a delivery identifier.",
        forbiddenResponses: ["disable the duplicate check"],
      },
      proposedBy: "foundry.generalizer",
      proposedAt: "2026-08-29T11:00:00.000Z",
      constitutionVersion: "1.0",
    });

    if (fromNamed.generalized && /ksix|388/i.test(JSON.stringify(fromNamed.rule))) {
      engineDefect(
        s,
        "Minimization scrubs the lesson's content but not its provenance. With a tenant-named " +
          `case id (case_${KSIX}_388) the tenant and order number reach the HIVE-scoped lesson ` +
          "through provenance.derivedFromCaseIds, and generalize() accepts it. The reference " +
          "itself is right -- a rule that cannot be traced to its evidence cannot be withdrawn -- " +
          "so the question is whether case ids are opaque by contract, or whether a lesson shared " +
          "across tenants should carry a provenance reference the reader cannot resolve. " +
          "Content minimization is working; this is the channel beside it.",
      );
    }

    pass(s, "leaky lesson refused at minimization; clean lesson PROPOSED, whole-rule scan clean");
  });
});

afterAll(() => printReport());
