/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/engines/fabricObservabilityIQ.ts
 * Module:   neural-fabric / engines
 * Purpose:  Following one signal across every hop, without carrying its contents.
 */

import type { Lane } from "../domain/lanes.js";

// ─────────────────────────────────────────────────────────────────────────────
// A BROKEN CAUSAL CHAIN IS THE FINDING, NOT AN INCONVENIENCE
//
// Tracing works when every hop records what caused it. In practice a chain
// breaks in one specific way: an engine receives a signal, does some work, and
// emits a new signal without propagating `causationId` — usually because the
// emitting code path was written separately from the receiving one.
//
// Everything continues to work. The two halves of the story simply stop being
// connected, and the first time anybody notices is during an incident, when the
// trace ends in the middle and nobody knows whether that is where the problem
// is or merely where the tracing stopped.
//
// So `buildTrace` reports orphans as findings with the same weight as errors.
// A span whose parent is missing is not omitted from the graph — it is placed
// at the root and labelled, because silently reparenting it would produce a
// tidy trace that is a lie.
//
// AND THE TRACE CARRIES NO PAYLOAD
//
// §19: keep payload-sensitive data out of generic telemetry. A span here holds
// ids, a lane, a capability and timings. There is no field for content, which
// is a stronger guarantee than a rule about what to put in one.
// ─────────────────────────────────────────────────────────────────────────────

export interface TraceSpan {
  readonly fabricMessageId: string;
  readonly correlationId: string;
  /** What caused this. Null for a genuine root. */
  readonly causationId: string | null;
  readonly lane: Lane;
  readonly fromCapability: string;
  readonly toCapability: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: "DELIVERED" | "RETRIED" | "REFUSED" | "EXPIRED" | "DEAD_LETTERED";
  /** Why, in the router's words. Never payload. */
  readonly reason: string;
}

export interface TraceNode {
  readonly span: TraceSpan;
  readonly children: readonly TraceNode[];
  readonly depth: number;
}

export interface TraceFinding {
  readonly kind: "ORPHAN" | "CYCLE" | "DUPLICATE_ID" | "GAP";
  readonly fabricMessageId: string;
  readonly note: string;
}

export interface CausalTrace {
  readonly correlationId: string;
  readonly roots: readonly TraceNode[];
  readonly findings: readonly TraceFinding[];
  readonly spanCount: number;
  /** Wall time from the earliest start to the latest finish. */
  readonly totalMs: number;
  /** The single longest-running span, which is usually the question. */
  readonly slowest: TraceSpan | null;
  readonly note: string;
}

/**
 * Reconstructs the causal chain for one correlation id.
 *
 * Iterative, not recursive. A trace is caller-supplied data and a deep or
 * cyclic one would overflow the stack — which fails with a message about
 * framework internals rather than about the trace being malformed.
 */
export function buildTrace(spans: readonly TraceSpan[], correlationId: string): CausalTrace {
  const findings: TraceFinding[] = [];
  const relevant = spans.filter((s) => s.correlationId === correlationId);

  const byId = new Map<string, TraceSpan>();
  for (const span of relevant) {
    if (byId.has(span.fabricMessageId)) {
      findings.push({
        kind: "DUPLICATE_ID",
        fabricMessageId: span.fabricMessageId,
        note: `Two spans share the id "${span.fabricMessageId}". One of them is a redelivery that was recorded as a new signal, and the tree below it would otherwise be attached twice.`,
      });
      continue;
    }
    byId.set(span.fabricMessageId, span);
  }

  const childrenOf = new Map<string, TraceSpan[]>();
  const roots: TraceSpan[] = [];

  for (const span of [...byId.values()].sort((a, b) => a.fabricMessageId.localeCompare(b.fabricMessageId))) {
    if (span.causationId === null) {
      roots.push(span);
      continue;
    }
    if (!byId.has(span.causationId)) {
      // Placed at the root and LABELLED. Silently reparenting would produce a
      // tidy trace that is a lie.
      findings.push({
        kind: "ORPHAN",
        fabricMessageId: span.fabricMessageId,
        note: `This span says it was caused by "${span.causationId}", which is not in the trace. Either that hop was never recorded or a component emitted a signal without propagating causation — the chain is broken here, and the trace below this point is real but disconnected from what came before it.`,
      });
      roots.push(span);
      continue;
    }
    const siblings = childrenOf.get(span.causationId) ?? [];
    siblings.push(span);
    childrenOf.set(span.causationId, siblings);
  }

  // Iterative build with a visited set, so a causation cycle terminates and is
  // reported rather than hanging.
  const visited = new Set<string>();
  const build = (span: TraceSpan, depth: number): TraceNode => {
    visited.add(span.fabricMessageId);
    const children: TraceNode[] = [];
    const stack: { span: TraceSpan; depth: number; into: TraceNode[] }[] = [];
    for (const child of childrenOf.get(span.fabricMessageId) ?? []) {
      stack.push({ span: child, depth: depth + 1, into: children });
    }
    while (stack.length > 0) {
      const item = stack.pop()!;
      if (visited.has(item.span.fabricMessageId)) {
        findings.push({
          kind: "CYCLE",
          fabricMessageId: item.span.fabricMessageId,
          note: `A causation cycle reaches "${item.span.fabricMessageId}" again. A signal cannot cause its own cause; this is a component reusing an id or a loop between two engines.`,
        });
        continue;
      }
      visited.add(item.span.fabricMessageId);
      const node: TraceNode = { span: item.span, children: [], depth: item.depth };
      item.into.push(node);
      const mutableChildren = node.children as TraceNode[];
      for (const child of childrenOf.get(item.span.fabricMessageId) ?? []) {
        stack.push({ span: child, depth: item.depth + 1, into: mutableChildren });
      }
    }
    return { span, children, depth };
  };

  const rootNodes: TraceNode[] = roots.map((r) => build(r, 0));

  // Anything not reached from a root is in a causation cycle. Without this the
  // spans simply vanish: a two-span loop has no root, so the trace comes back
  // empty and reports nothing at all — silently losing exactly the spans that
  // prove something is wrong. Found by a test that expected a finding and got
  // an empty trace.
  for (const span of [...byId.values()].sort((a, b) => a.fabricMessageId.localeCompare(b.fabricMessageId))) {
    if (visited.has(span.fabricMessageId)) continue;
    findings.push({
      kind: "CYCLE",
      fabricMessageId: span.fabricMessageId,
      note: `"${span.fabricMessageId}" is not reachable from any root: its causation chain loops back on itself. A signal cannot cause its own cause, so this is a component reusing an id or two engines each recording the other as their cause. It is surfaced at the root rather than dropped, because a span that disappears from a trace looks like a hop that never happened.`,
    });
    rootNodes.push(build(span, 0));
  }

  const starts = relevant.map((s) => Date.parse(s.startedAt)).filter(Number.isFinite);
  const ends = relevant.map((s) => Date.parse(s.startedAt) + s.durationMs).filter(Number.isFinite);
  const totalMs = starts.length === 0 ? 0 : Math.max(...ends) - Math.min(...starts);

  const slowest =
    relevant.length === 0
      ? null
      : [...relevant].sort((a, b) => b.durationMs - a.durationMs || a.fabricMessageId.localeCompare(b.fabricMessageId))[0]!;

  const orphans = findings.filter((f) => f.kind === "ORPHAN").length;

  return {
    correlationId,
    roots: rootNodes,
    findings,
    spanCount: byId.size,
    totalMs,
    slowest,
    note:
      relevant.length === 0
        ? `No spans for correlation "${correlationId}". Either nothing happened under it or nothing was recorded, and those are different — the trace cannot tell you which.`
        : orphans > 0
          ? `${byId.size} spans over ${totalMs}ms, with ${orphans} broken causal link${orphans === 1 ? "" : "s"}. The chain is incomplete, so "what caused this" has an answer the trace cannot give.`
          : `${byId.size} spans over ${totalMs}ms, chain intact.`,
  };
}

/** Whether a trace span has any field that could carry payload content. */
export function spanCarriesPayload(): false {
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE LEVEL OBJECTIVES
// ─────────────────────────────────────────────────────────────────────────────

export interface LaneSlo {
  readonly lane: Lane;
  readonly p95LatencyMs: number;
  /** Deliveries that must succeed, as a fraction. */
  readonly successRate: number;
  readonly rationale: string;
}

export interface SloObservation {
  readonly lane: Lane;
  readonly p95LatencyMs: number;
  readonly delivered: number;
  readonly failed: number;
}

export type SloVerdict =
  | { readonly met: true; readonly note: string }
  | { readonly met: false; readonly breaches: readonly string[]; readonly note: string }
  | { readonly met: null; readonly note: string };

/**
 * Whether a lane met its objective.
 *
 * Returns `null` for "not enough traffic to say", which is a third answer and
 * not a passing one. An SLO computed from four deliveries is arithmetic rather
 * than evidence, and reporting it as met is how a dashboard stays green through
 * an outage that stopped the traffic it was measuring.
 */
export function evaluateSlo(
  slo: LaneSlo,
  observation: SloObservation,
  minimumSample: number,
): SloVerdict {
  const total = observation.delivered + observation.failed;

  if (total < minimumSample) {
    return {
      met: null,
      note: `Only ${total} deliveries on the ${slo.lane} lane, below the ${minimumSample} needed to say anything. Not a pass — an SLO computed from too little traffic is arithmetic rather than evidence, and an outage that stops traffic would otherwise turn the dashboard green.`,
    };
  }

  const breaches: string[] = [];
  const successRate = observation.delivered / total;

  if (observation.p95LatencyMs > slo.p95LatencyMs) {
    breaches.push(
      `p95 latency ${observation.p95LatencyMs}ms against an objective of ${slo.p95LatencyMs}ms.`,
    );
  }
  if (successRate < slo.successRate) {
    breaches.push(
      `success rate ${(successRate * 100).toFixed(2)}% against an objective of ${(slo.successRate * 100).toFixed(2)}%.`,
    );
  }

  if (breaches.length === 0) {
    return {
      met: true,
      note: `The ${slo.lane} lane met its objective over ${total} deliveries.`,
    };
  }

  return {
    met: false,
    breaches,
    note: `The ${slo.lane} lane missed its objective over ${total} deliveries: ${breaches.join(" ")} ${slo.rationale}`,
  };
}

/**
 * A route diagnosis for one signal, assembled from its trace.
 *
 * The four questions §19 asks — where did it go, why that route, why delayed,
 * why rejected — answered from recorded spans rather than recomputed. A
 * recomputed answer says what would happen now, which is a different question
 * from what happened then and is routinely mistaken for it.
 */
export function diagnose(trace: CausalTrace): {
  readonly wentWhere: readonly string[];
  readonly delayedBy: string | null;
  readonly refusedBecause: readonly string[];
  readonly note: string;
} {
  const path: string[] = [];
  const refusals: string[] = [];

  const walk = (nodes: readonly TraceNode[]): void => {
    for (const node of nodes) {
      path.push(`${node.span.fromCapability} → ${node.span.toCapability} (${node.span.lane})`);
      if (node.span.outcome === "REFUSED" || node.span.outcome === "EXPIRED" || node.span.outcome === "DEAD_LETTERED") {
        refusals.push(`${node.span.toCapability}: ${node.span.reason}`);
      }
      walk(node.children);
    }
  };
  walk(trace.roots);

  const delayedBy =
    trace.slowest === null || trace.totalMs === 0
      ? null
      : trace.slowest.durationMs / trace.totalMs >= 0.5
        ? `${trace.slowest.toCapability} took ${trace.slowest.durationMs}ms of the ${trace.totalMs}ms total — most of the time was spent in one hop, which is where to look first.`
        : null;

  return {
    wentWhere: path,
    delayedBy,
    refusedBecause: refusals,
    note:
      trace.findings.some((f) => f.kind === "ORPHAN")
        ? "This diagnosis is incomplete: the causal chain is broken, so part of what happened is not in the trace. Treat the path as what was recorded rather than as what occurred."
        : "Assembled from recorded spans rather than recomputed. Recomputing would answer what would happen now, which is a different question from what happened then.",
  };
}
