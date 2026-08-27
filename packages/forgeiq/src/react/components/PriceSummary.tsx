// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { PublicPriceBreakdown } from "../../core/pricing/pricingEngine.js";

export function PriceSummary(props: {
  price: PublicPriceBreakdown | undefined;
  quantity: number;
  canOrder: boolean;
  saving: boolean;
  onQuantityChange: (q: number) => void;
  onAddToCart: () => void;
}) {
  const p = props.price;
  return (
    <div style={{ border: "1px solid #e4e4e7", borderRadius: 12, padding: 16, background: "#fafafa" }}>
      {p ? (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
            {p.lines.map((line, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#3f3f46" }}>
                <span>{line.label}</span>
                <span>{line.amount < 0 ? "−" : ""}${Math.abs(line.amount).toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #e4e4e7", paddingTop: 10 }}>
            <label style={{ fontSize: 13 }}>
              Qty{" "}
              <input
                type="number"
                min={1}
                value={props.quantity}
                onChange={(e) => props.onQuantityChange(Number(e.target.value) || 1)}
                style={{ width: 56, padding: "5px 6px", border: "1px solid #d4d4d8", borderRadius: 6 }}
              />
            </label>
            <div style={{ fontSize: 22, fontWeight: 800 }}>${p.customerPrice.toFixed(2)}</div>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 13, color: "#71717a" }}>Calculating price…</div>
      )}
      <button
        type="button"
        disabled={!props.canOrder || props.saving}
        onClick={props.onAddToCart}
        style={{
          marginTop: 12,
          width: "100%",
          padding: "11px 0",
          borderRadius: 10,
          border: "none",
          fontSize: 15,
          fontWeight: 700,
          cursor: props.canOrder && !props.saving ? "pointer" : "not-allowed",
          background: props.canOrder && !props.saving ? "#d97706" : "#d4d4d8",
          color: "#fff",
        }}
      >
        {props.saving ? "Saving…" : props.canOrder ? "Add to Cart" : "Fix issues to continue"}
      </button>
    </div>
  );
}
