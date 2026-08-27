import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { resolveSurfaceDims } from "../core/resolve";
import {
  buildPanelCutlineSvg,
  cutlineFilename,
  type ElementCutContours,
} from "../core/export/cutlineSvg";
import { traceImageCutContour } from "./export/contour";
import {
  applyRepairs,
  suggestRepairs,
  type RepairSuggestion,
} from "../core/repair/designRepair";
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
import { ConceptStudio } from "./components/ConceptStudio";
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
  // Customers either design it themselves or answer a few questions and let
  // the engine propose concepts. Undecided until they pick.
  const [mode, setMode] = useState<"choosing" | "manual" | "assisted">("choosing");

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

  // Automatic fixes available for the current issues ("Fix automatically").
  const repairs = useMemo(
    () => suggestRepairs(issues, { definition, configuration: config }),
    [issues, definition, config],
  );

  const applyRepair = (repair: RepairSuggestion) =>
    dispatch({ type: "REPLACE_CONFIG", config: repair.apply(config) });

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

      // Trace silhouettes for uploaded artwork so cut-out designs get real
      // cut geometry (transparent PNGs only; JPEG/full-bleed images stay
      // engrave references). Cached per URL — the same emblem on two panels
      // traces once. Best-effort throughout.
      const contourByUrl = new Map<string, ElementCutContours | null>();
      const cutContours: Record<string, ElementCutContours> = {};
      for (const elements of Object.values(config.surfaces)) {
        for (const el of elements) {
          if (el.type !== "image") continue;
          if (!contourByUrl.has(el.url)) {
            try {
              contourByUrl.set(el.url, await traceImageCutContour(el.url));
            } catch (err) {
              console.error("ForgeIQ: contour trace failed:", err);
              contourByUrl.set(el.url, null);
            }
          }
          const traced = contourByUrl.get(el.url);
          if (traced) cutContours[el.id] = traced;
        }
      }

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
            cutContours,
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

  if (mode === "choosing") {
    return (
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontFamily: "system-ui, sans-serif" }}>
        <ModeCard
          title="Build it myself"
          body="Full control — pick your size and material, then design each panel."
          action="Start designing"
          onClick={() => setMode("manual")}
        />
        <ModeCard
          title="✨ Make it for me"
          body="Answer five quick questions and we'll design three options you can order or keep editing."
          action="Answer a few questions"
          accent
          onClick={() => setMode("assisted")}
        />
      </div>
    );
  }

  if (mode === "assisted") {
    return (
      <ConceptStudio
        apiBase={apiBase}
        definition={definition}
        productDefinitionId={product.id}
        onCancel={() => setMode("manual")}
        onUseConcept={(configuration) => {
          dispatch({ type: "REPLACE_CONFIG", config: configuration });
          setMode("manual");
        }}
      />
    );
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
          repairs={repairs}
          onFocusIssue={(surfaceId, elementId) => {
            if (surfaceId) dispatch({ type: "SET_ACTIVE_SURFACE", surfaceId });
            if (elementId) dispatch({ type: "SELECT_ELEMENT", elementId });
          }}
          onApplyRepair={applyRepair}
          onApplyAllRepairs={() =>
            dispatch({ type: "REPLACE_CONFIG", config: applyRepairs(config, repairs) })
          }
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

function ModeCard(props: {
  title: string;
  body: string;
  action: string;
  accent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      style={{
        flex: "1 1 280px",
        textAlign: "left",
        padding: 20,
        borderRadius: 14,
        border: props.accent ? "2px solid #0f766e" : "1px solid #d4d4d8",
        background: props.accent ? "#f0fdfa" : "#fff",
        cursor: "pointer",
        font: "inherit",
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>{props.title}</div>
      <div style={{ fontSize: 14, color: "#52525b", marginBottom: 14 }}>{props.body}</div>
      <span style={{ fontSize: 14, fontWeight: 700, color: props.accent ? "#0f766e" : "#d97706" }}>
        {props.action} →
      </span>
    </button>
  );
}
