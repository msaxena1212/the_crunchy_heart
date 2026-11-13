import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BehaviorSubject } from 'rxjs';

import {
  Product,
  ProductVariant
} from './product.model';


/* =========================================================
   CART ITEM
   ========================================================= */

export interface CartItem {

  variantId: string;

  productId: string;

  sku: string;

  productName: string;

  variantName: string;

  flavor: string | null;

  weightGrams: number | null;

  image: string | null;

  unitPrice: number;

  mrp: number;

  quantity: number;

  taxRate: number;

  badge: string | null;

  tone: string;

}


/* =========================================================
   ADD TO CART REQUEST
   ========================================================= */

export interface AddToCartRequest {

  product: Product;

  variant: ProductVariant;

  quantity: number;

}


/* =========================================================
   CART SERVICE
   ========================================================= */

@Injectable({
  providedIn: 'root'
})
export class CartService {

  private readonly platformId = inject(PLATFORM_ID);

  private readonly storageKey =
    'the-crunchy-heart-cart';


  private readonly cartSubject =
    new BehaviorSubject<CartItem[]>(
      this.loadCart()
    );


  readonly cart$ =
    this.cartSubject.asObservable();


  /* =======================================================
     GETTERS
     ======================================================= */

  get items(): CartItem[] {

    return this.cartSubject.value;

  }


  get count(): number {

    return this.items.reduce(
      (
        total,
        item
      ) =>
        total + item.quantity,
      0
    );

  }


  get subtotal(): number {

    return this.items.reduce(
      (
        total,
        item
      ) =>
        total +
        (
          item.unitPrice *
          item.quantity
        ),
      0
    );

  }


  get totalItems(): number {

    return this.items.length;

  }


  /* =======================================================
     ADD PRODUCT

     Existing homepage API.
     ======================================================= */

  addProduct(
    product: Product
  ): void {

    const variant =
      product?.variant;


    if (!variant) {
      return;
    }


    this.addVariantToCart(
      product,
      variant,
      1
    );

  }


  /* =======================================================
     ADD TO CART

     New product-detail API.
     ======================================================= */

  addToCart(
    request: AddToCartRequest
  ): void {

    if (
      !request ||
      !request.product ||
      !request.variant
    ) {

      return;

    }


    this.addVariantToCart(
      request.product,
      request.variant,
      request.quantity
    );

  }


  /* =======================================================
     ADD VARIANT TO CART
     ======================================================= */

  private addVariantToCart(
    product: Product,
    variant: ProductVariant,
    requestedQuantity: number
  ): void {

    const price =
      Number(
        variant.sellingPrice ?? 0
      );


    const availableQuantity =
      Number(
        variant.inventory
          ?.availableQuantity ?? 0
      );


    /*
     * Do not add products that:
     *
     * - have no price
     * - have no inventory
     */

    if (
      price <= 0 ||
      availableQuantity <= 0
    ) {

      return;

    }


    const quantity =
      Math.max(
        1,
        Math.min(
          Number(
            requestedQuantity || 1
          ),
          availableQuantity
        )
      );


    const existingIndex =
      this.items.findIndex(
        item =>
          item.variantId ===
          variant.id
      );


    const updatedItems =
      [...this.items];


    /* =====================================================
       EXISTING ITEM
       ===================================================== */

    if (
      existingIndex >= 0
    ) {

      const existingItem =
        updatedItems[
        existingIndex
        ];


      const nextQuantity =
        Math.min(
          existingItem.quantity +
          quantity,
          availableQuantity
        );


      updatedItems[
        existingIndex
      ] = {

        ...existingItem,

        quantity:
          nextQuantity

      };

    }


    /* =====================================================
       NEW ITEM
       ===================================================== */

    else {

      updatedItems.push({

        variantId:
          variant.id,

        productId:
          product.id,

        sku:
          variant.sku,

        productName:
          product.name,

        variantName:
          variant.name,

        flavor:
          variant.flavor,

        weightGrams:
          variant.weightGrams,

        image:
          product.imageUrl ??
          this.getVariantImage(
            variant
          ),

        unitPrice:
          price,

        mrp:
          Number(
            variant.mrp ?? 0
          ),

        quantity,

        taxRate:
          Number(
            variant.taxRate ?? 0
          ),

        badge:
          variant.badge,

        tone:
          variant.tone

      });

    }


    this.saveCart(
      updatedItems
    );

  }


  /* =======================================================
     INCREASE QUANTITY
     ======================================================= */

  increaseQuantity(
    variantId: string
  ): void {

    const updatedItems =
      this.items.map(
        item => {

          if (
            item.variantId !==
            variantId
          ) {

            return item;

          }


          return {

            ...item,

            quantity:
              item.quantity + 1

          };

        }
      );


    this.saveCart(
      updatedItems
    );

  }


  /* =======================================================
     DECREASE QUANTITY
     ======================================================= */

  decreaseQuantity(
    variantId: string
  ): void {

    const updatedItems =
      this.items

        .map(
          item => {

            if (
              item.variantId !==
              variantId
            ) {

              return item;

            }


            return {

              ...item,

              quantity:
                item.quantity - 1

            };

          }
        )

        .filter(
          item =>
            item.quantity > 0
        );


    this.saveCart(
      updatedItems
    );

  }


  /* =======================================================
     REMOVE ITEM
     ======================================================= */

  removeItem(
    variantId: string
  ): void {

    const updatedItems =
      this.items.filter(
        item =>
          item.variantId !==
          variantId
      );


    this.saveCart(
      updatedItems
    );

  }


  /* =======================================================
     BACKWARD COMPATIBILITY

     Allows existing homepage code to call
     removeFromCart().
     ======================================================= */

  removeFromCart(
    variantId: string
  ): void {

    this.removeItem(
      variantId
    );

  }


  /* =======================================================
     CLEAR CART
     ======================================================= */

  clearCart(): void {

    this.saveCart([]);

  }


  /* =======================================================
     CART RECOVERY SNAPSHOT (P1 RESILIENCE)
     ======================================================= */

  private readonly recoveryStorageKey =
    'the-crunchy-heart-cart-recovery';


  /**
   * Save a recoverable cart snapshot before checkout clearance.
   * Expires after 24 hours. Does not automatically recreate an order.
   */
  saveCartSnapshot(orderNumber?: string): void {
    if (!isPlatformBrowser(this.platformId) || !this.items.length) {
      return;
    }

    try {
      const snapshot = {
        orderNumber: orderNumber || null,
        items: this.items,
        savedAt: Date.now(),
      };

      localStorage.setItem(
        this.recoveryStorageKey,
        JSON.stringify(snapshot)
      );
    } catch (error) {
      console.warn('Unable to save cart recovery snapshot:', error);
    }
  }


  /**
   * Retrieve active cart recovery snapshot, enforcing 24-hour expiration.
   */
  getCartSnapshot(): { orderNumber: string | null; items: CartItem[]; savedAt: number } | null {
    if (!isPlatformBrowser(this.platformId)) {
      return null;
    }

    try {
      const stored = localStorage.getItem(this.recoveryStorageKey);
      if (!stored) {
        return null;
      }

      const parsed = JSON.parse(stored);
      if (!parsed || !Array.isArray(parsed.items) || !parsed.items.length) {
        return null;
      }

      // Expire after 24 hours
      const MAX_AGE_MS = 24 * 60 * 60 * 1000;
      if (Date.now() - Number(parsed.savedAt || 0) > MAX_AGE_MS) {
        this.clearCartSnapshot();
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }


  /**
   * Check whether a valid recovery snapshot is available.
   */
  hasCartSnapshot(): boolean {
    return this.getCartSnapshot() !== null;
  }


  /**
   * Restore cart items from the recovery snapshot.
   *
   * @param mode 'replace' (default when active cart is empty) or 'merge' (combines quantities)
   * If active cart is non-empty and mode is 'replace', caller must explicitly confirm.
   */
  restoreCartSnapshot(mode: 'replace' | 'merge' = 'replace'): boolean {
    const snapshot = this.getCartSnapshot();
    if (!snapshot || !snapshot.items.length) {
      return false;
    }

    if (this.items.length === 0 || mode === 'replace') {
      this.saveCart(snapshot.items);
      return true;
    }

    if (mode === 'merge') {
      const mergedMap = new Map<string, CartItem>();
      for (const item of this.items) {
        mergedMap.set(item.variantId, { ...item });
      }
      for (const item of snapshot.items) {
        if (mergedMap.has(item.variantId)) {
          mergedMap.get(item.variantId)!.quantity += item.quantity;
        } else {
          mergedMap.set(item.variantId, { ...item });
        }
      }
      this.saveCart(Array.from(mergedMap.values()));
      return true;
    }

    return false;
  }


  /**
   * Clear the recovery snapshot once an order is confirmed or customer dismisses it.
   */
  clearCartSnapshot(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    try {
      localStorage.removeItem(this.recoveryStorageKey);
    } catch {}
  }


  /* =======================================================
     GET ITEM QUANTITY
     ======================================================= */

  getItemQuantity(
    variantId: string
  ): number {

    const item =
      this.items.find(
        cartItem =>
          cartItem.variantId ===
          variantId
      );


    return (
      item?.quantity ?? 0
    );

  }


  /* =======================================================
     SAVE CART
     ======================================================= */

  private saveCart(
    items: CartItem[]
  ): void {

    if (isPlatformBrowser(this.platformId)) {
      try {
        localStorage.setItem(
          this.storageKey,
          JSON.stringify(items)
        );
      } catch (error) {
        console.error(
          'Unable to save cart:',
          error
        );
      }
    }

    this.cartSubject.next(
      items
    );

  }


  /* =======================================================
     LOAD CART
     ======================================================= */

  private loadCart(): CartItem[] {

    if (!isPlatformBrowser(this.platformId)) {
      return [];
    }

    try {

      const stored =
        localStorage.getItem(
          this.storageKey
        );


      if (!stored) {

        return [];

      }


      const parsed =
        JSON.parse(
          stored
        );


      if (
        !Array.isArray(
          parsed
        )
      ) {

        return [];

      }


      return parsed;

    }

    catch (error) {

      console.error(
        'Unable to load cart:',
        error
      );


      return [];

    }

  }


  /* =======================================================
     PRODUCT IMAGE MAPPING
     ======================================================= */

  private getProductImage(
    product: Product
  ): string | null {

    if (
      !product?.variant
    ) {

      return null;

    }


    return this.getVariantImage(
      product.variant
    );

  }


  /* =======================================================
     VARIANT IMAGE MAPPING
     ======================================================= */

  private getVariantImage(
    variant: ProductVariant
  ): string | null {

    const sku =
      variant?.sku;


    const imageMap:
      Record<string, string> = {

      /* ---------------------------------------------------
         RAW MAKHANA
         --------------------------------------------------- */

      'TCH-RAW-100':
        'assets/raw-makhana-100g.webp',

      'TCH-RAW-200':
        'assets/raw-makhana-200g.webp',

      'TCH-RAW-500':
        'assets/raw-makhana-500g.webp',

      'TCH-RAW-1KG':
        'assets/raw-makhana-1kg.webp',


      /* ---------------------------------------------------
         FLAVOURED MAKHANA
         --------------------------------------------------- */

      'TCH-FLV-HIMALAYAN':
        'assets/himalayan-salt.webp',

      'TCH-FLV-PERI':
        'assets/peri-peri.webp',

      'TCH-FLV-ONION':
        'assets/cream-onion.webp',

      'TCH-FLV-TOMATO':
        'assets/tomato-tangy.webp',

      'TCH-FLV-CHILLI':
        'assets/chilli-garlic.webp',

      'TCH-FLV-PUDINA':
        'assets/pudina.webp',

      'TCH-FLV-BIHARI':
        'assets/bihari-chat.webp'

    };


    return (
      imageMap[sku] ??
      null
    );

  }

}