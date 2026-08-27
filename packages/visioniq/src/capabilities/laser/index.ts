// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// VisionIQ laser capability — photo engraving, tone building and cut preparation.
//
// The tone builder is the substance: adaptive threshold, error diffusion,
// ordered dither, halftone dots and lines, and a hybrid mode. That is what
// turns a customer photograph into something a laser can burn into slate, and
// it arrived from the host already free of the DOM and of React.
//
// One capability inside one engine, per the directive: no LaserIQ.
//
// `tone` IS NAMESPACED because the host carries TWO LaserToneBuilderConfig
// interfaces — one here in LaserPrepConfig, one in tone/LaserToneBuilderTypes.
// Their fields match; their mode types do not (LaserToneMode vs
// LaserToneMethod). Merging them would be a behavioural change disguised as
// tidying, so both are exported and the split is visible in the path.

export * from "./LaserAnalysisResult.js";
export * from "./LaserPrepConfig.js";
export * from "./laserAnalysis.js";
export * from "./laserToneBuilder.js";
export * from "./laserTransforms.js";

// The tone pipeline. See the note above on the duplicate config type.
export * as tone from "./tone/index.js";
