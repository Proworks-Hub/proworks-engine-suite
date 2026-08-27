import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ProductConfiguration } from "../core/schemas/configuration";
import { postPrice, postValidate } from "./engineClient";

// Debounced server-side price + validation. The queries share the debounced
// config as their key, so both refresh together and stale results never mix.
export function usePriceAndValidation(
  apiBase: string,
  productDefinitionId: number | undefined,
  config: ProductConfiguration,
) {
  const [debounced, setDebounced] = useState(config);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(config), 400);
    return () => clearTimeout(t);
  }, [config]);

  const enabled = productDefinitionId !== undefined;
  const key = JSON.stringify(debounced);

  const price = useQuery({
    queryKey: ["forgeiq-price", productDefinitionId, key],
    queryFn: () => postPrice(apiBase, productDefinitionId!, debounced),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const validation = useQuery({
    queryKey: ["forgeiq-validate", productDefinitionId, key],
    queryFn: () => postValidate(apiBase, productDefinitionId!, debounced),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  return { price, validation };
}
