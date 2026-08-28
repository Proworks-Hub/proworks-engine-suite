// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { IntelligenceError } from "@proworks-hub/intelligence-core";

import type { ProviderAdapter, ProviderCall, ProviderResult } from "./runtime.js";

// ─────────────────────────────────────────────────────────────────────────────
// Provider adapters.
//
// A vendor adapter is the ONLY place a provider SDK and its credentials appear.
// Everything above it — routing, retry, fallback, validation, cost — is
// vendor-neutral, so adding a provider is writing one file that implements one
// method, not threading a new option through the runtime.
//
// No real provider is implemented here yet, deliberately. An adapter that
// cannot be run against the real API is an adapter nobody has verified, and
// shipping unverified vendor code that only executes in production is worse
// than shipping none — the first time it runs is the first time anyone finds
// out it was wrong.
//
// So this file provides the SEAM and two adapters that can be verified without
// a key:
//
//   `createStubAdapter` — deterministic canned answers. Makes the whole runtime
//   exercisable, and is honest about being a stub: it says so in its results.
//
//   `createUnconfiguredAdapter` — registered for a provider whose credentials
//   are absent. It fails with a clear reason rather than being silently missing,
//   which is the difference between "the model is not set up" and a confusing
//   no_route error three layers away.
//
// Writing a real adapter: implement `call`, translate the request, return the
// raw text and the token counts the provider reports. Do not retry, route,
// validate or price — the runtime owns those, and five adapters doing them five
// ways is how behaviour becomes provider-dependent.
// ─────────────────────────────────────────────────────────────────────────────

export interface StubResponder {
  /** Decides the answer from the request. Deterministic — no randomness. */
  (call: ProviderCall): string | Record<string, unknown>;
}

export interface StubAdapterOptions {
  provider?: string;
  respond: StubResponder;
  /** Token counts to report. Fixed, because a stub has no real usage. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Milliseconds to wait, for exercising timeout behaviour. */
  latencyMs?: number;
}

/**
 * An adapter that answers from a function instead of a provider.
 *
 * For the Validation Lab, for tests, and for running the console before any
 * credentials exist. It is not a fallback for production: a registry that
 * routes real work here would return canned answers to customers, so a host
 * should register it under a provider name that is obviously not a vendor.
 */
export function createStubAdapter(options: StubAdapterOptions): ProviderAdapter {
  return {
    provider: options.provider ?? "stub",
    async call(call: ProviderCall): Promise<ProviderResult> {
      if (options.latencyMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.latencyMs);
          call.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
      }

      return {
        raw: options.respond(call),
        usage: options.usage ?? { inputTokens: 0, outputTokens: 0 },
        // Marked in the version string so a stubbed answer is identifiable
        // anywhere it surfaces — a trace, an eval result, the Intelligence
        // page. An answer nobody can tell apart from a real one is the whole
        // danger of having a stub at all.
        modelVersion: "stub",
      };
    },
  };
}

/**
 * Stands in for a provider whose credentials are not configured.
 *
 * Registered so the model registry can list the provider and the console can
 * show it as unconfigured, rather than the provider simply not existing and
 * every request failing with `no_route` — which reads as a routing bug rather
 * than a missing key.
 */
export function createUnconfiguredAdapter(provider: string, reason?: string): ProviderAdapter {
  return {
    provider,
    call() {
      return Promise.reject(
        new IntelligenceError(
          "no_route",
          reason ??
            `The ${provider} adapter has no credentials configured, so it cannot serve requests.`,
          { provider },
        ),
      );
    },
  };
}

/**
 * What a host has actually wired up.
 *
 * Reported to the console so the Intelligence page can distinguish three states
 * that look identical from a failed request: a provider that is working, one
 * that is registered but unconfigured, and one that was never registered at
 * all.
 */
export interface ProviderStatus {
  readonly provider: string;
  readonly configured: boolean;
  /** True when answers come from a stub rather than a vendor. */
  readonly stubbed: boolean;
  readonly detail: string;
}

export function describeAdapters(adapters: readonly ProviderAdapter[]): ProviderStatus[] {
  return adapters.map((adapter) => {
    const stubbed = adapter.provider === "stub" || adapter.provider.startsWith("stub-");
    // Identified structurally rather than by a flag an adapter sets about
    // itself: a real adapter that forgot the flag would claim to be configured.
    const unconfigured = adapter.call.length === 0 && !stubbed;

    return {
      provider: adapter.provider,
      configured: !unconfigured && !stubbed,
      stubbed,
      detail: stubbed
        ? "Answers are canned. Nothing here reached a model."
        : unconfigured
          ? "Registered but has no credentials. Requests to it will be refused with a stated reason."
          : "Configured.",
    };
  });
}
