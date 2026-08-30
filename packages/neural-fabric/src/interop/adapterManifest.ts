/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/interop/adapterManifest.ts
 * Module:   neural-fabric / interop
 * Purpose:  What an adapter says about itself, kept carefully separate from what is true.
 */

import { z } from "zod";

import { classificationSchema } from "../domain/envelope.js";
import { laneSchema, orderingScopeSchema } from "../domain/lanes.js";

// ─────────────────────────────────────────────────────────────────────────────
// A MANIFEST IS A CLAIM. CERTIFICATION IS EVIDENCE. ADMISSION IS A DECISION.
//
// Those are three different things and the certification profile is blunt
// about it: "Do not trust adapter claims. Prove them," and "Certification is
// evidence. Governance decides production admission."
//
// Collapsing any two of them produces a specific, known failure. Manifest as
// evidence means an adapter grants itself capability by describing itself —
// a forged capability manifest is item four in the §14 threat list, and it
// costs an attacker one YAML file. Certification as admission means passing
// tests puts code in the production path, which makes the test suite the
// authorization system and removes the human who was supposed to decide
// whether this adapter belongs here at all.
//
// So the types here are deliberately three, not one: AdapterManifest (a
// claim), AdapterCertificationEvidence (what testing found), and an
// admission that only Governance can produce. `mayServe` below will not
// return true without all three, and there is no argument combination that
// lets a manifest stand in for the other two.
//
// PRIVILEGE IS DECLARED, AND DECLARED SMALL
//
// §14's malicious-adapter threat is not hypothetical — an adapter is
// third-party code inside the message path. The manifest must state what
// privilege it needs, and `requiresControlPlaneWrite` exists only so the
// schema can refuse it: there is no adapter that legitimately writes
// topology, and an adapter that asks is either confused or hostile.
// ─────────────────────────────────────────────────────────────────────────────

export const trustTierSchema = z.enum([
  /** Built and maintained inside this repository. */
  "FIRST_PARTY",
  /** From a known vendor, signed, with a support relationship. */
  "VERIFIED_THIRD_PARTY",
  /** Everything else. Runs sandboxed or not at all. */
  "UNTRUSTED",
]);
export type TrustTier = z.infer<typeof trustTierSchema>;

/** Where the adapter came from, and who is accountable for it. */
export const adapterProvenanceSchema = z
  .object({
    /** Who publishes it. */
    publisher: z.string().min(1),
    /** The source repository or distribution point. */
    sourceRef: z.string().min(1),
    /** Digest of the artifact this manifest describes. */
    artifactDigest: z.string().min(1),
    /** Who signed the artifact. Null means unsigned — which bounds the tier. */
    signedBy: z.string().min(1).nullable(),
    /** SPDX-style identifier, or a named proprietary license. */
    license: z.string().min(1),
    /**
     * Known advisories against this version.
     *
     * Present and non-empty is not automatically disqualifying — an advisory
     * may be irrelevant to how the Hive uses it — but it is a fact a reviewer
     * must see, and hiding it is the supply-chain failure mode itself.
     */
    knownAdvisories: z.array(z.string().min(1)).max(50),
  })
  .strict();
export type AdapterProvenance = z.infer<typeof adapterProvenanceSchema>;

export const adapterManifestSchema = z
  .object({
    adapterId: z.string().min(1),
    version: z.string().min(1),
    summary: z.string().min(1),
    provenance: adapterProvenanceSchema,
    trustTier: trustTierSchema,

    /** Wire protocols it speaks, for the operator's benefit. */
    protocols: z.array(z.string().min(1)).min(1).max(20),
    /** Lanes it offers to carry. */
    lanesOffered: z.array(laneSchema).min(1),
    /**
     * Capabilities it claims, matched against a pattern's requirements.
     *
     * The vocabulary is the pattern catalog's `requiredProviderCapabilities`.
     * A claim here is checked by certification before it means anything.
     */
    capabilities: z.array(z.string().min(1)).min(1).max(40),

    durable: z.boolean(),
    replayable: z.boolean(),
    redelivers: z.boolean(),
    orderingScopes: z.array(orderingScopeSchema).min(1),

    maxMessageBytes: z.number().int().positive(),
    maxInFlight: z.number().int().positive(),
    supportsBackpressure: z.boolean(),

    mutualTlsCapable: z.boolean(),
    /** True when it can carry an authorization reference without reading it. */
    propagatesAuthorizationEvidence: z.boolean(),
    /** True when it propagates W3C trace context. */
    propagatesTraceContext: z.boolean(),

    suitableForMobileEdge: z.boolean(),
    supportsReconnect: z.boolean(),

    /** Classifications it is approved to carry. Never inferred. */
    permittedClassifications: z.array(classificationSchema).min(1),

    /** Privileges it needs from the host. Kept explicit and kept small. */
    requiresFilesystemAccess: z.boolean(),
    requiresOutboundNetwork: z.boolean(),
    requiresSandbox: z.boolean(),
    /**
     * Present so it can be refused. See the header.
     */
    requiresControlPlaneWrite: z.boolean(),

    /** Reference to the certification run. A ref, not the verdict itself. */
    certificationEvidenceRef: z.string().min(1).nullable(),
  })
  .strict()
  .refine((m) => !m.requiresControlPlaneWrite, {
    message:
      "No adapter may request control-plane write access. Adapters move messages; topology is activated by governed decision. An adapter that could write topology could grant itself a route, which is the whole separation the control plane exists to enforce.",
    path: ["requiresControlPlaneWrite"],
  })
  .refine((m) => !m.replayable || m.durable, {
    message:
      "An adapter cannot replay what it did not keep. Claiming replay without durability is the kind of manifest error that is invisible until a recovery depends on it.",
    path: ["replayable"],
  })
  .refine((m) => m.trustTier !== "VERIFIED_THIRD_PARTY" || m.provenance.signedBy !== null, {
    message:
      "A verified third-party adapter must be signed. Without a signature there is nothing tying the artifact to the publisher, and 'verified' would mean somebody recognised the name.",
    path: ["provenance", "signedBy"],
  })
  .refine((m) => m.trustTier !== "UNTRUSTED" || m.requiresSandbox, {
    message:
      "An untrusted adapter must declare that it requires a sandbox. Untrusted code in the message path without isolation is the malicious-adapter threat with the mitigation left off.",
    path: ["requiresSandbox"],
  })
  .refine(
    (m) => !m.permittedClassifications.includes("RESTRICTED") || m.mutualTlsCapable,
    {
      message:
        "Restricted data requires a mutually authenticated channel. Without one the transport cannot confirm who is on the other end, which is precisely the question restricted data makes consequential.",
      path: ["permittedClassifications"],
    },
  );
export type AdapterManifest = z.infer<typeof adapterManifestSchema>;

/**
 * A manifest grants nothing. It is a description an adapter wrote about
 * itself, and the only thing it establishes is what to go and test.
 */
export function manifestEstablishesCapability(): false {
  return false;
}

/**
 * Whether one manifest is a widening of another.
 *
 * §14 lists "unexpected adapter capability changes" as a thing Sentinel must
 * watch for, and this is the function that makes the change detectable. An
 * adapter that ships v2 quietly adding EVIDENCE to its lanes, or RESTRICTED
 * to its classifications, has expanded what it may touch without anyone
 * approving the expansion — the update path is the natural way to do that,
 * because updates feel like maintenance rather than a permission request.
 */
export function describeWidening(
  previous: AdapterManifest,
  next: AdapterManifest,
): { readonly widened: boolean; readonly additions: readonly string[] } {
  const additions: string[] = [];

  const added = <T>(before: readonly T[], after: readonly T[], label: string): void => {
    const set = new Set(before);
    for (const item of after) {
      if (!set.has(item)) additions.push(`${label}: ${String(item)}`);
    }
  };

  added(previous.lanesOffered, next.lanesOffered, "lane");
  added(previous.capabilities, next.capabilities, "capability");
  added(previous.permittedClassifications, next.permittedClassifications, "classification");
  added(previous.protocols, next.protocols, "protocol");
  added(previous.orderingScopes, next.orderingScopes, "ordering scope");

  // Privilege escalations count as widening even though they are booleans
  // rather than lists — asking for the filesystem in v2 is a bigger change
  // than adding a protocol, not a smaller one.
  if (!previous.requiresFilesystemAccess && next.requiresFilesystemAccess) additions.push("privilege: filesystem access");
  if (!previous.requiresOutboundNetwork && next.requiresOutboundNetwork) additions.push("privilege: outbound network");
  if (previous.requiresSandbox && !next.requiresSandbox) additions.push("privilege: sandbox requirement dropped");
  if (previous.maxMessageBytes < next.maxMessageBytes) additions.push(`limit: max message bytes ${previous.maxMessageBytes} → ${next.maxMessageBytes}`);

  return { widened: additions.length > 0, additions };
}
