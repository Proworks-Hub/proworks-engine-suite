// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { Confidence, Severity } from "../finding.js";

// ─────────────────────────────────────────────────────────────────────────────
// Sentinel V2 Shield chamber modules — the Shield specialist candidates as
// MODULES (DEC-027 point 2): Threat (ATT&CK-mapped detection findings),
// AIThreatDefense + AgentAssurance (§21.4 AI defense model), Deception
// boundary.
//
// §21.4, the sentence the AI-defense module is arranged around: "No AI
// receives authority because it is intelligent, internal, accurate, trusted
// historically or connected to ARIA." Every AI-originated recommendation is
// a CANDIDATE that deterministic policy verifies before action; indirect
// prompt injection is countered structurally — untrusted content is separated
// from control metadata, and nothing in untrusted content can change
// security metadata or authorization state.
// ─────────────────────────────────────────────────────────────────────────────

// ── Threat module — ATT&CK-vocabulary detection findings ────────────────────

export const threatFindingSchema = z
  .object({
    findingRef: z.string().min(1),
    /** ATT&CK technique id (e.g. T1078) — the common adversary vocabulary the
     * detection surface is structured around. */
    attackTechniqueId: z.string().regex(/^T\d{4}(\.\d{3})?$/),
    tactic: z.string().min(1),
    severity: z.custom<Severity>((v) => typeof v === "string"),
    confidence: z.custom<Confidence>((v) => typeof v === "string"),
    evidenceRefs: z.array(z.string().min(1)).min(1),
    /** A detection is evidence toward containment REQUESTS; it is never
     * itself an authorization. */
    authority: z.literal("none"),
  })
  .strict();
export type ThreatFinding = z.infer<typeof threatFindingSchema>;

export function threatFinding(input: Omit<ThreatFinding, "authority">): ThreatFinding | null {
  const parsed = threatFindingSchema.safeParse({ ...input, authority: "none" });
  return parsed.success ? parsed.data : null;
}

/** Evidence fusion: correlate findings sharing a subject into a sequence
 * candidate. Correlation RAISES the review priority; it never raises
 * authority, and confidence never exceeds its weakest member's ceiling
 * without independent Guard verification. */
export function fuseFindings(
  findings: readonly { finding: ThreatFinding; subjectRef: string }[],
): readonly { subjectRef: string; techniqueIds: readonly string[]; fusedConfidence: Confidence }[] {
  const bySubject = new Map<string, ThreatFinding[]>();
  for (const f of findings) {
    const list = bySubject.get(f.subjectRef) ?? [];
    list.push(f.finding);
    bySubject.set(f.subjectRef, list);
  }
  const rank: Record<Confidence, number> = { suspected: 0, probable: 1, confirmed: 2 };
  return [...bySubject.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([subjectRef, list]) => {
      const weakest = list.reduce<Confidence>((acc, f) => (rank[f.confidence] < rank[acc] ? f.confidence : acc), "confirmed");
      return {
        subjectRef,
        techniqueIds: [...new Set(list.map((f) => f.attackTechniqueId))].sort(),
        // Multiple independent detections lift suspected -> probable, never
        // beyond: "confirmed" requires Guard-side verification, not volume.
        fusedConfidence: weakest === "suspected" ? "probable" : weakest,
      };
    })
    .sort((a, b) => (a.subjectRef < b.subjectRef ? -1 : 1));
}

// ── AI defense — §21.4 ──────────────────────────────────────────────────────

/** Every AI workload — ARIA, internal agents, external providers, outside
 * bots — is untrusted by default with explicit identity and capabilities. */
export interface AiWorkloadProfile {
  readonly workloadRef: string;
  readonly identityRef: string | null;
  readonly declaredCapabilities: readonly string[];
  readonly sandboxed: boolean;
}

export type AiCapabilityVerdict =
  | { readonly permitted: true }
  | { readonly permitted: false; readonly reason: string };

/** Capability check: identity required, capability must be DECLARED, and no
 * property of the workload (internal, historically accurate, ARIA-connected)
 * substitutes for either. There is no trust-score input to this function —
 * deliberately. */
export function checkAiCapability(profile: AiWorkloadProfile, requestedCapability: string): AiCapabilityVerdict {
  if (profile.identityRef === null) {
    return { permitted: false, reason: "AI workload has no explicit identity; untrusted by default." };
  }
  if (!profile.declaredCapabilities.includes(requestedCapability)) {
    return {
      permitted: false,
      reason: `Capability "${requestedCapability}" is not declared for ${profile.workloadRef}; intelligence, internality and history grant nothing.`,
    };
  }
  return { permitted: true };
}

/**
 * §21.4 / §21.12 gate: indirect prompt injection cannot change Sentinel
 * policy, security metadata or authorization state — implemented as a
 * structural separation. Control metadata is accepted ONLY from the control
 * channel; anything arriving in the content channel that addresses security
 * state is inert data and is flagged as an injection attempt.
 */
export interface SeparatedMessage {
  readonly controlMetadata: Readonly<Record<string, string>>; // from the authenticated control channel
  readonly untrustedContent: string; // model output, external text, user content
}

export interface InjectionScreenResult {
  readonly effectiveControlMetadata: Readonly<Record<string, string>>;
  readonly injectionAttemptDetected: boolean;
  readonly inertDirectives: readonly string[];
}

const SECURITY_DIRECTIVE_PATTERN =
  /\b(set|change|override|disable|elevate|grant)\b[^.\n]{0,60}\b(policy|authoriz|security[- ]condition|privilege|containment|quarantine|trust)\b/i;

export function screenForInjection(message: SeparatedMessage): InjectionScreenResult {
  const directives: string[] = [];
  for (const line of message.untrustedContent.split("\n")) {
    if (SECURITY_DIRECTIVE_PATTERN.test(line)) directives.push(line.trim());
  }
  return {
    // Untrusted content NEVER merges into control metadata — the effective
    // metadata is the control channel's, verbatim, regardless of content.
    effectiveControlMetadata: message.controlMetadata,
    injectionAttemptDetected: directives.length > 0,
    inertDirectives: directives,
  };
}

/** §21.4/§21.12: AI-originated security recommendations are CANDIDATES;
 * deterministic policy verifies them before action, and ARIA/Foundry output
 * cannot directly execute privileged response actions. */
export interface AiRecommendation {
  readonly recommendationRef: string;
  readonly proposedRung: string;
  readonly modelRef: string;
  readonly sourceStrength: "ai-candidate";
}

export type RecommendationVerdict =
  | { readonly executable: false; readonly state: "candidate"; readonly nextStep: "deterministic-policy-verification" }
  | { readonly executable: false; readonly state: "rejected"; readonly reason: string };

export function admitAiRecommendation(recommendation: AiRecommendation): RecommendationVerdict {
  if (recommendation.sourceStrength !== "ai-candidate") {
    return { executable: false, state: "rejected", reason: "AI output must be labelled ai-candidate." };
  }
  // No branch here can mark a recommendation runnable. An AI recommendation
  // enters the deterministic verification path or nothing.
  return { executable: false, state: "candidate", nextStep: "deterministic-policy-verification" };
}

// ── Agent assurance — behavior envelopes ────────────────────────────────────

export interface BehaviorEnvelope {
  readonly agentRef: string;
  readonly permittedTools: readonly string[];
  readonly maxDataScopeRef: string;
  readonly egress: "none" | "filtered" | "open";
}

export interface AgentObservation {
  readonly agentRef: string;
  readonly toolsUsed: readonly string[];
  readonly dataScopesTouched: readonly string[];
  readonly egressUsed: "none" | "filtered" | "open";
}

export type EnvelopeVerdict =
  | { readonly within: true }
  | { readonly within: false; readonly violations: readonly string[] };

export function checkBehaviorEnvelope(envelope: BehaviorEnvelope, observation: AgentObservation): EnvelopeVerdict {
  const violations: string[] = [];
  for (const tool of observation.toolsUsed) {
    if (!envelope.permittedTools.includes(tool)) violations.push(`tool "${tool}" outside the declared envelope`);
  }
  for (const scope of observation.dataScopesTouched) {
    if (scope !== envelope.maxDataScopeRef) violations.push(`data scope "${scope}" beyond ${envelope.maxDataScopeRef}`);
  }
  const egressRank = { none: 0, filtered: 1, open: 2 } as const;
  if (egressRank[observation.egressUsed] > egressRank[envelope.egress]) {
    violations.push(`egress "${observation.egressUsed}" exceeds permitted "${envelope.egress}"`);
  }
  return violations.length > 0 ? { within: false, violations } : { within: true };
}

// ── Deception boundary — §5 / §21.2 ─────────────────────────────────────────

export type DeceptionAssetVerdict =
  | { readonly deployable: true }
  | { readonly deployable: false; readonly reason: string };

/** A decoy must never expose real sensitive data and must never entrap a
 * legitimate operator: it detects, it does not bait authorized work. */
export function checkDeceptionAsset(asset: {
  readonly assetRef: string;
  readonly containsRealData: boolean;
  readonly reachableInNormalAuthorizedWorkflow: boolean;
}): DeceptionAssetVerdict {
  if (asset.containsRealData) {
    return { deployable: false, reason: "A decoy carrying real sensitive data is a leak with extra steps." };
  }
  if (asset.reachableInNormalAuthorizedWorkflow) {
    return { deployable: false, reason: "A decoy reachable in a normal authorized workflow entraps legitimate operators." };
  }
  return { deployable: true };
}
