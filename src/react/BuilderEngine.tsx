import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { resolveSurfaceDims } from "../core/resolve";
import { buildPanelCutlineSvg, cutlineFilename } from "../core/export/cutlineSvg";
import type { SurfaceElement } from "../core/schemas/configuration";
import { fetchProduct, postConfiguration } from "./engineClient";
import { useBuilderState } from "./useBuilderState";
import { usePriceAndValidation } from "./usePriceAndValidation";
import { OptionGroupPicker } from "./components/OptionGroupPicker";
import { AssembledPreview } from "./components/AssembledPreview";
import { SurfaceTabs } from "./components/SurfaceTabs";
import { SurfaceEditor } from "./components/SurfaceEditor";
import { ElementControls } from "./components/ElementControls";
import { ValidationPanel } from "./components/ValidationPanel";
import { PriceSummary } from "./components/PriceSummary";
import type { BuilderEngineProps, ProductResponse } from "./types";

export function BuilderEngine(props: BuilderEngineProps) {
  const apiBase = props.apiBase ?? "/api/forgeiq";

  const product = useQuery({
    queryKey: ["forgeiq-product", props.productSlug],
    queryFn: () => fetchProduct(apiBase, props.productSlug),
    staleTime: 5 * 60_000,
  });

  if (product.isLoading) {
    return <div style={{ padding: 40, textAlign: "center", color: "#71717a" }}>Loading builder…</div>;
  }
  if (product.isError || !product.data) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#dc2626" }}>
        This product is not available right now.
      </div>
    );
  }
  return <LoadedBuilder {...props} apiBase={apiBase} product={product.data} />;
}

function LoadedBuilder(
  props: BuilderEngineProps & { apiBase: string; product: ProductResponse },
) {
  const { product, apiBase } = props;
  const definition = product.definition;
  const { state, dispatch, config } = useBuilderState(definition);
  const { price, validation } = usePriceAndValidation(apiBase, product.id, config);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const surfaceDims = useMemo(
    () => resolveSurfaceDims(definition, config),
    [definition, config],
  );

  const issues = validation.data?.issues ?? [];
  const issueCounts: Record<string, number> = {};
  for (const issue of issues) {
    if (issue.surfaceId) issueCounts[issue.surfaceId] = (issueCounts[issue.surfaceId] ?? 0) + 1;
  }

  // Visual hint for material-realistic rendering, carried on the selected
  // material option's meta (data-driven, host-agnostic).
  const materialPreview = definition.optionGroups
    .flatMap((g) => g.values)
    .find((v) => v.id === state.selections.material && v.materialProfileId !== undefined)
    ?.meta?.preview as string | undefined;

  const activeSurface = definition.surfaces.find((s) => s.id === state.activeSurfaceId);
  const activeElements: SurfaceElement[] = state.activeSurfaceId
    ? (state.surfaces[state.activeSurfaceId] ?? [])
    : [];
  const selectedElement =
    activeElements.find((el) => el.id === state.selectedElementId) ?? null;

  const hasErrors = issues.some((i) => i.severity === "error");
  const canOrder = !hasErrors && validation.data !== undefined && price.data !== undefined;

  async function handleAddToCart() {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await postConfiguration(apiBase, product.id, config);
      const previews = Object.values(config.surfaces)
        .flat()
        .filter((el): el is Extract<SurfaceElement, { type: "image" }> => el.type === "image")
        .map((el) => el.url);
      const sizeLabel = definition.optionGroups
        .find((g) => g.id === "size")
        ?.values.find((v) => v.id === config.selections.size)?.label;
      const materialValue = definition.optionGroups
        .find((g) => g.id === "material")
        ?.values.find((v) => v.id === config.selections.material);
      const materialSlug = materialValue?.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

      // Generate + upload per-panel cutline SVGs so the order arrives
      // production-ready. Best-effort: a failed upload must not block the
      // sale — the shop can re-export from the saved configuration.
      const productionFileUrls: string[] = [];
      for (const surface of definition.surfaces) {
        const elements = config.surfaces[surface.id] ?? [];
        if (elements.length === 0) continue;
        const dims = surfaceDims.get(surface.id);
        if (!dims) continue;
        try {
          const svg = buildPanelCutlineSvg({
            productSlug: definition.slug,
            panelId: surface.id,
            panelName: surface.name,
            widthIn: dims.widthIn,
            heightIn: dims.heightIn,
            elements,
            materialLabel: materialValue?.label,
            machineLabel: definition.manufacturingProcess,
          });
          const filename = cutlineFilename({
            productSlug: definition.slug,
            panelId: surface.id,
            widthIn: dims.widthIn,
            heightIn: dims.heightIn,
            materialSlug,
          });
          const file = new File([svg], filename, { type: "image/svg+xml" });
          const { url } = await props.uploadFile(file);
          productionFileUrls.push(url);
        } catch (err) {
          console.error(`ForgeIQ: cutline upload failed for ${surface.id}:`, err);
        }
      }

      props.onAddToCart({
        configurationId: saved.id,
        productSlug: definition.slug,
        productName: definition.name,
        summary: [sizeLabel, definition.name].filter(Boolean).join(" "),
        customerPrice: saved.customerPrice,
        previewImageUrls: previews,
        productionFileUrls,
        config,
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save your design");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap", fontFamily: "system-ui, sans-serif" }}>
      {/* Left: options */}
      <div style={{ width: 240, flexShrink: 0 }}>
        <OptionGroupPicker
          groups={definition.optionGroups}
          selections={state.selections}
          onSelect={(groupId, valueId) => dispatch({ type: "SELECT_OPTION", groupId, valueId })}
        />
      </div>

      {/* Center: surface editor */}
      <div style={{ flexGrow: 1, minWidth: 400 }}>
        <SurfaceTabs
          surfaces={definition.surfaces}
          activeSurfaceId={state.activeSurfaceId}
          issueCounts={issueCounts}
          onSelect={(surfaceId) => dispatch({ type: "SET_ACTIVE_SURFACE", surfaceId })}
        />
        {activeSurface && (
          <div style={{ border: "1px solid #d4d4d8", borderRadius: "0 8px 8px 8px", padding: 12, background: "#fff" }}>
            <SurfaceEditor
              surface={activeSurface}
              dims={surfaceDims.get(activeSurface.id) ?? { widthIn: activeSurface.widthIn, heightIn: activeSurface.heightIn }}
              elements={activeElements}
              issues={issues.filter((i) => i.surfaceId === activeSurface.id)}
              selectedElementId={state.selectedElementId}
              materialPreview={materialPreview}
              onSelect={(elementId) => dispatch({ type: "SELECT_ELEMENT", elementId })}
              onMove={(elementId, xIn, yIn) =>
                dispatch({ type: "UPDATE_ELEMENT", surfaceId: activeSurface.id, elementId, patch: { xIn, yIn } })
              }
            />
            <div style={{ marginTop: 10 }}>
              <ElementControls
                surfaceId={activeSurface.id}
                allowedTypes={activeSurface.allowedElementTypes}
                selectedElement={selectedElement}
                uploadFile={props.uploadFile}
                onAdd={(element) => dispatch({ type: "ADD_ELEMENT", surfaceId: activeSurface.id, element })}
                onUpdate={(elementId, patch) =>
                  dispatch({ type: "UPDATE_ELEMENT", surfaceId: activeSurface.id, elementId, patch })
                }
                onRemove={(elementId) => dispatch({ type: "REMOVE_ELEMENT", surfaceId: activeSurface.id, elementId })}
              />
            </div>
          </div>
        )}
      </div>

      {/* Right: assembled view + validation + price */}
      <div style={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        <AssembledPreview
          definition={definition}
          surfaces={state.surfaces}
          surfaceDims={surfaceDims}
          materialPreview={materialPreview}
        />
        <ValidationPanel
          validation={validation.data}
          onFocusIssue={(surfaceId, elementId) => {
            if (surfaceId) dispatch({ type: "SET_ACTIVE_SURFACE", surfaceId });
            if (elementId) dispatch({ type: "SELECT_ELEMENT", elementId });
          }}
        />
        <PriceSummary
          price={price.data}
          quantity={state.quantity}
          canOrder={canOrder}
          saving={saving}
          onQuantityChange={(quantity) => dispatch({ type: "SET_QUANTITY", quantity })}
          onAddToCart={() => void handleAddToCart()}
        />
        {saveError && <div style={{ color: "#dc2626", fontSize: 13 }}>{saveError}</div>}
      </div>
    </div>
  );
}
