import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';


/* =========================================================
   ORDER MODELS
   ========================================================= */

export interface ShippingAddress {
  line1: string;
  line2: string;
  landmark: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface CreateOrderRequest {
  customerName: string;
  phone: string;
  email: string;
  shippingAddress: ShippingAddress;
  notes: string;
  items: {
    variantId: string;
    quantity: number;
  }[];
}

export interface PlacedOrder {
  id: string;
  orderNumber: string;
  subtotal: number;
  discountAmount: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  currency: string;
  status: string;
  paymentStatus: string;
  createdAt: string;
}


/* =========================================================
   ORDER SERVICE
   ========================================================= */

@Injectable({
  providedIn: 'root'
})
export class OrderService {

  private readonly http =
    inject(HttpClient);


  private readonly api =
    '/api';


  createOrder(
    request: CreateOrderRequest
  ): Observable<PlacedOrder> {

    return this.http
      .post<{ success: boolean; order: PlacedOrder }>(
        `${this.api}/orders`,
        request
      )
      .pipe(
        map(response => response.order)
      );

  }

}
