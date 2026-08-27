// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change.

/**
 * A locally-stored recipe.
 *
 * In the host this type is declared next to a React hook (`hooks/use-recipes`),
 * which is where the UI keeps them — but the type itself is data, and the
 * import was `import type`, so nothing runtime came with it.
 */
export interface PrepRecipeLocal {
  id: string;
  name: string;
  presetKey: string;
  edgeMode: string;
  vectorizeRecommended: boolean;
  halftoneEnabled: boolean;
  backgroundRemoval: boolean;
  colorMapping: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}
