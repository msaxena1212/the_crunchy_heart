import { Injectable } from '@angular/core';
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

    try {

      localStorage.setItem(
        this.storageKey,
        JSON.stringify(items)
      );

    }

    catch (error) {

      console.error(
        'Unable to save cart:',
        error
      );

    }


    this.cartSubject.next(
      items
    );

  }


  /* =======================================================
     LOAD CART
     ======================================================= */

  private loadCart(): CartItem[] {

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
        'assets/raw-makhana-100g.png',

      'TCH-RAW-200':
        'assets/raw-makhana-200g.png',

      'TCH-RAW-500':
        'assets/raw-makhana-500g.png',

      'TCH-RAW-1KG':
        'assets/raw-makhana-1kg.png',


      /* ---------------------------------------------------
         FLAVOURED MAKHANA
         --------------------------------------------------- */

      'TCH-FLV-HIMALAYAN':
        'assets/himalayan-salt.png',

      'TCH-FLV-PERI':
        'assets/peri-peri.png',

      'TCH-FLV-ONION':
        'assets/cream-onion.png',

      'TCH-FLV-TOMATO':
        'assets/tomato-tangy.png',

      'TCH-FLV-CHILLI':
        'assets/chilli-garlic.png',

      'TCH-FLV-PUDINA':
        'assets/pudina.png',

      'TCH-FLV-BIHARI':
        'assets/bihari-chat.png'

    };


    return (
      imageMap[sku] ??
      null
    );

  }

}