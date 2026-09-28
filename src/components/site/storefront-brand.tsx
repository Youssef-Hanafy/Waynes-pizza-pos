"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { BrandNames } from "@/lib/content/schemas";

/**
 * Brand names for client-side storefront copy, resolved on the server from the
 * request host (never a module-level global, which a server would share
 * between businesses' requests).
 */
export type StorefrontClientContext = BrandNames & { services: readonly string[]; city: string; state: string };

const StorefrontBrandContext = createContext<StorefrontClientContext>({ storeName: "Our store", brandName: "Our store", shortName: "Our store", rewardsName: "Rewards", services: [], city: "", state: "" });

export function StorefrontBrandProvider({ brand, children }: { brand: StorefrontClientContext; children: ReactNode }) {
  return <StorefrontBrandContext.Provider value={brand}>{children}</StorefrontBrandContext.Provider>;
}

export function useStorefrontBrand() {
  return useContext(StorefrontBrandContext);
}
