// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's dtf-prep module without behavioural change.
// The intelligence layer had no DOM references, no ImageData, and no imports
// outside its own module — only the import paths changed.

export interface DtfDesign {
  id: string;
  name: string;
  imageUrl: string;
  widthIn: number;
  heightIn: number;
  dpiEstimate: number;
  hasTransparency: boolean;
  xIn: number;
  yIn: number;
  rotation: 0 | 90;
  groupId?: string;
  setId?: string;
  locked?: boolean;
  rotationSensitive?: boolean;
  mirrorSafe?: boolean;
  edgeContaminationRisk?: number;
  transparencyQuality?: number;
  detailComplexityScore?: number;
}
