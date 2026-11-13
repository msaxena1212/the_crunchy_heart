export interface ProductCategory {
  name: string;
  slug: string;
}

export interface ProductInventory {
  quantityOnHand: number;
  reservedQuantity: number;
  availableQuantity: number;
}

export interface ProductVariant {
  id: string;
  sku: string;
  name: string;
  weightGrams: number | null;
  flavor: string | null;
  mrp: number;
  sellingPrice: number;
  taxRate: number;
  badge: string | null;
  tone: string;
  inventory: ProductInventory;
}

export interface ProductSubcategory {
  name: string;
  slug: string;
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  shortDescription: string | null;
  brand: string;
  featured: boolean;
  /** Primary product image (an assets/... path or https URL). Managed in the owner console. */
  imageUrl?: string | null;
  /** Product family inside a category, e.g. Almonds or Whole Spices. */
  subcategory?: ProductSubcategory | null;
  category: ProductCategory;
  variant: ProductVariant;
  variants?: ProductVariant[];
}