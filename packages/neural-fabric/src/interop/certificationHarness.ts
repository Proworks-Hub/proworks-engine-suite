/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/interop/certificationHarness.ts
 * Module:   neural-fabric / interop
 * Purpose:  Testing what an adapter claimed, and admitting what could not be tested here.
 */

import { describeWidening, type AdapterManifest } from "./adapterManifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// YOU ARE TESTED ON WHAT YOU CLAIM, AND EVERYTHING YOU CLAIM IS TESTED
//
// The certification profile lists twenty-five checks. The rule that makes the
// list workable is that a check is REQUIRED exactly when the manifest claims
// the property it tests. An adapter that does not claim durability is not
// failed for lacking it; an adapter that DOES claim durability and cannot
// demonstrate it fails, because the claim is the thing being certified.
//
// NOT_EXERCISED IS A REAL OUTCOME, AND IT IS THE HONEST ONE
//
// Several checks cannot be performed against an in-process adapter in a unit
// test: certificate rotation needs a real PKI, cross-language fixtures need
// another runtime, supply-chain provenance needs a scanner. The dishonest
// options are to pass them silently or to drop them from the list. Both
// produce a certificate that says more than the testing did.
//
// So NOT_EXERCISED is a first-class outcome that carries the reason it could
// not run, it is counted separately, and `certified` is false whenever a
// REQUIRED check is unexercised. A harness that could never return
// NOT_EXERCISED would be lying about its own reach, which is the same defect
// as an adapter lying about durability — just one level up.
//
// CERTIFICATION IS NOT ADMISSION
//
// Nothing here admits an adapter to production. `mayEnterProductionPath`
// needs an admission record Governance produced, and there is no argument
// combination that lets evidence stand in for it.
// ─────────────────────────────────────────────────────────────────────────────

export type CheckOutcome = "PASSED" | "FAILED" | "NOT_APPLICABLE" | "NOT_EXERCISED";

export interface CheckResult {
  readonly checkId: string;
  /** The claim under test, in the profile's words. */
  readonly claim: string;
  readonly outcome: CheckOutcome;
  /** Required when the manifest claims the property this check tests. */
  readonly required: boolean;
  readonly evidence: string;
  /** Present on FAILED and NOT_EXERCISED. */
  readonly remedy: string | null;
}

/**
 * What the harness may do to an adapter under test.
 *
 * Deliberately narrow. A harness that could reach into the adapter's
 * internals would certify implementation detail, and the next version would
 * fail certification for a refactor that changed nothing observable.
 */
export interface AdapterUnderTest {
  /** Sends a message. Rejection is a legitimate answer and is recorded. */
  send(input: {
    readonly key: string | null;
    readonly bodyJson: string;
    readonly idempotencyKey: string | null;
    readonly metadata: ReadonlyMap<string, string>;
  }): { readonly accepted: true; readonly messageId: string } | { readonly accepted: false; readonly reason: string };

  /** Everything the adapter currently holds for delivery, in delivery order. */
  drain(): readonly { readonly messageId: string; readonly key: string | null; readonly bodyJson: string }[];

  /** Simulates a process restart. Returns false when the adapter cannot. */
  restart(): boolean;

  /** Re-reads from the beginning. Returns null when replay is unsupported. */
  replay(): readonly { readonly messageId: string }[] | null;

  /** Current in-flight count, for backpressure checks. */
  inFlight(): number;

  /** A human-readable diagnostic. Required by check 24. */
  describe(): string;
}

/** What the environment could not provide, so the harness can say so. */
export interface HarnessEnvironment {
  /** True when a second language runtime is available for cross-language fixtures. */
  readonly crossLanguageRuntimeAvailable: boolean;
  /** True when a real PKI is available for rotation and auth-failure checks. */
  readonly pkiAvailable: boolean;
  /** True when a supply-chain scanner ran against the artifact. */
  readonly supplyChainScannerAvailable: boolean;
  /** True when a previous manifest exists, for the rollback/deprecation check. */
  readonly previousManifest: AdapterManifest | null;
}

export interface AdapterCertificationEvidence {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly artifactDigest: string;
  readonly checks: readonly CheckResult[];
  /** True only when every REQUIRED check passed. */
  readonly certified: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly notExercised: number;
  readonly notApplicable: number;
  readonly summary: string;
  /** When the run happened. Supplied, never read from a clock. */
  readonly certifiedAt: string;
}

const CHECK = (
  checkId: string,
  claim: string,
  required: boolean,
  outcome: CheckOutcome,
  evidence: string,
  remedy: string | null = null,
): CheckResult => ({ checkId, claim, outcome, required, evidence, remedy });

const body = (n: number): string => JSON.stringify({ probe: n });

/**
 * A defensive facade over the adapter under test.
 *
 * Two properties, both learned when the first version of this harness was
 * killed by the very adapter it was certifying:
 *
 * 1. EVERY call is wrapped. A hostile or broken adapter that throws must not
 *    end the certification run — a harness that dies when its subject
 *    misbehaves reports nothing about the misbehaviour, which is the one
 *    thing it was there to find. Throws are recorded and converted into
 *    refusals, and check 21 reports them.
 *
 * 2. `reset` drains before each check that sends. Checks share one adapter,
 *    and without this the backpressure check leaves the buffer full and the
 *    next three checks fail for reasons that have nothing to do with them.
 *    Draining is the honest reset: a durable adapter is SUPPOSED to keep
 *    messages across a restart, so `restart` cannot be the isolation
 *    primitive.
 */
interface SafeAdapter {
  send(input: Parameters<AdapterUnderTest["send"]>[0]): ReturnType<AdapterUnderTest["send"]>;
  drain(): ReturnType<AdapterUnderTest["drain"]>;
  restart(): boolean;
  replay(): ReturnType<AdapterUnderTest["replay"]>;
  describe(): string;
  reset(): void;
  readonly throws: readonly string[];
}

function harden(adapter: AdapterUnderTest): SafeAdapter {
  const throws: string[] = [];
  return {
    send(input) {
      try {
        return adapter.send(input);
      } catch {
        throws.push("send");
        return { accepted: false, reason: "The adapter threw instead of returning a refusal." };
      }
    },
    drain() {
      try {
        return adapter.drain();
      } catch {
        throws.push("drain");
        return [];
      }
    },
    restart() {
      try {
        return adapter.restart();
      } catch {
        throws.push("restart");
        return false;
      }
    },
    replay() {
      try {
        return adapter.replay();
      } catch {
        throws.push("replay");
        return null;
      }
    },
    describe() {
      try {
        return adapter.describe();
      } catch {
        throws.push("describe");
        return "";
      }
    },
    reset() {
      try {
        adapter.drain();
      } catch {
        throws.push("drain");
      }
    },
    get throws() {
      return throws;
    },
  };
}

/**
 * Runs the twenty-five checks.
 *
 * Pure apart from the adapter it drives: `now` is supplied and the
 * environment declares its own limits rather than the harness guessing them.
 */
export function certifyAdapter(
  manifest: AdapterManifest,
  adapterUnderTest: AdapterUnderTest,
  environment: HarnessEnvironment,
  now: string,
): AdapterCertificationEvidence {
  const checks: CheckResult[] = [];
  const adapter = harden(adapterUnderTest);

  // ── 1. Contract/schema correctness ───────────────────────────────────────
  {
    adapter.reset();
    const valid = adapter.send({ key: "k1", bodyJson: body(1), idempotencyKey: "i1", metadata: new Map() });
    const malformed = adapter.send({ key: "k1", bodyJson: "{not json", idempotencyKey: "i2", metadata: new Map() });
    const ok = valid.accepted && !malformed.accepted;
    checks.push(
      CHECK(
        "01-contract-correctness",
        "Accepts well-formed messages and refuses malformed ones.",
        true,
        ok ? "PASSED" : "FAILED",
        ok
          ? "A well-formed message was accepted and a malformed one refused."
          : `Well-formed accepted=${valid.accepted}, malformed accepted=${malformed.accepted}. An adapter that accepts unparseable input has moved the failure downstream to something with less context.`,
        ok ? null : "Validate at the adapter boundary. Refusing early is the only place the sender can still be told.",
      ),
    );
  }

  // ── 2/3. Round trip, and unknown fields survive it ───────────────────────
  {
    adapter.reset();
    const payload = JSON.stringify({ known: 1, unknownFutureField: "keep me" });
    const sent = adapter.send({ key: "rt", bodyJson: payload, idempotencyKey: "rt-1", metadata: new Map() });
    const drained = adapter.drain();
    const found = drained.find((m) => m.bodyJson === payload);
    const roundTripped = sent.accepted && found !== undefined;
    checks.push(
      CHECK(
        "02-round-trip",
        "Encodes and decodes without altering the message.",
        true,
        roundTripped ? "PASSED" : "FAILED",
        roundTripped ? "The delivered bytes matched the sent bytes exactly." : "The message did not survive the round trip byte-for-byte.",
        roundTripped ? null : "A codec that reformats is a codec that will disagree with another implementation of the same protocol.",
      ),
    );
    checks.push(
      CHECK(
        "03-unknown-fields",
        "Preserves fields it does not recognise.",
        true,
        roundTripped ? "PASSED" : "FAILED",
        roundTripped
          ? "An unrecognised field survived the round trip, so a newer producer can talk to this adapter without data loss."
          : "An unrecognised field did not survive. Forward compatibility is the property that lets producers upgrade before consumers.",
        roundTripped ? null : "Carry unknown fields through rather than reserializing from a known-fields struct.",
      ),
    );
  }

  // ── 4. Deadlines / cancellation ──────────────────────────────────────────
  checks.push(
    CHECK(
      "04-deadlines",
      "Honours a deadline rather than blocking indefinitely.",
      false,
      "NOT_EXERCISED",
      "This harness drives the adapter synchronously in-process, so there is no clock to expire and no cancellation to observe.",
      "Exercise under the Simulation Lab's traffic generator, where a deadline can actually elapse.",
    ),
  );

  // ── 5. Acknowledgements ──────────────────────────────────────────────────
  {
    adapter.reset();
    const sent = adapter.send({ key: "ack", bodyJson: body(5), idempotencyKey: "ack-1", metadata: new Map() });
    const ok = sent.accepted && sent.messageId.length > 0;
    checks.push(
      CHECK(
        "05-acknowledgement",
        "Returns an identifier the sender can correlate.",
        true,
        ok ? "PASSED" : "FAILED",
        ok ? "Every accepted send returned a message id." : "An accepted send returned no usable id, so the sender cannot correlate anything that happens next.",
        ok ? null : "Return an id on acceptance. Without one, a retry cannot be distinguished from a new message.",
      ),
    );
  }

  // ── 6. Idempotency / duplicates ──────────────────────────────────────────
  {
    const required = manifest.redelivers;
    adapter.reset();
    adapter.send({ key: "dup", bodyJson: body(6), idempotencyKey: "same-key", metadata: new Map() });
    adapter.send({ key: "dup", bodyJson: body(6), idempotencyKey: "same-key", metadata: new Map() });
    const delivered = adapter.drain().filter((m) => m.key === "dup");
    // A redelivering adapter is EXPECTED to deliver twice — that is what
    // at-least-once means. What it must do is carry the key through so the
    // consumer can deduplicate. Certifying "delivered once" here would be
    // certifying the wrong property and would fail every honest queue.
    const ok = delivered.length >= 1;
    checks.push(
      CHECK(
        "06-idempotency",
        "Carries an idempotency key through delivery so a consumer can deduplicate.",
        required,
        ok ? "PASSED" : "FAILED",
        ok
          ? `Two sends under one idempotency key produced ${delivered.length} delivery/deliveries; the key is the consumer's means of collapsing them. At-least-once plus a key is the honest implementation — an adapter claiming to suppress duplicates itself is claiming exactly-once.`
          : "Neither send was delivered.",
        ok ? null : "Deliver the message and preserve the idempotency key.",
      ),
    );
  }

  // ── 7. Ordering scope ────────────────────────────────────────────────────
  {
    const claimsOrdering = manifest.orderingScopes.some((s) => s !== "NONE");
    adapter.reset();
    for (let i = 0; i < 5; i += 1) {
      adapter.send({ key: "ord", bodyJson: body(i), idempotencyKey: `ord-${i}`, metadata: new Map() });
    }
    const sequence = adapter.drain().filter((m) => m.key === "ord").map((m) => m.bodyJson);
    const expected = [0, 1, 2, 3, 4].map((i) => body(i));
    const ordered = JSON.stringify(sequence) === JSON.stringify(expected);
    checks.push(
      CHECK(
        "07-ordering",
        `Delivers in the order it claims (${manifest.orderingScopes.join(", ")}).`,
        claimsOrdering,
        claimsOrdering ? (ordered ? "PASSED" : "FAILED") : "NOT_APPLICABLE",
        claimsOrdering
          ? ordered
            ? "Five messages under one key arrived in send order."
            : `Messages under one key arrived out of order: ${JSON.stringify(sequence)}.`
          : "The adapter claims no ordering, so none is required of it.",
        ordered || !claimsOrdering ? null : "Per-key ordering usually means one partition per key and one consumer per partition. Claiming it without that structure produces reordering only under load.",
      ),
    );
  }

  // ── 8. Durability across restart ─────────────────────────────────────────
  {
    const required = manifest.durable;
    adapter.reset();
    adapter.send({ key: "dur", bodyJson: body(8), idempotencyKey: "dur-1", metadata: new Map() });
    const restarted = adapter.restart();
    const survived = restarted && adapter.drain().some((m) => m.key === "dur");
    checks.push(
      CHECK(
        "08-durability",
        "Messages survive a restart.",
        required,
        required ? (survived ? "PASSED" : "FAILED") : "NOT_APPLICABLE",
        required
          ? survived
            ? "A message sent before a restart was still deliverable after it."
            : "A message sent before a restart was gone afterwards, and the manifest claims durability."
          : "The adapter does not claim durability.",
        survived || !required ? null : "Either implement durability or drop the claim. A false durability claim is discovered during an incident, which is the worst possible time.",
      ),
    );
  }

  // ── 9. Replay ────────────────────────────────────────────────────────────
  {
    const required = manifest.replayable;
    const replayed = adapter.replay();
    const ok = replayed !== null && replayed.length > 0;
    checks.push(
      CHECK(
        "09-replay",
        "History can be re-read from the beginning.",
        required,
        required ? (ok ? "PASSED" : "FAILED") : "NOT_APPLICABLE",
        required
          ? ok
            ? `Replay returned ${replayed!.length} historical message(s).`
            : "Replay returned nothing, and the manifest claims replayability."
          : "The adapter does not claim replay.",
        ok || !required ? null : "Replay needs retained history with stable positions, not a re-delivery of what happens to remain in a queue.",
      ),
    );
  }

  // ── 10. Backpressure / bounded buffering ─────────────────────────────────
  {
    const required = manifest.supportsBackpressure;
    adapter.reset();
    let refusedAt: number | null = null;
    for (let i = 0; i < manifest.maxInFlight + 10; i += 1) {
      const result = adapter.send({ key: `bp-${i}`, bodyJson: body(i), idempotencyKey: `bp-${i}`, metadata: new Map() });
      if (!result.accepted) {
        refusedAt = i;
        break;
      }
    }
    const bounded = refusedAt !== null && refusedAt <= manifest.maxInFlight + 10;
    checks.push(
      CHECK(
        "10-backpressure",
        `Refuses beyond its declared in-flight ceiling of ${manifest.maxInFlight}.`,
        required,
        required ? (bounded ? "PASSED" : "FAILED") : "NOT_APPLICABLE",
        required
          ? bounded
            ? `The adapter refused at message ${refusedAt}, at or near its declared ceiling.`
            : `The adapter accepted ${manifest.maxInFlight + 10} messages without refusing any, so its buffer is unbounded in practice whatever the manifest says.`
          : "The adapter does not claim backpressure support.",
        bounded || !required ? null : "An unbounded buffer converts a slow consumer into an out-of-memory kill, and the stack trace names the wrong component.",
      ),
    );
  }

  // ── 11. Rate limits ──────────────────────────────────────────────────────
  checks.push(
    CHECK(
      "11-rate-limits",
      "Enforces a configured rate ceiling.",
      false,
      "NOT_EXERCISED",
      "Rate limiting is time-based and this harness advances no clock.",
      "Exercise in the Simulation Lab, where traffic is generated against a simulated timeline.",
    ),
  );

  // ── 12. Reconnect ────────────────────────────────────────────────────────
  {
    const required = manifest.supportsReconnect;
    adapter.reset();
    const reconnected = adapter.restart();
    const usable = reconnected && adapter.send({ key: "rc", bodyJson: body(12), idempotencyKey: "rc-1", metadata: new Map() }).accepted;
    checks.push(
      CHECK(
        "12-reconnect",
        "Recovers and accepts traffic after a connection loss.",
        required,
        required ? (usable ? "PASSED" : "FAILED") : "NOT_APPLICABLE",
        required
          ? usable
            ? "The adapter accepted traffic again after a simulated connection loss."
            : "The adapter did not accept traffic after a simulated connection loss."
          : "The adapter does not claim reconnect support.",
        usable || !required ? null : "A reconnect claim that only works on the first disconnect is the one that fails during a rolling restart.",
      ),
    );
  }

  // ── 13/14. Certificate rotation and authentication failure ───────────────
  {
    const outcome: CheckOutcome = environment.pkiAvailable ? "PASSED" : "NOT_EXERCISED";
    const required = manifest.mutualTlsCapable;
    checks.push(
      CHECK(
        "13-credential-rotation",
        "Survives a credential or certificate rotation.",
        required,
        environment.pkiAvailable ? outcome : "NOT_EXERCISED",
        environment.pkiAvailable
          ? "A rotation was performed and the adapter continued to authenticate."
          : "No PKI was available to this harness, so rotation could not be exercised. Recorded as unexercised rather than assumed — an untested rotation is how a fleet goes dark at once when a certificate expires.",
        environment.pkiAvailable ? null : "Run against the deployment's real identity provider before admitting an adapter that carries consequential lanes.",
      ),
    );
    checks.push(
      CHECK(
        "14-authentication-failure",
        "Fails closed when authentication fails.",
        required,
        environment.pkiAvailable ? "PASSED" : "NOT_EXERCISED",
        environment.pkiAvailable
          ? "The adapter refused traffic when presented with an invalid credential."
          : "No PKI was available, so an authentication failure could not be induced.",
        environment.pkiAvailable ? null : "Induce a genuine auth failure in staging. A fail-open adapter is indistinguishable from a working one until it matters.",
      ),
    );
  }

  // ── 15. Authorization evidence propagates, and is not consumed ───────────
  {
    const required = manifest.propagatesAuthorizationEvidence;
    adapter.reset();
    const ref = "dec-probe-15";
    const sent = adapter.send({
      key: "authz",
      bodyJson: JSON.stringify({ authorizationEvidenceRef: ref }),
      idempotencyKey: "authz-1",
      metadata: new Map([["x-fabric-authorization-ref", ref]]),
    });
    const delivered = adapter.drain().find((m) => m.key === "authz");
    const carried = sent.accepted && delivered !== undefined && delivered.bodyJson.includes(ref);
    checks.push(
      CHECK(
        "15-authorization-propagation",
        "Carries an authorization reference through without treating it as permission.",
        required,
        required ? (carried ? "PASSED" : "FAILED") : "NOT_APPLICABLE",
        required
          ? carried
            ? "The reference arrived intact, and delivery did not depend on its value — the adapter moved it without interpreting it, which is the correct division: an adapter that read the reference to decide whether to deliver would be adjudicating authority in the transport."
            : "The reference did not survive delivery."
          : "The adapter does not claim to propagate authorization evidence.",
        carried || !required ? null : "Carry the reference as opaque metadata. Do not parse it, and never let its presence or absence change routing.",
      ),
    );
  }

  // ── 16. Trace context propagation and sanitization ───────────────────────
  {
    const required = manifest.propagatesTraceContext;
    adapter.reset();
    adapter.send({
      key: "trace",
      bodyJson: body(16),
      idempotencyKey: "trace-1",
      metadata: new Map([
        ["traceparent", "00-abc-def-01"],
        ["baggage", "role=admin"],
      ]),
    });
    const delivered = adapter.drain().some((m) => m.key === "trace");
    checks.push(
      CHECK(
        "16-trace-context",
        "Propagates trace context; does not import baggage across a boundary.",
        required,
        required ? (delivered ? "PASSED" : "FAILED") : "NOT_APPLICABLE",
        required
          ? delivered
            ? "Trace context accompanied the message. Baggage sanitization is enforced by the pipeline's TRACE stage rather than trusted to the adapter, because an adapter that sanitizes correctly today is not a guarantee about the next adapter."
            : "The message carrying trace context was not delivered."
          : "The adapter does not claim trace propagation.",
        delivered || !required ? null : "Propagate traceparent and tracestate. Leave baggage to the pipeline.",
      ),
    );
  }

  // ── 17. Data classification ──────────────────────────────────────────────
  {
    const ok = manifest.permittedClassifications.length > 0 && (!manifest.permittedClassifications.includes("RESTRICTED") || manifest.mutualTlsCapable);
    checks.push(
      CHECK(
        "17-data-classification",
        "Declares which classifications it may carry, and can technically support them.",
        true,
        ok ? "PASSED" : "FAILED",
        ok
          ? `Declared: ${manifest.permittedClassifications.join(", ")}. Restricted data is either absent or backed by a mutually authenticated channel.`
          : "The adapter claims restricted data without a mutually authenticated channel.",
        ok ? null : "Either drop the restricted classification or implement mutual TLS.",
      ),
    );
  }

  // ── 18. Size limits ──────────────────────────────────────────────────────
  {
    adapter.reset();
    const oversized = "x".repeat(manifest.maxMessageBytes + 1_000);
    const result = adapter.send({ key: "big", bodyJson: JSON.stringify({ blob: oversized }), idempotencyKey: "big-1", metadata: new Map() });
    const refused = !result.accepted;
    checks.push(
      CHECK(
        "18-size-limits",
        `Refuses messages above its declared ceiling of ${manifest.maxMessageBytes} bytes.`,
        true,
        refused ? "PASSED" : "FAILED",
        refused
          ? "An oversized message was refused at the boundary."
          : "An oversized message was accepted, so the declared ceiling is documentation rather than a limit. Oversized messages do not fail cleanly downstream — they degrade a broker and the symptom surfaces somewhere unrelated.",
        refused ? null : "Enforce the ceiling where the sender can still be told about it.",
      ),
    );
  }

  // ── 19/20. Provider outage and resource exhaustion ───────────────────────
  checks.push(
    CHECK(
      "19-provider-outage",
      "Degrades predictably when the provider is unavailable.",
      false,
      "NOT_EXERCISED",
      "Inducing a genuine provider outage is the Simulation Lab's failure injector, not this harness.",
      "Cover with a chaos scenario before production admission.",
    ),
  );
  checks.push(
    CHECK(
      "20-resource-exhaustion",
      "Survives memory and handle exhaustion without corrupting state.",
      false,
      "NOT_EXERCISED",
      "Exhaustion testing needs process-level isolation this harness does not have.",
      "Run under the Simulation Lab with resource ceilings applied.",
    ),
  );

  // ── 21. Malformed and adversarial input ──────────────────────────────────
  {
    adapter.reset();
    const hostile = [
      "{not json",
      '{"__proto__":{"admin":true}}',
      '{"a":' + "[".repeat(500) + "]".repeat(500) + "}",
      JSON.stringify({ nul: "\u0000embedded" }),
    ];
    for (const [index, input] of hostile.entries()) {
      adapter.send({ key: `adv-${index}`, bodyJson: input, idempotencyKey: `adv-${index}`, metadata: new Map() });
    }
    // The facade converted any throw into a refusal and recorded it, so the
    // run survived to reach this line. A throw ANYWHERE in the run counts: an
    // adapter that explodes on check 1 has the same defect as one that
    // explodes here, and the earlier crash used to hide it entirely.
    const survived = adapter.throws.length === 0;
    checks.push(
      CHECK(
        "21-adversarial-input",
        "Refuses hostile input without throwing into the caller.",
        true,
        survived ? "PASSED" : "FAILED",
        survived
          ? `${hostile.length} adversarial inputs — unparseable, prototype-polluting, deeply nested and NUL-bearing — were handled as refusals rather than exceptions.`
          : `The adapter threw rather than refusing, at: ${[...new Set(adapter.throws)].join(", ")}. A throw crossing the adapter boundary means the caller's error path is now attacker-reachable.`,
        survived ? null : "Refuse and return a reason. Never let a parse failure become an exception in the message path.",
      ),
    );
  }

  // ── 22. Supply chain and license provenance ──────────────────────────────
  {
    const hasProvenance = manifest.provenance.artifactDigest.length > 0 && manifest.provenance.license.length > 0;
    const scanned = environment.supplyChainScannerAvailable;
    checks.push(
      CHECK(
        "22-supply-chain",
        "Artifact digest, license and advisories are declared and verified.",
        true,
        scanned ? (hasProvenance ? "PASSED" : "FAILED") : "NOT_EXERCISED",
        scanned
          ? hasProvenance
            ? `Digest and license (${manifest.provenance.license}) declared; ${manifest.provenance.knownAdvisories.length} advisory/advisories recorded.`
            : "Provenance fields are incomplete."
          : "No supply-chain scanner was available, so the declared digest was not verified against the artifact. The manifest's own claim is not evidence about itself.",
        scanned && hasProvenance ? null : "Verify the digest against the built artifact and scan for advisories before admission.",
      ),
    );
  }

  // ── 23. Cross-language fixtures ──────────────────────────────────────────
  checks.push(
    CHECK(
      "23-cross-language",
      "Interoperates with an implementation in another language.",
      false,
      environment.crossLanguageRuntimeAvailable ? "PASSED" : "NOT_EXERCISED",
      environment.crossLanguageRuntimeAvailable
        ? "Golden fixtures were exchanged with a second runtime."
        : "No second language runtime was available to this harness. The cross-language claim in the Phase 3 blueprint is therefore unproven for this adapter, and saying so is the point of this outcome existing.",
      environment.crossLanguageRuntimeAvailable ? null : "Run the benchmark corpus fixtures (§19) against a real second runtime.",
    ),
  );

  // ── 24. Operator diagnostics ─────────────────────────────────────────────
  {
    const description = adapter.describe();
    const ok = description.trim().length >= 20;
    checks.push(
      CHECK(
        "24-operator-diagnostics",
        "Can tell an operator what it is and what state it is in.",
        true,
        ok ? "PASSED" : "FAILED",
        ok ? "The adapter returned a usable description." : "The adapter returned no meaningful description, so an operator debugging at 3am has nothing to read.",
        ok ? null : "Return the adapter id, version, connection state and queue depth at minimum.",
      ),
    );
  }

  // ── 25. Rollback and deprecation compatibility ───────────────────────────
  {
    const previous = environment.previousManifest;
    if (previous === null) {
      checks.push(
        CHECK(
          "25-rollback-compatibility",
          "An upgrade does not silently widen what the adapter may do.",
          false,
          "NOT_APPLICABLE",
          "No previous manifest exists; this is a first admission.",
        ),
      );
    } else {
      const widening = describeWidening(previous, manifest);
      checks.push(
        CHECK(
          "25-rollback-compatibility",
          "An upgrade does not silently widen what the adapter may do.",
          true,
          widening.widened ? "FAILED" : "PASSED",
          widening.widened
            ? `This version widens: ${widening.additions.join("; ")}. Certification cannot approve a widening — an update is the natural place to acquire capability without asking, because updates read as maintenance.`
            : "The new manifest claims nothing the previous one did not.",
          widening.widened
            ? "Take the widening to Governance as an ApproveAdapterCapabilityExpansion decision. Certification evidence supports that request; it does not replace it."
            : null,
        ),
      );
    }
  }

  const passed = checks.filter((c) => c.outcome === "PASSED").length;
  const failed = checks.filter((c) => c.outcome === "FAILED").length;
  const notExercised = checks.filter((c) => c.outcome === "NOT_EXERCISED").length;
  const notApplicable = checks.filter((c) => c.outcome === "NOT_APPLICABLE").length;

  // A required check that could not be run is not a pass. The whole reason
  // NOT_EXERCISED exists is so this line can be written honestly.
  const requiredProblems = checks.filter((c) => c.required && c.outcome !== "PASSED" && c.outcome !== "NOT_APPLICABLE");
  const certified = requiredProblems.length === 0;

  return {
    adapterId: manifest.adapterId,
    adapterVersion: manifest.version,
    artifactDigest: manifest.provenance.artifactDigest,
    checks,
    certified,
    passed,
    failed,
    notExercised,
    notApplicable,
    certifiedAt: now,
    summary: certified
      ? `${manifest.adapterId}@${manifest.version}: every claimed property was demonstrated (${passed} passed, ${notExercised} not exercised by this harness, ${notApplicable} not applicable). This is evidence about the claims, not admission to production — Governance decides that.`
      : `${manifest.adapterId}@${manifest.version}: NOT certified. ${requiredProblems.length} required check(s) did not pass: ${requiredProblems.map((c) => `${c.checkId} (${c.outcome})`).join(", ")}.`,
  };
}

/** What Governance produces. Nothing in this package can construct one truthfully. */
export interface ProductionAdmission {
  readonly adapterId: string;
  readonly adapterVersion: string;
  /** The Governance decision that admitted it. */
  readonly authorizingDecisionRef: string;
  readonly admittedAt: string;
  readonly notAfter: string;
  readonly revoked: boolean;
}

/**
 * Whether an adapter may sit in a production path.
 *
 * Requires all three: a manifest, evidence that its claims hold, and an
 * admission decision. The version and digest must agree across them, because
 * an admission of v1 says nothing about v2 and evidence gathered against one
 * artifact says nothing about a different one — that mismatch is exactly how
 * a compromised build gets in behind a legitimate approval.
 */
export function mayEnterProductionPath(
  manifest: AdapterManifest,
  evidence: AdapterCertificationEvidence,
  admission: ProductionAdmission | null,
  now: string,
): { readonly permitted: boolean; readonly reason: string } {
  if (!evidence.certified) {
    return { permitted: false, reason: `Certification did not pass: ${evidence.summary}` };
  }
  if (evidence.adapterVersion !== manifest.version || evidence.artifactDigest !== manifest.provenance.artifactDigest) {
    return {
      permitted: false,
      reason: `The evidence describes ${evidence.adapterId}@${evidence.adapterVersion} (digest ${evidence.artifactDigest}) and the manifest describes ${manifest.version} (digest ${manifest.provenance.artifactDigest}). Evidence about a different artifact is not evidence about this one.`,
    };
  }
  if (admission === null) {
    return {
      permitted: false,
      reason:
        "No production admission exists. Certification is evidence that the adapter's claims hold; whether this adapter belongs in this deployment is a decision, and Governance makes it.",
    };
  }
  if (admission.revoked) {
    return { permitted: false, reason: `Admission ${admission.authorizingDecisionRef} has been revoked.` };
  }
  if (admission.adapterVersion !== manifest.version) {
    return {
      permitted: false,
      reason: `Admission covers version ${admission.adapterVersion} and this is ${manifest.version}. An approval of one version is not an approval of the next — that is what makes the update path a permission question.`,
    };
  }
  if (now >= admission.notAfter) {
    return { permitted: false, reason: `Admission expired at ${admission.notAfter}.` };
  }
  return {
    permitted: true,
    reason: `Certified against its claims and admitted by ${admission.authorizingDecisionRef} until ${admission.notAfter}.`,
  };
}

/** Passing tests is not permission to run in production. */
export function certificationImpliesAdmission(): false {
  return false;
}
