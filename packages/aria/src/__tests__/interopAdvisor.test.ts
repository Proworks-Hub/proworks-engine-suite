// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import * as advisor from "../interopAdvisor.js";
import {
  FORBIDDEN_ADVISOR_VERBS,
  advisorMayActOnItsOwnAdvice,
  explainRejections,
  interopAdviceSchema,
  mayPerform,
  modelConfidenceGrantsPermission,
  suggestAlternatives,
} from "../interopAdvisor.js";

const T0 = "2026-08-30T10:00:00.000Z";

describe("ARIA advises and cannot decide", () => {
  it("exposes no verb that could authorize anything", () => {
    const surface = Object.keys(advisor).map((k) => k.toLowerCase());
    for (const forbidden of ["approve", "authorize", "permit", "grant", "activate", "install", "revoke"]) {
      expect(surface.some((name) => name.startsWith(forbidden))).toBe(false);
    }
  });

  it("holds the two claims that keep confidence away from permission", () => {
    expect(modelConfidenceGrantsPermission()).toBe(false);
    expect(advisorMayActOnItsOwnAdvice()).toBe(false);
  });

  it("refuses to perform any forbidden verb, and says who owns it", () => {
    for (const verb of FORBIDDEN_ADVISOR_VERBS) {
      const verdict = mayPerform(`${verb} the new adapter`);
      expect(verdict.permitted).toBe(false);
      expect(verdict.reason).toContain("belongs to Governance");
    }
  });

  it("catches a forbidden verb that is not at the start of the phrase", () => {
    expect(mayPerform("please go and approve this mapping").permitted).toBe(false);
  });

  it("permits an advisory action", () => {
    const verdict = mayPerform("explain why the route was refused");
    expect(verdict.permitted).toBe(true);
    expect(verdict.reason).toContain("free to disregard");
  });
});

describe("advice must carry its own doubts and its own decider", () => {
  const base = {
    adviceId: "adv-1",
    kind: "DRAFT_MAPPING" as const,
    subject: "ksix.order → partner.workorder",
    body: "Draft mapping attached.",
    isAuthorization: false as const,
    decidedBy: "GOVERNANCE" as const,
    uncertainties: ["Whether `status` means the same thing on both sides."],
    citations: [],
    modelProvenance: { producedByModel: true, modelId: "claude-opus-5" },
    createdAt: T0,
  };

  it("accepts model advice that states its uncertainties", () => {
    expect(interopAdviceSchema.safeParse(base).success).toBe(true);
  });

  it("refuses model advice that hides its guesses", () => {
    const result = interopAdviceSchema.safeParse({ ...base, uncertainties: [] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("launders them");
  });

  it("refuses advice that claims to be authorization", () => {
    expect(interopAdviceSchema.safeParse({ ...base, isAuthorization: true }).success).toBe(false);
  });

  it("requires model-produced advice to name the model, and vice versa", () => {
    expect(interopAdviceSchema.safeParse({ ...base, modelProvenance: { producedByModel: true, modelId: null } }).success).toBe(false);
    expect(
      interopAdviceSchema.safeParse({
        ...base,
        uncertainties: [],
        modelProvenance: { producedByModel: false, modelId: "claude-opus-5" },
      }).success,
    ).toBe(false);
  });

  it("refuses a research summary with no citations — that is a recollection", () => {
    const result = interopAdviceSchema.safeParse({ ...base, kind: "RESEARCH_SUMMARY", citations: [] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("recollection");
  });

  it("distinguishes a retrieved source from a recalled one", () => {
    const withCitation = interopAdviceSchema.safeParse({
      ...base,
      kind: "RESEARCH_SUMMARY",
      citations: [{ url: "https://www.asyncapi.com/docs", title: "AsyncAPI 3.0", retrievedAt: T0, retrieved: false }],
    });
    expect(withCitation.success).toBe(true);
    if (withCitation.success) expect(withCitation.data.citations[0]!.retrieved).toBe(false);
  });
});

describe("explanations reuse the planner's own reasons", () => {
  it("relays every rejection and separates the ones with no remedy", () => {
    const advice = explainRejections({
      adviceId: "adv-2",
      subject: "ordering → manufacturing.plan",
      rejections: [
        { patternId: "SYNC_REQUEST_REPLY", reason: "The sender may be offline.", remedy: "Use store-and-forward." },
        { patternId: "INTERCONNECT_GATEWAY_HANDOFF", reason: "This conversation stays inside one instance.", remedy: null },
      ],
      createdAt: T0,
    });
    expect(advice.body).toContain("What would change it: Use store-and-forward.");
    expect(advice.body).toContain("no available remedy");
    expect(advice.body).toContain("route existing has never meant a route is allowed");
    expect(advice.isAuthorization).toBe(false);
  });
});

describe("suggestions come only from what is already permitted", () => {
  it("lists permitted options with their tradeoffs", () => {
    const advice = suggestAlternatives({
      adviceId: "adv-3",
      subject: "ordering → planning",
      permitted: [{ optionId: "PUBLISH_SUBSCRIBE", tradeoff: "Durable and replayable, but no reply." }],
      createdAt: T0,
    });
    expect(advice.body).toContain("PUBLISH_SUBSCRIBE");
    expect(advice.body).toContain("already permitted");
  });

  it("says plainly when there is nothing permitted to suggest, rather than inventing one", () => {
    const advice = suggestAlternatives({ adviceId: "adv-4", subject: "x", permitted: [], createdAt: T0 });
    expect(advice.body).toContain("would need a Governance decision first");
  });
});
