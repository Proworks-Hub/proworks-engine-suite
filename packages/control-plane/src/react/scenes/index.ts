// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  ChannelFunnelScene,
  CostStackScene,
  DocumentScannerScene,
  FabricationCellScene,
  InventoryRacksScene,
  OrchestrationCoreScene,
  ProductionLineScene,
  VisionLensScene,
} from "./engineScenes.js";
import { GenericScene, IntelligenceCoreScene, ServiceStripScene } from "./supportScenes.js";
import type { EngineScene } from "./types.js";

export * from "./types.js";
export * from "./keyframes.js";

/**
 * `visualizationType` → the component that draws it.
 *
 * A lookup, so adding artwork for a new engine is one entry here plus one
 * manifest — and forgetting the entry costs a generic hexagon rather than a
 * blank card or a crash.
 */
export const SCENE_REGISTRY: Readonly<Record<string, EngineScene>> = {
  "orchestration-core": OrchestrationCoreScene,
  "fabrication-cell": FabricationCellScene,
  "cost-stack": CostStackScene,
  "vision-lens": VisionLensScene,
  "production-line": ProductionLineScene,
  "document-scanner": DocumentScannerScene,
  "inventory-racks": InventoryRacksScene,
  "channel-funnel": ChannelFunnelScene,
  "intelligence-core": IntelligenceCoreScene,
  "service-strip": ServiceStripScene,
  generic: GenericScene,
};

/** Never returns undefined. A missing scene must not blank a card. */
export function resolveScene(visualizationType: string): EngineScene {
  return SCENE_REGISTRY[visualizationType] ?? GenericScene;
}

export {
  ChannelFunnelScene,
  CostStackScene,
  DocumentScannerScene,
  FabricationCellScene,
  GenericScene,
  IntelligenceCoreScene,
  InventoryRacksScene,
  OrchestrationCoreScene,
  ProductionLineScene,
  ServiceStripScene,
  VisionLensScene,
};
