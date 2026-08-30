/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import {
  classificationMayBecome,
  pipelinePlanSchema,
  stagesMayCarryExecutableCode,
  type PipelinePlan,
} from "../pipelinePlan.js";
import {
  TRACE_ALLOWLIST,
  executePipeline,
  isReservedMetadataKey,
  pipelineMayWidenAuthority,
  type ExecutorPorts,
  type PipelineMessage,
} from "../pipelineExecutor.js";

const T0 = "2026-08-30T10:00:00.000Z";

const ports = (over: Partial<ExecutorPorts> = {}): ExecutorPorts => ({
  mapping: {
    apply: ({ message }) => ({ applied: true, message }),
  },
  security: {
    sign: () => ({ ok: true, signature: "sig" }),
    verify: () => ({ ok: true }),
  },
  dispatch: {
    isCertified: () => true,
    dispatch: () => ({ dispatched: true, receiptId: "rcpt-1" }),
  },
  ...over,
});

const message = (over: Partial<PipelineMessage> = {}): PipelineMessage => ({
  envelopeJson: JSON.stringify({ fabricMessageId: "m-1" }),
  metadata: new Map([["content-type", "application/json"]]),
  traceContext: new Map([["traceparent", "00-abc-def-01"]]),
  classification: "INTERNAL",
  ...over,
});

const plan = (stages: unknown[], over: Record<string, unknown> = {}): PipelinePlan =>
  pipelinePlanSchema.parse({
    pipelineId: "pipe-1",
    patternPlanIntentId: "int-1",
    direction: "OUTBOUND",
    stages: [{ stageId: "s0", kind: "VALIDATE", reason: "Check before acting." }, ...stages],
    inboundClassification: "INTERNAL",
    topologyVersionId: "v-1",
    authorizationEvidenceRef: null,
    ...over,
  });

describe("the stage vocabulary is closed and each stage must be complete", () => {
  it("carries no field for executable code", () => {
    expect(stagesMayCarryExecutableCode()).toBe(false);
    const withCode = pipelinePlanSchema.safeParse({
      pipelineId: "p",
      patternPlanIntentId: "i",
      direction: "OUTBOUND",
      stages: [{ stageId: "s0", kind: "VALIDATE", reason: "r", script: "return 1;" }],
      inboundClassification: "INTERNAL",
      topologyVersionId: "v",
      authorizationEvidenceRef: null,
    });
    expect(withCode.success).toBe(false);
  });

  it("refuses a mapping stage with no reviewed contract to apply", () => {
    expect(() => plan([{ stageId: "s1", kind: "APPLY_MAPPING", reason: "translate" }])).toThrow();
  });

  it("refuses a split with no ceiling and a retry budget with no ceiling", () => {
    expect(() => plan([{ stageId: "s1", kind: "SPLIT", reason: "fan" }])).toThrow();
    expect(() => plan([{ stageId: "s1", kind: "RETRY_BUDGET", reason: "retry" }])).toThrow();
  });

  it("refuses a pipeline that does not validate first", () => {
    const result = pipelinePlanSchema.safeParse({
      pipelineId: "p",
      patternPlanIntentId: "i",
      direction: "OUTBOUND",
      stages: [{ stageId: "s1", kind: "NORMALIZE_METADATA", reason: "normalize" }],
      inboundClassification: "INTERNAL",
      topologyVersionId: "v",
      authorizationEvidenceRef: null,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("validate first");
  });

  it("refuses two dispatches, and a stage after dispatch", () => {
    expect(() =>
      plan([
        { stageId: "s1", kind: "DISPATCH", reason: "send", adapterId: "a" },
        { stageId: "s2", kind: "DISPATCH", reason: "send again", adapterId: "b" },
      ]),
    ).toThrow();
    expect(() =>
      plan([
        { stageId: "s1", kind: "DISPATCH", reason: "send", adapterId: "a" },
        { stageId: "s2", kind: "NORMALIZE_METADATA", reason: "after the horse bolted" },
      ]),
    ).toThrow();
  });

  it("refuses an inbound pipeline that extracts trace context before sanitizing it", () => {
    const result = pipelinePlanSchema.safeParse({
      pipelineId: "p",
      patternPlanIntentId: "i",
      direction: "INBOUND",
      stages: [
        { stageId: "s0", kind: "VALIDATE", reason: "check" },
        { stageId: "s1", kind: "TRACE", reason: "read the trace", traceOperation: "EXTRACT" },
      ],
      inboundClassification: "INTERNAL",
      topologyVersionId: "v",
      authorizationEvidenceRef: null,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("sanitize it first");
  });

  it("permits the same pipeline once a sanitize precedes the extract", () => {
    const ok = pipelinePlanSchema.safeParse({
      pipelineId: "p",
      patternPlanIntentId: "i",
      direction: "INBOUND",
      stages: [
        { stageId: "s0", kind: "VALIDATE", reason: "check" },
        { stageId: "s1", kind: "TRACE", reason: "strip baggage", traceOperation: "SANITIZE" },
        { stageId: "s2", kind: "TRACE", reason: "read the trace", traceOperation: "EXTRACT" },
      ],
      inboundClassification: "INTERNAL",
      topologyVersionId: "v",
      authorizationEvidenceRef: null,
    });
    expect(ok.success).toBe(true);
  });
});

describe("classification may tighten and never loosen", () => {
  it("ranks the envelope's classifications", () => {
    expect(classificationMayBecome("INTERNAL", "RESTRICTED")).toBe(true);
    expect(classificationMayBecome("RESTRICTED", "INTERNAL")).toBe(false);
    expect(classificationMayBecome("PERSONAL", "PERSONAL")).toBe(true);
    expect(classificationMayBecome("TENANT_PRIVATE", "PERSONAL")).toBe(true);
    expect(classificationMayBecome("PERSONAL", "TENANT_PRIVATE")).toBe(false);
  });

  it("refuses a message arriving less protected than the pipeline was built for", () => {
    const outcome = executePipeline(
      plan([], { inboundClassification: "RESTRICTED" }),
      message({ classification: "PUBLIC" }),
      ports(),
      T0,
    );
    expect(outcome.completed).toBe(false);
    if (!outcome.completed) expect(outcome.reason).toContain("never loosen");
  });

  it("refuses a mapping that returns a less protected message — translation is not declassification", () => {
    const declassifying = ports({
      mapping: {
        apply: ({ message: m }) => ({ applied: true, message: { ...m, classification: "PUBLIC" } }),
      },
    });
    const outcome = executePipeline(
      plan([{ stageId: "s1", kind: "APPLY_MAPPING", reason: "translate", mappingContractRef: "map-1" }], {
        inboundClassification: "PERSONAL",
      }),
      message({ classification: "PERSONAL" }),
      declassifying,
      T0,
    );
    expect(outcome.completed).toBe(false);
    if (!outcome.completed) expect(outcome.reason).toContain("declassify");
  });
});

describe("enrichment cannot manufacture authority", () => {
  it("recognises authorization-bearing keys, including suffixed variants", () => {
    expect(isReservedMetadataKey("authorization")).toBe(true);
    expect(isReservedMetadataKey("Authorization-v2")).toBe(true);
    expect(isReservedMetadataKey("  GRANT_ID ")).toBe(true);
    expect(isReservedMetadataKey("tenant-id")).toBe(true);
    expect(isReservedMetadataKey("content-type")).toBe(false);
    expect(isReservedMetadataKey("retry-count")).toBe(false);
  });

  it("refuses an enrichment stage that would write an authorization key", () => {
    const outcome = executePipeline(
      plan([{ stageId: "s1", kind: "ENRICH_METADATA", reason: "add context", enrichKeys: ["authorization-ref"] }]),
      message(),
      ports(),
      T0,
    );
    expect(outcome.completed).toBe(false);
    if (!outcome.completed) expect(outcome.reason).toContain("Authority is a reference");
  });

  it("permits an enrichment of ordinary transport metadata", () => {
    const outcome = executePipeline(
      plan([{ stageId: "s1", kind: "ENRICH_METADATA", reason: "add context", enrichKeys: ["retry-count"] }]),
      message(),
      ports(),
      T0,
    );
    expect(outcome.completed).toBe(true);
    if (outcome.completed) expect(outcome.messages[0]!.metadata.has("retry-count")).toBe(true);
  });
});

describe("trace context: baggage does not come inward", () => {
  it("sanitize keeps only the allowlist and discards baggage", () => {
    const outcome = executePipeline(
      plan([{ stageId: "s1", kind: "TRACE", reason: "strip", traceOperation: "SANITIZE" }], { direction: "INBOUND" }),
      message({
        traceContext: new Map([
          ["traceparent", "00-abc-def-01"],
          ["baggage", "role=admin,tenant=other"],
          ["x-custom", "anything"],
        ]),
      }),
      ports(),
      T0,
    );
    expect(outcome.completed).toBe(true);
    if (outcome.completed) {
      expect([...outcome.messages[0]!.traceContext.keys()]).toEqual(["traceparent"]);
      expect(TRACE_ALLOWLIST).not.toContain("baggage");
    }
  });

  it("refuses an inbound extract when the actual message still carries un-allowlisted keys", () => {
    // The plan is valid — sanitize precedes extract — but the runtime check
    // catches a message whose context was never actually reduced, which is
    // what a mis-implemented sanitize adapter would produce.
    const sneaky = pipelinePlanSchema.parse({
      pipelineId: "p",
      patternPlanIntentId: "i",
      direction: "INBOUND",
      stages: [
        { stageId: "s0", kind: "VALIDATE", reason: "check" },
        { stageId: "s1", kind: "TRACE", reason: "sanitize", traceOperation: "SANITIZE" },
        { stageId: "s2", kind: "TRACE", reason: "extract", traceOperation: "EXTRACT" },
      ],
      inboundClassification: "INTERNAL",
      topologyVersionId: "v",
      authorizationEvidenceRef: null,
    });
    // Remove the sanitize stage's effect by running only validate + extract.
    const unsanitized: PipelinePlan = { ...sneaky, stages: [sneaky.stages[0]!, sneaky.stages[2]!] };
    const outcome = executePipeline(
      unsanitized,
      message({ traceContext: new Map([["baggage", "role=admin"]]) }),
      ports(),
      T0,
    );
    expect(outcome.completed).toBe(false);
    if (!outcome.completed) expect(outcome.reason).toContain("attacker-writable baggage");
  });
});

describe("dispatch requires certification, and fan-out stays bounded", () => {
  it("refuses to dispatch through an uncertified adapter", () => {
    const outcome = executePipeline(
      plan([{ stageId: "s1", kind: "DISPATCH", reason: "send", adapterId: "rogue" }]),
      message(),
      ports({ dispatch: { isCertified: () => false, dispatch: () => ({ dispatched: true, receiptId: "r" }) } }),
      T0,
    );
    expect(outcome.completed).toBe(false);
    if (!outcome.completed) expect(outcome.reason).toContain("no current certification");
  });

  it("dispatches through a certified adapter and returns its receipt", () => {
    const outcome = executePipeline(
      plan([{ stageId: "s1", kind: "DISPATCH", reason: "send", adapterId: "durable-log" }]),
      message(),
      ports(),
      T0,
    );
    expect(outcome.completed).toBe(true);
    if (outcome.completed) expect(outcome.receiptId).toBe("rcpt-1");
  });

  it("splits an array envelope into messages, bounded by the declared ceiling", () => {
    const outcome = executePipeline(
      plan([{ stageId: "s1", kind: "SPLIT", reason: "fan out", maxFanOut: 10 }]),
      message({ envelopeJson: JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]) }),
      ports(),
      T0,
    );
    expect(outcome.completed).toBe(true);
    if (outcome.completed) expect(outcome.messages).toHaveLength(3);
  });

  it("refuses a split that would exceed the ceiling, rather than truncating it", () => {
    const outcome = executePipeline(
      plan([{ stageId: "s1", kind: "SPLIT", reason: "fan out", maxFanOut: 2 }]),
      message({ envelopeJson: JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]) }),
      ports(),
      T0,
    );
    expect(outcome.completed).toBe(false);
    if (!outcome.completed) expect(outcome.reason).toContain("amplifier");
  });

  it("aggregates to the most restrictive classification present, not the first", () => {
    // The messages must genuinely DIFFER in classification, or "first" and
    // "strictest" are the same value and the test proves nothing. A mapping
    // stage promotes the second message to RESTRICTED; the batch must inherit
    // that rather than the INTERNAL the first one carries.
    let seen = 0;
    const promoteSecond = ports({
      mapping: {
        apply: ({ message: m }) => {
          seen += 1;
          return seen === 2 ? { applied: true, message: { ...m, classification: "RESTRICTED" } } : { applied: true, message: m };
        },
      },
    });
    const outcome = executePipeline(
      plan([
        { stageId: "s1", kind: "SPLIT", reason: "fan out", maxFanOut: 10 },
        { stageId: "s2", kind: "APPLY_MAPPING", reason: "classify", mappingContractRef: "map-1" },
        { stageId: "s3", kind: "AGGREGATE", reason: "batch", maxBatch: 10 },
      ]),
      message({ envelopeJson: JSON.stringify([{ id: 1 }, { id: 2 }]) }),
      promoteSecond,
      T0,
    );
    expect(outcome.completed).toBe(true);
    if (outcome.completed) {
      expect(outcome.messages).toHaveLength(1);
      // Taking the first message's label would declassify the second by
      // arithmetic, which is the whole reason this reduce exists.
      expect(outcome.messages[0]!.classification).toBe("RESTRICTED");
    }
  });

  it("stops at the first failure instead of dispatching a half-refused message", () => {
    const outcome = executePipeline(
      plan([
        { stageId: "s1", kind: "SECURITY", reason: "verify", securityOperation: "VERIFY" },
        { stageId: "s2", kind: "DISPATCH", reason: "send", adapterId: "a" },
      ]),
      message(),
      ports({
        security: { sign: () => ({ ok: true, signature: "s" }), verify: () => ({ ok: false, reason: "bad signature" }) },
      }),
      T0,
    );
    expect(outcome.completed).toBe(false);
    if (!outcome.completed) {
      expect(outcome.failedAt).toBe("s1");
      expect(outcome.trace.map((t) => t.stageId)).not.toContain("s2");
    }
  });

  it("reports where the undeliverable went when the plan declared a dead letter", () => {
    const outcome = executePipeline(
      plan([
        { stageId: "s1", kind: "DEAD_LETTER", reason: "catch failures", deadLetterQueue: "dlq.fabric" },
        { stageId: "s2", kind: "DISPATCH", reason: "send", adapterId: "a" },
      ]),
      message(),
      ports({ dispatch: { isCertified: () => true, dispatch: () => ({ dispatched: false, reason: "broker down" }) } }),
      T0,
    );
    expect(outcome.completed).toBe(false);
    if (!outcome.completed) expect(outcome.deadLetteredTo).toBe("dlq.fabric");
  });

  it("widens nothing", () => {
    expect(pipelineMayWidenAuthority()).toBe(false);
  });
});
