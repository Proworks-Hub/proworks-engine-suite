import type { ProductConfiguration } from "../core/schemas/configuration";
import type { PublicPriceBreakdown } from "../core/pricing/pricingEngine";
import type { ValidationResult } from "../core/validation/types";
import type { ProductResponse } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.message) message = body.message;
    } catch {
      // non-JSON error body — keep the status message
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export function fetchProduct(apiBase: string, slug: string) {
  return fetch(`${apiBase}/products/${slug}`).then((r) => json<ProductResponse>(r));
}

export function postPrice(
  apiBase: string,
  productDefinitionId: number,
  config: ProductConfiguration,
) {
  return fetch(`${apiBase}/price`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productDefinitionId, config }),
  }).then((r) => json<PublicPriceBreakdown>(r));
}

export function postValidate(
  apiBase: string,
  productDefinitionId: number,
  config: ProductConfiguration,
) {
  return fetch(`${apiBase}/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productDefinitionId, config }),
  }).then((r) => json<ValidationResult>(r));
}

export interface SaveConfigurationResponse {
  id: number;
  customerPrice: number;
  price: PublicPriceBreakdown;
  validation: ValidationResult;
}

export function postConfiguration(
  apiBase: string,
  productDefinitionId: number,
  config: ProductConfiguration,
) {
  return fetch(`${apiBase}/configurations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productDefinitionId, config }),
  }).then((r) => json<SaveConfigurationResponse>(r));
}
