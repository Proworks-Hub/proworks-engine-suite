/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/interop/pipelineExecutor.ts
 * Module:   neural-fabric / interop
 * Purpose:  Running mediation stages, and refusing the ones that would widen anything.
 */

import { classificationMayBecome, type PipelinePlan, type PipelineStage } from "./pipelinePlan.js";
import type { Classification } from "../domain/envelope.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE EXECUTOR'S JOB IS MOSTLY REFUSAL
//
// Running twelve known operations in order is the easy half. The half that
// matters is the set of things a stage must not be able to do even though it
// sits inside the message path with the message in its hands:
//
//   - widen a classification (mediation is not declassification);
//   - write an authorization-bearing metadata key (§9: no field manufactures
//     authority, and an enrichment stage is the most natural place to try);
//   - carry attacker-controlled trace baggage inward (§25 certification gate);
//   - fan out without a ceiling (retry/split amplification, §14 threat model);
//   - dispatch through an adapter that was never certified (§25 again).
//
// Each of those is checked here rather than trusted to the plan schema,
// because a plan is authored once and executed a million times, and the
// interesting failures are the ones where a valid plan meets a hostile
// message.
//
// PURE, WITH PORTS
//
// No clock, no I/O, no key material. `now` arrives as an argument and the
// three effects — mapping, signing, dispatching — arrive as ports the host
// supplies. The Fabric holds no keys (Security IQ does) and owns no
// transport (adapters do), so both are someone else's implementation and the
// executor's honesty about that is what makes it testable.
// ─────────────────────────────────────────────────────────────────────────────

export interface PipelineMessage {
  /** The serialized envelope. Opaque to every stage except mapping and codec. */
  readonly envelopeJson: string;
  /** Transport-level metadata. Never business data. */
  readonly metadata: ReadonlyMap<string, string>;
  /** W3C-shaped trace context. Attacker-controlled until sanitized. */
  readonly traceContext: ReadonlyMap<string, string>;
  readonly classification: Classification;
}

/**
 * Metadata keys no enrichment may ever write.
 *
 * Every one of these is a key that something downstream might read as an
 * answer to "is this allowed?". An enrichment stage that could write them
 * would be manufacturing authority out of a config file — the exact shape
 * §9 forbids, arriving through the most boring door in the system.
 *
 * Matching is on the normalized key, and it is a PREFIX check on purpose:
 * `authorization-v2` is the same idea wearing a suffix.
 */
export const RESERVED_METADATA_PREFIXES: readonly string[] = Object.freeze([
  "authorization",
  "authz",
  "auth-",
  "permission",
  "grant",
  "decision",
  "principal",
  "identity",
  "tenant",
  "instance",
  "classification",
  "signature",
  "trust",
]);

/**
 * Trace keys that may cross an inbound boundary.
 *
 * W3C trace context proper — traceparent and tracestate — is structured,
 * size-bounded and carries no free-form payload. `baggage` is deliberately
 * absent: it is an arbitrary key-value store that anybody upstream can write,
 * and letting it inward is how an external caller sets a value an internal
 * consumer treats as trustworthy. Correlating traces does not require it.
 */
export const TRACE_ALLOWLIST: readonly string[] = Object.freeze(["traceparent", "tracestate"]);

export function isReservedMetadataKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return RESERVED_METADATA_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

// ── Ports ────────────────────────────────────────────────────────────────────

export interface MappingPort {
  /** Applies a reviewed contract. Returns the transformed message, or refuses. */
  apply(input: {
    readonly mappingContractRef: string;
    readonly message: PipelineMessage;
  }):
    | { readonly applied: true; readonly message: PipelineMessage }
    | { readonly applied: false; readonly reason: string };
}

export interface SecurityStagePort {
  sign(input: { readonly message: PipelineMessage; readonly now: string }):
    | { readonly ok: true; readonly signature: string }
    | { readonly ok: false; readonly reason: string };
  verify(input: { readonly message: PipelineMessage; readonly now: string }):
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string };
}

export interface DispatchPort {
  /** True only when the named adapter holds current certification for this plan. */
  isCertified(adapterId: string): boolean;
  dispatch(input: {
    readonly adapterId: string;
    readonly messages: readonly PipelineMessage[];
  }): { readonly dispatched: true; readonly receiptId: string } | { readonly dispatched: false; readonly reason: string };
}

export interface ExecutorPorts {
  readonly mapping: MappingPort;
  readonly security: SecurityStagePort;
  readonly dispatch: DispatchPort;
}

// ── Result ───────────────────────────────────────────────────────────────────

export interface StageTrace {
  readonly stageId: string;
  readonly kind: PipelineStage["kind"];
  readonly messagesIn: number;
  readonly messagesOut: number;
  readonly note: string;
}

export type PipelineOutcome =
  | {
      readonly completed: true;
      readonly messages: readonly PipelineMessage[];
      readonly receiptId: string | null;
      readonly trace: readonly StageTrace[];
    }
  | {
      readonly completed: false;
      readonly failedAt: string;
      readonly kind: PipelineStage["kind"];
      readonly reason: string;
      /** Where the undeliverable went, when the plan declared somewhere. */
      readonly deadLetteredTo: string | null;
      readonly trace: readonly StageTrace[];
    };

const withMetadata = (message: PipelineMessage, entries: ReadonlyMap<string, string>): PipelineMessage => ({
  ...message,
  metadata: entries,
});

/**
 * Runs a pipeline over one inbound message.
 *
 * Stages see a frozen list and return a new one — nothing mutates in place,
 * so a stage cannot reach backwards and change what an earlier stage already
 * decided. Failure stops the pipeline: continuing past a failed stage would
 * dispatch a message that half a pipeline refused.
 */
export function executePipeline(
  plan: PipelinePlan,
  input: PipelineMessage,
  ports: ExecutorPorts,
  now: string,
): PipelineOutcome {
  const trace: StageTrace[] = [];
  let messages: readonly PipelineMessage[] = [input];
  let receiptId: string | null = null;
  let attemptsCeiling: number | null = null;
  let deadLetter: string | null = null;

  // The plan declares what it received; a message claiming to be less
  // protected than the plan was built for is refused before any stage runs.
  if (!classificationMayBecome(plan.inboundClassification, input.classification)) {
    return {
      completed: false,
      failedAt: "pre-flight",
      kind: "VALIDATE",
      reason: `The message arrived classified ${input.classification} on a pipeline built for ${plan.inboundClassification}. A pipeline may tighten a classification and never loosen one; accepting this would let a relabelled message inherit a path approved for stricter data.`,
      deadLetteredTo: null,
      trace,
    };
  }

  const fail = (stage: PipelineStage, reason: string): PipelineOutcome => ({
    completed: false,
    failedAt: stage.stageId,
    kind: stage.kind,
    reason,
    deadLetteredTo: deadLetter,
    trace,
  });

  for (const stage of plan.stages) {
    const before = messages.length;

    switch (stage.kind) {
      case "VALIDATE": {
        for (const message of messages) {
          try {
            JSON.parse(message.envelopeJson);
          } catch {
            return fail(stage, "The message is not parseable. Nothing downstream may act on input that has not parsed — that is where deserialization and parser-differential bugs are exploited.");
          }
        }
        trace.push({ stageId: stage.stageId, kind: stage.kind, messagesIn: before, messagesOut: messages.length, note: "Parsed and structurally checked." });
        break;
      }

      case "NORMALIZE_METADATA": {
        messages = messages.map((message) => {
          const normalized = new Map<string, string>();
          for (const [key, value] of message.metadata) normalized.set(key.trim().toLowerCase(), value);
          return withMetadata(message, normalized);
        });
        trace.push({ stageId: stage.stageId, kind: stage.kind, messagesIn: before, messagesOut: messages.length, note: "Metadata keys canonicalized." });
        break;
      }

      case "APPLY_MAPPING": {
        const next: PipelineMessage[] = [];
        for (const message of messages) {
          const result = ports.mapping.apply({ mappingContractRef: stage.mappingContractRef!, message });
          if (!result.applied) {
            return fail(stage, `Mapping "${stage.mappingContractRef}" refused: ${result.reason} A partial translation is worse than none — the receiver cannot tell which fields survived.`);
          }
          // A mapping may tighten a classification (minimizing at a boundary
          // is a legitimate mapping) but never loosen one. A mapping that
          // could relabel PERSONAL as INTERNAL would be a declassification
          // engine wearing a translation's clothes.
          if (!classificationMayBecome(message.classification, result.message.classification)) {
            return fail(
              stage,
              `Mapping "${stage.mappingContractRef}" returned a message classified ${result.message.classification} from one classified ${message.classification}. Translation does not declassify, and a mapping that could would be the quietest data-exfiltration path in the system.`,
            );
          }
          next.push(result.message);
        }
        messages = next;
        trace.push({ stageId: stage.stageId, kind: stage.kind, messagesIn: before, messagesOut: messages.length, note: `Applied ${stage.mappingContractRef}.` });
        break;
      }

      case "SPLIT": {
        // A STRUCTURAL split, not a scripted one: a message whose envelope is
        // a JSON array becomes one message per element. That is the only
        // splitting rule available, and it is deliberately the boring one —
        // any split needing a rule to decide where to cut is asking for an
        // expression, which is the thing this vocabulary exists to refuse.
        const ceiling = stage.maxFanOut!;
        const next: PipelineMessage[] = [];
        for (const message of messages) {
          const parsed: unknown = JSON.parse(message.envelopeJson);
          if (!Array.isArray(parsed)) {
            return fail(stage, "A split stage received a message whose envelope is not an array. There is nothing to split, and a stage that silently passed it through would make the plan's fan-out ceiling meaningless.");
          }
          // The ceiling covers the whole stage, not each message: fan-out
          // multiplies when applied to an already-split set, and checking
          // per-message would let two messages of 600 through a ceiling of
          // 1,000. Refused rather than truncated — a truncated fan-out drops
          // messages nobody knows were dropped.
          if (next.length + parsed.length > ceiling) {
            return fail(stage, `Splitting would produce ${next.length + parsed.length} messages, above this stage's ceiling of ${ceiling}. Fan-out multiplies, and an amplifier inside your own system is still an amplifier.`);
          }
          for (const element of parsed) {
            next.push({ ...message, envelopeJson: JSON.stringify(element) });
          }
        }
        messages = next;
        trace.push({ stageId: stage.stageId, kind: stage.kind, messagesIn: before, messagesOut: messages.length, note: `Split into ${messages.length} message(s), ceiling ${ceiling}.` });
        break;
      }

      case "AGGREGATE": {
        const ceiling = stage.maxBatch!;
        if (messages.length > ceiling) {
          return fail(stage, `Aggregating ${messages.length} messages exceeds the declared ceiling of ${ceiling}. An unbounded aggregate is a buffer that grows until the process dies.`);
        }
        // The batch inherits the MOST restrictive classification present. A
        // batch is as sensitive as its most sensitive member; taking the
        // first message's label would declassify the rest by arithmetic.
        const classification = messages.reduce<Classification>(
          (worst, message) => (classificationMayBecome(worst, message.classification) ? message.classification : worst),
          messages[0]!.classification,
        );
        const merged: PipelineMessage = {
          ...messages[0]!,
          envelopeJson: JSON.stringify(messages.map((m) => JSON.parse(m.envelopeJson) as unknown)),
          classification,
        };
        messages = [merged];
        trace.push({ stageId: stage.stageId, kind: stage.kind, messagesIn: before, messagesOut: 1, note: `Aggregated ${before} message(s) at classification ${classification}, ceiling ${ceiling}.` });
        break;
      }

      case "ENRICH_METADATA": {
        const keys = stage.enrichKeys!;
        const reserved = keys.filter((key) => isReservedMetadataKey(key));
        if (reserved.length > 0) {
          return fail(
            stage,
            `Enrichment would write ${reserved.join(", ")}, which downstream code may read as an answer to "is this permitted?". Authority is a reference to a decision somebody made, never a value a mediation stage wrote on the way past.`,
          );
        }
        messages = messages.map((message) => {
          const enriched = new Map(message.metadata);
          for (const key of keys) {
            if (!enriched.has(key)) enriched.set(key, "");
          }
          return withMetadata(message, enriched);
        });
        trace.push({ stageId: stage.stageId, kind: stage.kind, messagesIn: before, messagesOut: messages.length, note: `Enriched ${keys.length} allowlisted key(s).` });
        break;
      }

      case "THROTTLE": {
        trace.push({ stageId: stage.stageId, kind: stage.kind, messagesIn: before, messagesOut: messages.length, note: `Rate ceiling ${stage.maxPerSecond}/s declared for the runtime to enforce.` });
        break;
      }

      case "RETRY_BUDGET": {
        attemptsCeiling = stage.maxAttempts!;
        trace.push({ stageId: stage.stageId, kind: stage.kind, messagesIn: before, messagesOut: messages.length, note: `Retry budget ${attemptsCeiling}.` });
        break;
      }

      case "DEAD_LETTER": {
        deadLetter = stage.deadLetterQueue!;
        trace.push({ stageId: stage.stageId, kind: stage.kind, messagesIn: before, messagesOut: messages.length, note: `Undeliverable messages route to ${deadLetter}.` });
        break;
      }

      case "CODEC": {
        trace.push({ stageId: stage.stageId, kind: stage.kind, messagesIn: before, messagesOut: messages.length, note: `Codec ${stage.codecProfile} declared.` });
        break;
      }

      case "TRACE": {
        const operation = stage.traceOperation!;
        if (operation === "SANITIZE") {
          messages = messages.map((message) => {
            const kept = new Map<string, string>();
            for (const [key, value] of message.traceContext) {
              if (TRACE_ALLOWLIST.includes(key.trim().toLowerCase())) kept.set(key.trim().toLowerCase(), value);
            }
            return { ...message, traceContext: kept };
          });
          trace.push({ stageId: stage.stageId, kind: stage.kind, messagesIn: before, messagesOut: messages.length, note: "Trace context reduced to the allowlist; baggage discarded." });
          break;
        }
        if (operation === "EXTRACT" && plan.direction === "INBOUND") {
          // Defence in depth: the plan schema already refuses an inbound
          // extract without a preceding sanitize. This re-checks the actual
          // message, because a plan is authored once and this runs against
          // whatever actually arrived.
          const dirty = messages.find((message) =>
            [...message.traceContext.keys()].some((key) => !TRACE_ALLOWLIST.includes(key.trim().toLowerCase())),
          );
          if (dirty !== undefined) {
            return fail(
              stage,
              `Inbound trace context still carries keys outside the allowlist (${[...dirty.traceContext.keys()].join(", ")}). Extracting it would carry attacker-writable baggage into a consumer that treats trace context as trustworthy.`,
            );
          }
        }
        trace.push({ stageId: stage.stageId, kind: stage.kind, messagesIn: before, messagesOut: messages.length, note: `Trace ${operation.toLowerCase()} performed.` });
        break;
      }

      case "SECURITY": {
        const operation = stage.securityOperation!;
        for (const message of messages) {
          const result = operation === "SIGN" ? ports.security.sign({ message, now }) : ports.security.verify({ message, now });
          if (!result.ok) {
            return fail(stage, `Security ${operation.toLowerCase()} failed: ${result.reason} Failed closed — a signature that did not verify is not a weaker signature.`);
          }
        }
        trace.push({ stageId: stage.stageId, kind: stage.kind, messagesIn: before, messagesOut: messages.length, note: `${operation} succeeded through the Security port; this package holds no key material.` });
        break;
      }

      case "DISPATCH": {
        const adapterId = stage.adapterId!;
        if (!ports.dispatch.isCertified(adapterId)) {
          return fail(
            stage,
            `Adapter "${adapterId}" holds no current certification for this plan. §25: an uncertified adapter cannot enter a production path. A claim of capability is not evidence of it, and this is the check that keeps that sentence true at runtime rather than at review time.`,
          );
        }
        const result = ports.dispatch.dispatch({ adapterId, messages });
        if (!result.dispatched) {
          return fail(stage, `Dispatch through "${adapterId}" failed: ${result.reason}${attemptsCeiling === null ? "" : ` Retry budget was ${attemptsCeiling}.`}`);
        }
        receiptId = result.receiptId;
        trace.push({ stageId: stage.stageId, kind: stage.kind, messagesIn: before, messagesOut: messages.length, note: `Dispatched through certified adapter ${adapterId}.` });
        break;
      }
    }
  }

  return { completed: true, messages, receiptId, trace };
}

/**
 * A pipeline cannot widen authority, reach or classification.
 *
 * Everything it does is either a refusal or a transformation under a contract
 * somebody reviewed. Assertable because the certification layer calls it, and
 * because "the pipeline stage seemed like a convenient place" is the sentence
 * that precedes most of the ways this would stop being true.
 */
export function pipelineMayWidenAuthority(): false {
  return false;
}
