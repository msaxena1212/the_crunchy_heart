import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';

import {
  Product,
  ProductVariant
} from './product.model';


/* =========================================================
   PRODUCT DETAIL RESPONSE
   ========================================================= */

export interface ProductDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  shortDescription: string | null;
  brand: string;
  featured: boolean;
  imageUrl?: string | null;
  subcategory?: { name: string; slug: string } | null;

  category: {
    name: string;
    slug: string;
  };

  variants: ProductVariant[];
}


export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined' && (window as any).__API_BASE_URL__) {
    return (window as any).__API_BASE_URL__;
  }
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
      return 'http://localhost:5000/api';
    }
  }
  return '/api';
}

/* =========================================================
   PRODUCT SERVICE
   ========================================================= */

@Injectable({
  providedIn: 'root'
})
export class ProductService {

  private readonly http =
    inject(HttpClient);


  private readonly api = getApiBaseUrl();


  /* =======================================================
     GET PRODUCTS
     ======================================================= */

  getProducts(
    options?: {
      category?: string;
      featured?: boolean;
    }
  ): Observable<Product[]> {

    let params =
      new HttpParams();


    if (options?.category) {

      params =
        params.set(
          'category',
          options.category
        );

    }


    if (
      options?.featured !== undefined
    ) {

      params =
        params.set(
          'featured',
          String(
            options.featured
          )
        );

    }


    return this.http.get<Product[]>(
      `${this.api}/products`,
      { params }
    );

  }


  /* =======================================================
     GET PRODUCT BY SLUG
     ======================================================= */

  getProduct(
    slug: string
  ): Observable<ProductDetail> {

    return this.http.get<ProductDetail>(
      `${this.api}/products/${slug}`
    );

  }


  /* =======================================================
     GET PRODUCT BY SLUG â€” FRONTEND MODEL

     This converts the backend ProductDetail response
     into the Product model already used throughout
     the Angular application.
     ======================================================= */

  getProductBySlug(
    slug: string
  ): Observable<Product> {

    return this.getProduct(slug).pipe(

      map(
        (
          detail: ProductDetail
        ): Product => {

          const variants =
            detail.variants ?? [];


          const firstVariant =
            variants[0];


          return {

            id:
              detail.id,

            name:
              detail.name,

            slug:
              detail.slug,

            description:
              detail.description,

            shortDescription:
              detail.shortDescription,

            brand:
              detail.brand,

            featured:
              detail.featured,

            imageUrl:
              detail.imageUrl ?? null,

            subcategory:
              detail.subcategory ?? null,

            category:
              detail.category,

            variant:
              firstVariant,

            variants

          };

        }
      )

    );

  }

}
