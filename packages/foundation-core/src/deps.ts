// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// One place naming everything Foundation Core depends on.
//
// Both are PLATFORM packages, which is what the dependency law permits a Core
// to import (`core: ["platform"]`). Foundation depends on no engine, and a
// single import surface makes that easy to check in review rather than by
// grepping every file.

export {
  canonicalReferenceSchema,
  healthStateSchema,
  identifierSchema,
  versionReferenceSchema,
} from "@proworks-hub/contracts";
export type {
  AuthorityEnvelope,
  CanonicalReference,
  Governance,
  HealthState,
  VersionReference,
} from "@proworks-hub/contracts";

export {
  coreRequest,
  createCoordinator,
  createSpecialistRegistry,
  defaultAuthorityFor,
} from "@proworks-hub/core-kit";
export type {
  CoreAnswer,
  CoreFailure,
  CoreRefusal,
  CoreRequest,
  Coordinator,
  Specialist,
  SpecialistRegistry,
} from "@proworks-hub/core-kit";
