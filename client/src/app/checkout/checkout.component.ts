import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CartService, CartItem } from '../cart.service';
import { CheckoutService, CheckoutPreviewResponse, CreateOrderRequest } from '../checkout.service';

@Component({
  selector: 'tch-checkout',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, RouterLink],
  templateUrl: './checkout.component.html',
  styleUrls: ['./checkout.component.css']
})
export class CheckoutComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly cartService = inject(CartService);
  private readonly checkoutService = inject(CheckoutService);

  cartItems: CartItem[] = [];
  preview: CheckoutPreviewResponse | null = null;

  isLoadingPreview = true;
  isSubmitting = false;
  errorMessage = '';
  validationErrors: string[] = [];

  // Idempotency key for the current order content. It changes only when the content
  // changes, so a retry of the same request reuses it, and a changed cart never
  // reuses the key of an earlier, different order.
  idempotencyKey = '';
  private idempotencyContent = '';

  checkoutForm: FormGroup = this.fb.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(100)]],
    phone: ['', [Validators.required, Validators.pattern(/^[6-9]\d{9}$/)]],
    email: ['', [Validators.email]],
    addressLine1: ['', [Validators.required, Validators.minLength(5), Validators.maxLength(200)]],
    addressLine2: ['', [Validators.maxLength(200)]],
    landmark: ['', [Validators.maxLength(100)]],
    city: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(100)]],
    state: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(100)]],
    pincode: ['', [Validators.required, Validators.pattern(/^\d{6}$/)]],
    paymentMethod: ['ONLINE', [Validators.required]],
    notes: ['', [Validators.maxLength(500)]]
  });

  indianStates: string[] = [
    'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
    'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
    'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
    'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
    'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
    'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Puducherry', 'Chandigarh'
  ];

  /**
   * Returns the idempotency key for the current order content. A new key is generated
   * only when the order-determining content differs from the last submission, so a
   * retry of the same request reuses its key, while a changed cart or address never
   * reuses the key of a different order.
   */
  private resolveIdempotencyKey(formVal: any): string {
    const content = JSON.stringify({
      customer: {
        name: formVal.name?.trim(),
        phone: formVal.phone?.trim(),
        email: formVal.email?.trim() || null
      },
      shipping: {
        addressLine1: formVal.addressLine1?.trim(),
        addressLine2: formVal.addressLine2?.trim() || null,
        landmark: formVal.landmark?.trim() || null,
        city: formVal.city?.trim(),
        state: formVal.state?.trim(),
        pincode: formVal.pincode?.trim()
      },
      paymentMethod: formVal.paymentMethod,
      notes: formVal.notes?.trim() || null,
      items: this.cartItems
        .map(item => ({ variantId: item.variantId, quantity: item.quantity }))
        .sort((a, b) => String(a.variantId).localeCompare(String(b.variantId)))
    });

    if (content !== this.idempotencyContent) {
      this.idempotencyKey = this.checkoutService.generateIdempotencyKey();
      this.idempotencyContent = content;
    }

    return this.idempotencyKey;
  }

  ngOnInit(): void {
    this.idempotencyKey = this.checkoutService.generateIdempotencyKey();
    this.cartItems = this.cartService.items;

    if (!this.cartItems.length) {
      this.isLoadingPreview = false;
      return;
    }

    this.loadPreview();
  }

  loadPreview(): void {
    this.isLoadingPreview = true;
    this.errorMessage = '';

    const previewItems = this.cartItems.map(item => ({
      variantId: item.variantId,
      quantity: item.quantity
    }));

    this.checkoutService.previewCheckout(previewItems).subscribe({
      next: (res) => {
        this.preview = res;
        this.isLoadingPreview = false;
      },
      error: (err) => {
        this.isLoadingPreview = false;
        this.errorMessage = err.error?.message || 'Unable to calculate server order preview. Please review your cart.';
      }
    });
  }

  onSubmit(): void {
    this.errorMessage = '';
    this.validationErrors = [];

    if (this.checkoutForm.invalid) {
      this.checkoutForm.markAllAsTouched();
      this.collectValidationErrors();
      return;
    }

    if (!this.cartItems.length) {
      this.errorMessage = 'Your cart is empty.';
      return;
    }

    if (this.isSubmitting) {
      return;
    }

    this.isSubmitting = true;

    const formVal = this.checkoutForm.value;
    const orderPayload: CreateOrderRequest = {
      customer: {
        name: formVal.name.trim(),
        phone: formVal.phone.trim(),
        email: formVal.email ? formVal.email.trim() : undefined
      },
      shippingAddress: {
        name: formVal.name.trim(),
        phone: formVal.phone.trim(),
        addressLine1: formVal.addressLine1.trim(),
        addressLine2: formVal.addressLine2 ? formVal.addressLine2.trim() : undefined,
        landmark: formVal.landmark ? formVal.landmark.trim() : undefined,
        city: formVal.city.trim(),
        state: formVal.state.trim(),
        pincode: formVal.pincode.trim(),
        country: 'India'
      },
      billingAddress: {
        name: formVal.name.trim(),
        phone: formVal.phone.trim(),
        addressLine1: formVal.addressLine1.trim(),
        city: formVal.city.trim(),
        state: formVal.state.trim(),
        pincode: formVal.pincode.trim(),
        country: 'India'
      },
      items: this.cartItems.map(item => ({
        variantId: item.variantId,
        quantity: item.quantity
      })),
      paymentMethod: formVal.paymentMethod,
      notes: formVal.notes ? formVal.notes.trim() : undefined,
      idempotencyKey: this.resolveIdempotencyKey(formVal)
    };

    this.checkoutService.createOrder(orderPayload).subscribe({
      next: async (res) => {
        const orderNumber = res.order.order_number;
        const guestToken = res.guestAccessToken;

        // Persist guest token securely with server-side expiry
        if (guestToken) {
          this.checkoutService.saveGuestToken(orderNumber, guestToken);
        }

        // Save a recoverable snapshot BEFORE clearing active cart
        this.cartService.saveCartSnapshot(orderNumber);

        // Check if gateway timeout occurred during initial order creation (HTTP 202)
        if ((res as any).code === 'GATEWAY_AMBIGUOUS_TIMEOUT' || (res as any).gatewayStatus === 'GATEWAY_AMBIGUOUS_TIMEOUT') {
          this.isSubmitting = false;
          this.router.navigate(['/orders', orderNumber]);
          return;
        }

        if (formVal.paymentMethod === 'COD') {
          // COD: clear active cart only after order confirmed and token persisted
          this.cartService.clearCart();
          this.router.navigate(['/orders', orderNumber]);
          return;
        }

        // ONLINE PAYMENT:
        if (res.cashfree?.paymentSessionId) {
          try {
            // Launch Cashfree SDK
            await this.checkoutService.launchCashfreePayment(res.cashfree.paymentSessionId);
            // Clear active cart as gateway takes over
            this.cartService.clearCart();
          } catch (sdkError: any) {
            console.error('Cashfree launch error:', sdkError);
            this.isSubmitting = false;
            // Preserving active cart because SDK launch failed
            // Fall back to order confirmation status page with retry action
            this.router.navigate(['/orders', orderNumber]);
          }
        } else {
          this.cartService.clearCart();
          this.router.navigate(['/orders', orderNumber]);
        }
      },
      error: (err) => {
        this.isSubmitting = false;

        // Check if ambiguous timeout response returned recoverable order and guest token
        if (err.status === 202 || err.error?.code === 'GATEWAY_AMBIGUOUS_TIMEOUT') {
          const orderNumber = err.error?.order?.order_number;
          const guestToken = err.error?.guestAccessToken;
          if (orderNumber && guestToken) {
            this.checkoutService.saveGuestToken(orderNumber, guestToken);
            this.cartService.saveCartSnapshot(orderNumber);
            this.router.navigate(['/orders', orderNumber]);
            return;
          }
        }

        if (err.status === 409 && err.error?.code === 'IDEMPOTENCY_REPLAY_UNAUTHORIZED') {
          this.errorMessage = 'A checkout attempt with this request has already been recorded. Please check your order status or contact support.';
          return;
        }

        if (err.status === 504 || err.status === 502) {
          this.errorMessage = 'The payment gateway is verifying your request (timeout). Please do not place a duplicate order. Check your order status.';
          return;
        }

        this.errorMessage = err.error?.message || 'Failed to place order. Please review your details and try again.';
      }
    });
  }

  private collectValidationErrors(): void {
    const f = this.checkoutForm.controls;
    if (f['name'].errors) this.validationErrors.push('Please enter a valid full name (minimum 2 characters).');
    if (f['phone'].errors) this.validationErrors.push('Please enter a valid 10-digit Indian mobile number (starts with 6-9).');
    if (f['email'].errors) this.validationErrors.push('Please enter a valid email address.');
    if (f['addressLine1'].errors) this.validationErrors.push('Please enter a valid delivery address (minimum 5 characters).');
    if (f['city'].errors) this.validationErrors.push('Please enter your city.');
    if (f['state'].errors) this.validationErrors.push('Please select or enter your state.');
    if (f['pincode'].errors) this.validationErrors.push('Please enter a valid 6-digit Indian PIN code.');
  }
}
