// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// Exact rational arithmetic moved to `@proworks-hub/contracts` (exactRational)
// when AllocationIQ needed the same solve — two specialists may not import
// each other, so shared math lives in the platform. Re-exported here to keep
// this package's public surface stable.

export {
  rational,
  ratioFromDecimal,
  ratioFromPercent,
  rAdd,
  rSub,
  rMul,
  rDiv,
  rEquals,
  rIsZero,
  rToDecimalString,
  solveLinearSystem,
  R_ONE,
  R_ZERO,
  type Rational,
} from "@proworks-hub/contracts";
