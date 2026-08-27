import { useState } from "react";
import type { ProductConfiguration } from "../../core/schemas/configuration.js";
import type { ProductDefinition } from "../../core/schemas/productDefinition.js";
import type { ConceptBrief } from "../../core/ai/types.js";
import { postConcepts, type ConceptResponse } from "../engineClient.js";

// "Make it for me": five plain questions, three manufacturable concepts, and
// a one-click hand-off into the full builder.

const FIELDS: { key: keyof ConceptBrief; label: string; placeholder: string }[] = [
  { key: "what", label: "What are we making?", placeholder: "A fire pit for my dad" },
  { key: "who", label: "Who is it for?", placeholder: "Retired Navy, last name Thompson" },
  { key: "occasion", label: "What's the occasion?", placeholder: "His 70th birthday" },
  { key: "style", label: "What style do you want?", placeholder: "Rustic, outdoorsy" },
  { key: "mustInclude", label: "Anything that must be included?", placeholder: "His name and Est. 1974" },
];

const input: React.CSSProperties = {
  width: "100%",
  padding: "9px 11px",
  borderRadius: 8,
  border: "1px solid #d4d4d8",
  fontSize: 14,
  fontFamily: "inherit",
};

export function ConceptStudio(props: {
  apiBase: string;
  definition: ProductDefinition;
  productDefinitionId: number;
  onUseConcept: (configuration: ProductConfiguration) => void;
  onCancel: () => void;
}) {
  const [brief, setBrief] = useState<ConceptBrief>({});
  const [result, setResult] = useState<ConceptResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      setResult(await postConcepts(props.apiBase, props.productDefinitionId, brief));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate designs");
    } finally {
      setLoading(false);
    }
  }

  if (result) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
          <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Three ideas for you</h2>
          <button type="button" onClick={() => setResult(null)} style={{ ...ghostButton }}>
            ← Change answers
          </button>
        </div>
        {result.concepts.length === 0 && (
          <p style={{ fontSize: 14, color: "#71717a" }}>
            Nothing we generated could be built as described. Try adding a few more details, or
            design it yourself.
          </p>
        )}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {result.concepts.map((concept) => (
            <div
              key={concept.id}
              style={{
                flex: "1 1 260px",
                border: "1px solid #e4e4e7",
                borderRadius: 12,
                padding: 16,
                background: "#fff",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 700 }}>{concept.name}</div>
              <div style={{ fontSize: 13, color: "#52525b", flexGrow: 1 }}>{concept.rationale}</div>
              <ConceptPreview definition={props.definition} configuration={concept.configuration} />
              <div style={{ fontSize: 20, fontWeight: 800 }}>
                ${concept.price.customerPrice.toFixed(2)}
              </div>
              <button
                type="button"
                onClick={() => props.onUseConcept(concept.configuration)}
                style={{
                  padding: "9px 0",
                  borderRadius: 8,
                  border: "none",
                  background: "#d97706",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                Customize this
              </button>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center" }}>
          <button type="button" onClick={() => void generate()} disabled={loading} style={ghostButton}>
            {loading ? "Thinking…" : "Try another set"}
          </button>
          <button type="button" onClick={props.onCancel} style={ghostButton}>
            Design it myself instead
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 520, fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 4px" }}>Tell us about it</h2>
      <p style={{ fontSize: 14, color: "#52525b", margin: "0 0 16px" }}>
        Answer what you can — we'll design three options you can order or keep editing.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {FIELDS.map((field) => (
          <label key={field.key} style={{ fontSize: 13, fontWeight: 600 }}>
            {field.label}
            <input
              style={{ ...input, marginTop: 4, fontWeight: 400 }}
              placeholder={field.placeholder}
              value={brief[field.key] ?? ""}
              onChange={(e) => setBrief({ ...brief, [field.key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {error && <div style={{ color: "#dc2626", fontSize: 13, marginTop: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button
          type="button"
          onClick={() => void generate()}
          disabled={loading}
          style={{
            padding: "11px 20px",
            borderRadius: 10,
            border: "none",
            background: loading ? "#d4d4d8" : "#0f766e",
            color: "#fff",
            fontWeight: 700,
            fontSize: 15,
            cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading ? "Designing…" : "✨ Generate my designs"}
        </button>
        <button type="button" onClick={props.onCancel} style={ghostButton}>
          Design it myself
        </button>
      </div>
    </div>
  );
}

const ghostButton: React.CSSProperties = {
  padding: "9px 14px",
  borderRadius: 8,
  border: "1px solid #d4d4d8",
  background: "#fff",
  fontSize: 13,
  cursor: "pointer",
};

// Small flat preview of the concept's front panel so the cards show shape,
// not just words.
function ConceptPreview(props: {
  definition: ProductDefinition;
  configuration: ProductConfiguration;
}) {
  const surface = props.definition.surfaces.find((s) => s.editable);
  if (!surface) return null;
  const elements = props.configuration.surfaces[surface.id] ?? [];
  const pxPerIn = 240 / surface.widthIn;
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: `${surface.widthIn} / ${surface.heightIn}`,
        background: "linear-gradient(135deg, #8a4a24 0%, #a35a2a 50%, #6f3818 100%)",
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      {elements.map((el) =>
        el.type === "text" ? (
          <div
            key={el.id}
            style={{
              position: "absolute",
              left: `${(el.xIn / surface.widthIn) * 100}%`,
              top: `${(el.yIn / surface.heightIn) * 100}%`,
              fontSize: el.heightIn * pxPerIn,
              lineHeight: 1,
              fontWeight: 800,
              color: "#fbbf24",
              textShadow: "0 0 6px rgba(251,146,60,0.8)",
              whiteSpace: "nowrap",
            }}
          >
            {el.text}
          </div>
        ) : null,
      )}
    </div>
  );
}
