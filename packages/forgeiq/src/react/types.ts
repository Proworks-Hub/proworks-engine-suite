// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ProductConfiguration } from "../core/schemas/configuration.js";
import type { ProductDefinition } from "../core/schemas/productDefinition.js";

// Engine-neutral cart payload — the host maps this into its own cart shape.
export interface AddToCartPayload {
  configurationId: number;
  productSlug: string;
  productName: string;
  summary: string;
  customerPrice: number;
  previewImageUrls: string[];
  // Generated production files (per-panel cutline SVGs), already uploaded via
  // the injected uploadFile — hosts attach these to the order so production
  // tooling picks them up.
  productionFileUrls: string[];
  config: ProductConfiguration;
}

export type UploadFn = (file: File) => Promise<{ url: string }>;

export interface BuilderEngineProps {
  productSlug: string;
  apiBase?: string; // default "/api/forgeiq"
  uploadFile: UploadFn;
  onAddToCart: (payload: AddToCartPayload) => void;
}

export interface ProductResponse {
  id: number;
  slug: string;
  version: number;
  definition: ProductDefinition;
}
