import type { ProductConfiguration } from "../core/schemas/configuration.js";
import type { PublicPriceBreakdown } from "../core/pricing/pricingEngine.js";
import type { ValidationResult } from "../core/validation/types.js";
import type { ProductResponse } from "./types.js";

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

export interface ConceptResponse {
  provider: string;
  productDefinitionId: number;
  concepts: {
    id: string;
    name: string;
    rationale: string;
    configuration: ProductConfiguration;
    price: PublicPriceBreakdown;
    validation: ValidationResult;
    repairsApplied: string[];
  }[];
  rejected: { name: string; reason: string }[];
}

export function postConcepts(
  apiBase: string,
  productDefinitionId: number,
  brief: Record<string, string | undefined>,
) {
  return fetch(`${apiBase}/concepts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productDefinitionId, brief }),
  }).then((r) => json<ConceptResponse>(r));
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
