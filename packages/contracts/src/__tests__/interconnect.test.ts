// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { handoffEnvelopeSchema, linkPermits, type InstanceLink } from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// The Interconnect contract had no tests in this package.
//
// Every test of it lived in the Hub, which is the host — so the contract that
// two independent instances agree on was verified only by one side's
// integration suite. A change here that broke a sender would have been caught
// by whoever ran the Hub's tests, and not by the package that defines the
// agreement.
//
// TEST IDENTITY IS THE REASON THIS FILE EXISTS NOW
//
// `isTest` and `testExecutionId` are required envelope fields rather than
// payload conventions, so that an intermediary cannot strip them: the envelope
// is `.strict()`, the field is required, and an envelope missing it fails to
// parse at all. These tests are what makes that claim checkable rather than
// merely stated in a comment.
// ─────────────────────────────────────────────────────────────────────────────

const base = {
  envelopeId: "env.ORDER-1",
  globalCorrelationId: "ORDER-1",
  sourceInstanceId: "hive.ksix",
  destinationInstanceId: "hive.proworks",
  sourceEngineId: "interconnect.gateway",
  destinationCapability: "SEND_WORK",
  tenantId: "proworks",
  isTest: false,
  contractType: "manufacturing.package",
  contractVersion: "1.0.0",
  purpose: "fulfil_customer_order",
  createdAt: "2026-08-30T12:00:00.000Z",
  idempotencyKey: "handoff:ORDER-1",
  priorStageAttestations: [],
  payload: { sku: "FIREPIT-24" },
  sensitivityClass: "internal",
  policyLabels: [],
  provenanceRefs: [],
  integrityHash: "sha256:abc",
  senderSignature: "ed25519:sig",
  acknowledgementRequired: true,
};

const envelope = (over: Record<string, unknown> = {}) => ({ ...base, ...over });

/** Every error message for a field, flattened. */
function reasons(input: unknown): string {
  const result = handoffEnvelopeSchema.safeParse(input);
  return result.success ? "" : JSON.stringify(result.error.flatten());
}

// ─────────────────────────────────────────────────────────────────────────────

describe("test identity cannot be omitted", () => {
  it("refuses an envelope with no isTest at all", () => {
    const { isTest, ...withoutIt } = base;
    void isTest;
    const result = handoffEnvelopeSchema.safeParse(withoutIt);

    expect(result.success).toBe(false);
    // No default. A handoff whose test status is a guess is one nobody can
    // safely clean up and nobody can safely keep.
    expect(reasons(withoutIt)).toContain("isTest");
  });

  it("refuses an intermediary that strips it, because the schema is strict", () => {
    // The threat this shape defends against: something in the middle forwards
    // the envelope minus the awkward field. Strict + required means the
    // stripped envelope is not a valid envelope, rather than a production one.
    const stripped = envelope({ isTest: undefined });
    expect(handoffEnvelopeSchema.safeParse(stripped).success).toBe(false);
  });

  it("refuses an unknown field smuggled alongside it", () => {
    expect(handoffEnvelopeSchema.safeParse(envelope({ isProduction: true })).success).toBe(false);
  });

  it("accepts a production handoff carrying no execution id", () => {
    expect(handoffEnvelopeSchema.safeParse(envelope({ isTest: false })).success).toBe(true);
  });
});

describe("the pairing of isTest and testExecutionId", () => {
  it("refuses a test handoff with no execution id, and names the field", () => {
    const bad = envelope({ isTest: true });
    expect(handoffEnvelopeSchema.safeParse(bad).success).toBe(false);
    // A test row that cannot be scoped to its run is how test data becomes
    // permanent — the message has to say so, because the operator reading it
    // is deciding whether this was their mistake or the sender's.
    expect(reasons(bad)).toContain("testExecutionId");
    expect(reasons(bad)).toContain("clean up");
  });

  it("refuses a production handoff carrying an execution id", () => {
    // The opposite mistake and the more dangerous one: a real order that a
    // cleanup routine will eventually delete as though it were test data.
    const bad = envelope({ isTest: false, testExecutionId: "run-1" });
    expect(handoffEnvelopeSchema.safeParse(bad).success).toBe(false);
    expect(reasons(bad)).toContain("testExecutionId");
  });

  it("accepts a test handoff that is properly scoped", () => {
    const good = envelope({ isTest: true, testExecutionId: "run-1" });
    expect(handoffEnvelopeSchema.safeParse(good).success).toBe(true);
  });

  it("refuses an empty execution id, which would scope a cleanup to nothing", () => {
    expect(
      handoffEnvelopeSchema.safeParse(envelope({ isTest: true, testExecutionId: "" })).success,
    ).toBe(false);
  });
});

describe("the tenant a handoff is for", () => {
  it("is required, because every default is somebody's real data", () => {
    const { tenantId, ...withoutIt } = base;
    void tenantId;
    expect(handoffEnvelopeSchema.safeParse(withoutIt).success).toBe(false);
    expect(reasons(withoutIt)).toContain("tenantId");
  });

  it("refuses an empty one", () => {
    expect(handoffEnvelopeSchema.safeParse(envelope({ tenantId: "" })).success).toBe(false);
  });
});

describe("test identity does not weaken the rules that were already there", () => {
  it("still refuses both payload and payloadRef", () => {
    const bad = envelope({
      isTest: true,
      testExecutionId: "run-1",
      payloadRef: {
        locator: "s3://x",
        contentType: "application/json",
        integrityHash: "sha256:x",
        expiresAt: "2026-09-01T00:00:00.000Z",
      },
    });
    expect(handoffEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it("still refuses restricted content sent inline, test run or not", () => {
    // A test run is not a reason to let protected content cross inline. The
    // data is just as real either way.
    const bad = envelope({ isTest: true, testExecutionId: "run-1", sensitivityClass: "restricted" });
    expect(handoffEnvelopeSchema.safeParse(bad).success).toBe(false);
  });
});

describe("a link is still what authorizes, and knows nothing about tests", () => {
  const link: InstanceLink = {
    linkId: "link.ksix.proworks",
    sourceInstanceId: "hive.ksix",
    destinationInstanceId: "hive.proworks",
    relationshipType: "manufacturing-supplier",
    allowedCapabilities: ["SEND_WORK"],
    allowedContractTypes: ["manufacturing.package"],
    allowedPurposes: ["fulfil_customer_order"],
    maxSensitivity: "internal",
    trustTier: "attestation_accepted",
    createdBy: "operator",
    approvedBy: "gd.1",
    validFrom: "2026-01-01T00:00:00.000Z",
    status: "active",
    policyVersion: "p1",
  } as InstanceLink;

  it("permits a test handoff exactly as it permits a real one", () => {
    // Deliberate: `isTest` decides what production shows, not what may cross.
    // A link that authorized tests more freely than production would be a way
    // to send anything by claiming it was a test.
    const now = "2026-08-30T12:00:01.000Z";
    const asTest = linkPermits({
      link,
      envelope: envelope({ isTest: true, testExecutionId: "run-1" }) as never,
      now,
    });
    const asReal = linkPermits({ link, envelope: envelope() as never, now });
    expect(asTest.permitted).toBe(asReal.permitted);
    expect(asTest.permitted).toBe(true);
  });
});
