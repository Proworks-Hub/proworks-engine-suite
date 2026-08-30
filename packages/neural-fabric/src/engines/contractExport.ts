/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/engines/contractExport.ts
 * Module:   neural-fabric / engines
 * Purpose:  The contracts, spoken in languages that are not TypeScript.
 */

import { LANE_SEMANTICS } from "../domain/lanes.js";
import type { ContractVersion } from "./contractIQ.js";

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT-FIRST MEANS THE CONTRACT SURVIVES THE LANGUAGE
//
// §10 requires machine-readable contracts, and the reason is portability's
// sharpest test: a Python consumer, a Go gateway, or a broker's own schema
// registry must be able to hold the SAME contract this package enforces —
// without importing TypeScript. If the only authoritative form of a contract
// is a TS type, the Fabric is TypeScript-bound however neutral its transports.
//
// So each exporter derives its artifact FROM the ContractVersion record. The
// record stays the single source; the artifacts are projections. Nothing here
// weakens `canSpeak` — an exported schema is documentation of the contract,
// and compatibility is still decided by the compatibility logic, not by
// whether two JSON Schemas happen to validate the same instance.
//
// WHAT AN EXPORT SAYS THAT THE TYPE CANNOT
//
// Each artifact carries the lane's SEMANTICS — delivery, ordering, idempotency
// — because a consumer in another language needs "this redelivers, be
// idempotent" far more than it needs the field list. The field list prevents
// a parse error; the semantics prevent a double-charged customer.
// ─────────────────────────────────────────────────────────────────────────────

/** JSON Schema (2020-12 dialect) for a contract version's envelope payload. */
export function toJsonSchema(contract: ContractVersion): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of [...contract.requiredFields, ...contract.optionalFields].sort()) {
    // The record does not carry per-field types — that is a known limitation,
    // stated in the description rather than papered over with `string`.
    properties[field] = {
      description: `Declared by ${contract.schemaId} v${contract.version}. The contract registry does not yet carry per-field types; the owning engine's schema is authoritative for the shape of this field.`,
    };
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `hive:contract:${contract.schemaId}:v${contract.version}`,
    title: contract.schemaId,
    description: `Version ${contract.version} on the ${contract.lane} lane. Status: ${contract.status}.${
      contract.sunsetAt ? ` Unusable from ${contract.sunsetAt}.` : ""
    } Delivery: ${LANE_SEMANTICS[contract.lane].delivery}; consumers ${
      LANE_SEMANTICS[contract.lane].requiresIdempotentConsumer ? "MUST be idempotent" : "need not be idempotent"
    }.`,
    type: "object",
    properties,
    required: [...contract.requiredFields].sort(),
    additionalProperties: false,
  };
}

/**
 * An AsyncAPI 3.0 document for a set of contracts.
 *
 * One channel per schemaId+lane; the operation direction follows the lane —
 * a QUERY is request/reply, everything else is send.
 */
export function toAsyncApi(
  contracts: readonly ContractVersion[],
  info: { readonly title: string; readonly version: string },
): Record<string, unknown> {
  const channels: Record<string, unknown> = {};
  const operations: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};

  for (const contract of [...contracts].sort((a, b) => a.schemaId.localeCompare(b.schemaId) || a.version - b.version)) {
    const channelId = `${contract.lane.toLowerCase()}.${contract.schemaId}`;
    const messageId = `${contract.schemaId}.v${contract.version}`;
    schemas[messageId] = toJsonSchema(contract);
    channels[channelId] = {
      address: channelId,
      messages: { [messageId]: { payload: { $ref: `#/components/schemas/${messageId}` } } },
      description: `${contract.lane} lane. ${LANE_SEMANTICS[contract.lane].purpose}`,
    };
    operations[`send.${messageId}`] = {
      action: "send",
      channel: { $ref: `#/channels/${channelId.replace(/\//g, "~1")}` },
      // The semantics a foreign consumer actually needs, stated where their
      // tooling will render it.
      description: `Delivery ${LANE_SEMANTICS[contract.lane].delivery}, ordering ${LANE_SEMANTICS[contract.lane].ordering}. ${
        LANE_SEMANTICS[contract.lane].requiresIdempotentConsumer
          ? "Redelivered until acknowledged: the consumer MUST be idempotent."
          : "Not redelivered."
      }`,
    };
  }

  return {
    asyncapi: "3.0.0",
    info: { ...info, description: "Generated from the Neural Fabric contract registry. The registry is the source; this document is a projection of it." },
    channels,
    operations,
    components: { schemas },
  };
}

/**
 * A CloudEvents attribute mapping for an EVENT-lane contract.
 *
 * Refuses non-event lanes rather than mapping them anyway: CloudEvents
 * describes things that HAPPENED, and wrapping a command in one invites a
 * consumer to treat "please do this" as "this occurred".
 */
export function toCloudEventsBinding(contract: ContractVersion):
  | { readonly ok: true; readonly binding: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string } {
  if (contract.lane !== "EVENT" && contract.lane !== "STREAM") {
    return {
      ok: false,
      reason: `${contract.schemaId} is on the ${contract.lane} lane. CloudEvents describes things that happened; mapping a ${contract.lane} into one invites a consumer to treat "please do this" as "this occurred", which is the confusion the lanes exist to prevent.`,
    };
  }
  return {
    ok: true,
    binding: {
      specversion: "1.0",
      type: `hive.${contract.schemaId}.v${contract.version}`,
      // How Fabric envelope fields project onto CloudEvents attributes.
      attributeMapping: {
        id: "fabricMessageId",
        source: "provenance.originComponent",
        subject: "destination.capability",
        time: "(assigned at emission)",
        datacontenttype: "contentType",
        // Extensions carry what CloudEvents has no slot for.
        extensions: {
          hivecorrelation: "correlationId",
          hivecausation: "causationId",
          hivetenant: "tenantId — NEVER into shared telemetry; carried only where the consumer is entitled to it",
          hiveistest: "isTest",
        },
      },
    },
  };
}

/** A .proto descriptor for a QUERY/COMMAND contract, for gRPC-style lanes. */
export function toProtoDescriptor(contract: ContractVersion):
  | { readonly ok: true; readonly proto: string }
  | { readonly ok: false; readonly reason: string } {
  if (contract.lane !== "QUERY" && contract.lane !== "COMMAND") {
    return {
      ok: false,
      reason: `${contract.schemaId} is on the ${contract.lane} lane; proto/gRPC descriptors are generated for the synchronous lanes only. A stream or event over unary RPC would rebuild the bus badly.`,
    };
  }
  const messageName = contract.schemaId
    .split(/[.\-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const fields = [...contract.requiredFields, ...contract.optionalFields]
    .sort()
    .map((field, index) => `  // ${contract.requiredFields.includes(field) ? "required by contract" : "optional"}\n  string ${field.replace(/[^a-zA-Z0-9_]/g, "_")} = ${index + 1};`)
    .join("\n");
  return {
    ok: true,
    proto: [
      `// Generated from ${contract.schemaId} v${contract.version}. The registry is the source.`,
      `// Proto3 has no required fields; the contract's requirements are enforced by the`,
      `// Fabric's compatibility logic, not by protobuf — this descriptor is transport shape only.`,
      `syntax = "proto3";`,
      ``,
      `package hive.fabric.v${contract.version};`,
      ``,
      `message ${messageName} {`,
      fields,
      `}`,
    ].join("\n"),
  };
}

/** TypeScript declaration text, for consumers who ARE in TypeScript. */
export function toTypeScriptBinding(contract: ContractVersion): string {
  const typeName = contract.schemaId
    .split(/[.\-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const required = [...contract.requiredFields].sort().map((f) => `  readonly ${JSON.stringify(f)}: unknown;`);
  const optional = [...contract.optionalFields].sort().map((f) => `  readonly ${JSON.stringify(f)}?: unknown;`);
  return [
    `/** ${contract.schemaId} v${contract.version} — ${contract.lane} lane, ${contract.status}. Generated; the registry is the source. */`,
    `export interface ${typeName}V${contract.version} {`,
    ...required,
    ...optional,
    `}`,
  ].join("\n");
}

/**
 * Whether an export can change what canSpeak decides.
 *
 * Never. The artifacts are projections; compatibility is decided by the
 * compatibility logic. Two JSON Schemas happening to validate the same
 * instance is not a compatibility verdict.
 */
export function exportsAffectCompatibility(): false {
  return false;
}
