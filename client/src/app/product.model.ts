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

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  shortDescription: string | null;
  brand: string;
  featured: boolean;
  category: ProductCategory;
  variant: ProductVariant;
  variants?: ProductVariant[];
}