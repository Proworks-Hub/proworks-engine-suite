// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { EngineManifest } from "../core/manifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constitutional components, described for the console.
//
// One today: Sentinel IQ. `layer: "constitutional"` is DERIVED from its
// `CONSTITUTIONAL_SENTINEL` classification, not chosen here — and `coreDomain`
// is null because a constitutional component sits outside the Core hierarchy
// rather than under one of the eight domains. The manifest schema refuses the
// other combination, so this cannot drift into claiming a hierarchy position
// Sentinel does not hold.
//
// Note what is NOT in this file. Governance Engine, ARIA and Foundry
// EvolutionIQ are also constitutionally classified and also want manifests —
// but they are not this session's engines, and authoring metadata for a
// component whose gaps and vocabulary belong to someone else is how a
// description drifts from its subject. They are left for their owners.
//
// Neural Fabric is a different case again and is deliberately absent: it has
// no ratified classification (`PROPOSED_COORDINATION_PLANE`, kept outside the
// enum on purpose), so it derives `plane` rather than anything in this file.
//
// NOT WIRED INTO `SUITE_MANIFESTS` — see the note in `finance.ts`. The console
// counts eight engines by a decision recorded in its own test; changing that
// count is the console session's call, not a side effect of authoring
// metadata here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sentinel IQ — the constitutional sentinel.
 *
 * `kind: "engine"` because it owns a domain (findings, threat classifications,
 * protective state) and is not a support service. That it is an engine says
 * nothing about its authority: Sentinel observes, verifies and requests, and
 * every containment in the model names security-iq, fabric or a host adapter
 * as executor — never itself.
 *
 * `eventMappings: []` for the reason every finance manifest carries it: the
 * V2 kernel and the DEC-028 operationalization publish nothing yet. Sentinel
 * has more reason than most to keep that honest — an invented edge on the
 * security console is a claim about how a threat signal travels.
 *
 * `capabilities: []` because Sentinel's surface is not registered in a shared
 * capability enum; it takes no Governance dependency by design (§8, §15), and
 * inventing entitlement names here would suggest a grant path that does not
 * exist.
 *
 * `metrics: []` because nothing is measured yet: no sensor is bound, so a
 * "threats detected" tile would read zero over an unbound feed — the precise
 * failure the observation plane's coverage model exists to prevent.
 */
export const sentinelIqManifest: EngineManifest = {
  manifestVersion: 2,
  id: "sentineliq",
  name: "Sentinel IQ",
  description:
    "Constitutional sentinel: Shield watches outward for threats, Guard verifies inward that the Hive behaves as authorized",
  kind: "engine",
  packageName: "@proworks-hub/sentineliq",
  colorToken: "engine-magenta",
  icon: "shield-guard",
  visualizationType: "sentinel-chambers",
  // Derived from CONSTITUTIONAL_SENTINEL. Outside the Core hierarchy, so no
  // Core is named — the schema refuses the alternative.
  layer: "constitutional",
  coreDomain: null,
  // Deprecated since v2; present because the parsed type requires it.
  hivePlacement: "ring",
  visualizationConfig: {},
  capabilities: [],
  metrics: [],
  // `overview` alone. A `diagnostics` panel would promise sensor health that
  // nothing reports, and an `events` tab would be permanently empty.
  supportedAdminPanels: ["overview"],
  eventMappings: [],
};

export const CONSTITUTIONAL_MANIFESTS: readonly EngineManifest[] = [sentinelIqManifest];
