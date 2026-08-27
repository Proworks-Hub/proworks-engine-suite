import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { resolveSurfaceDims } from "../core/resolve";
import type { SurfaceElement } from "../core/schemas/configuration";
import { fetchProduct, postConfiguration } from "./engineClient";
import { useBuilderState } from "./useBuilderState";
import { usePriceAndValidation } from "./usePriceAndValidation";
import { OptionGroupPicker } from "./components/OptionGroupPicker";
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
      props.onAddToCart({
        configurationId: saved.id,
        productSlug: definition.slug,
        productName: definition.name,
        summary: [sizeLabel, definition.name].filter(Boolean).join(" "),
        customerPrice: saved.customerPrice,
        previewImageUrls: previews,
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

      {/* Right: validation + price */}
      <div style={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12 }}>
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
