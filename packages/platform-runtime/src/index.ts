// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// @proworks-hub/platform-runtime — development and test bindings for the
// runtime ports: background work, and being able to explain what happened.
//
// The ports live in @proworks-hub/contracts, because that is what the engines
// share. These are implementations of them, and a host swaps in a real queue
// and a real telemetry pipeline behind the same interfaces.

export * from "./inMemoryJobQueue.js";
export * from "./observability.js";
export * from "./resilienceRuntime.js";
export * from "./platformServices.js";
export * from "./webhooks.js";
export * from "./outbox.js";

// Binds the identity plane to the existing `Authorizer` port.
export * from "./principalAuthorizer.js";

// A Hive instance admitting a request: identity, trust, evidence, Governance.
export * from "./instanceAdmission.js";

// Is there room, and is this important enough to have it.
export * from "./capacityGate.js";

// The instance operating mode, the local queue, and the way back.
export * from "./continuityMode.js";

// Classify, deduplicate, compare cohorts. Never contain.
export * from "./telemetryPipeline.js";

// The knowledge gateway: one read path, one contribution path.
export * from "./knowledgeGateway.js";

// The instance and knowledge registries, and scope precedence.
export * from "./federation.js";
