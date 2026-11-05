import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CheckoutService, OrderDetailsResponse, PaymentStatusResponse } from '../checkout.service';
import { CartService } from '../cart.service';

@Component({
  selector: 'tch-order-confirmation',
  standalone: true,
  imports: [CommonModule, RouterLink, FormsModule],
  templateUrl: './order-confirmation.component.html',
  styleUrls: ['./order-confirmation.component.css']
})
export class OrderConfirmationComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly checkoutService = inject(CheckoutService);
  readonly cartService = inject(CartService);

  orderNumber: string = '';
  guestToken: string | null = null;

  orderDetails: OrderDetailsResponse | null = null;
  paymentStatus: PaymentStatusResponse | null = null;

  isLoading = true;
  isRetrying = false;
  isTokenMissing = false;
  errorMessage = '';
  retryErrorMessage = '';
  cartRestoredMessage = '';

  ngOnInit(): void {
    // Read orderNumber from route param or query params
    const routeParam = this.route.snapshot.paramMap.get('orderNumber');
    const queryParam = this.route.snapshot.queryParamMap.get('order_id') ||
                       this.route.snapshot.queryParamMap.get('orderNumber');

    this.orderNumber = (routeParam || queryParam || '').trim();

    if (!this.orderNumber) {
      this.isLoading = false;
      this.errorMessage = 'No order reference provided in request.';
      return;
    }

    this.guestToken = this.checkoutService.getGuestToken(this.orderNumber);

    if (!this.guestToken) {
      this.isLoading = false;
      this.isTokenMissing = true;
      return;
    }

    this.loadOrderData();
  }

  loadOrderData(): void {
    if (!this.orderNumber || !this.guestToken) {
      return;
    }

    this.isLoading = true;
    this.errorMessage = '';
    this.retryErrorMessage = '';

    // Fetch order details with guest token
    this.checkoutService.getOrderDetails(this.orderNumber, this.guestToken).subscribe({
      next: (details) => {
        this.orderDetails = details;
        this.isLoading = false;
        this.isTokenMissing = false;

        // Also fetch live payment status if ONLINE payment
        if (details.order.paymentMethod === 'ONLINE') {
          this.fetchPaymentStatus();
        }
      },
      error: (err) => {
        this.isLoading = false;
        if (err.status === 401) {
          this.isTokenMissing = true;
          this.errorMessage = 'Access denied. The guest token is either missing, invalid, or expired for this order.';
        } else if (err.status === 404) {
          this.errorMessage = `Order ${this.orderNumber} was not found.`;
        } else {
          this.errorMessage = err.error?.message || 'Unable to retrieve order details. Please check your network connection.';
        }
      }
    });
  }

  fetchPaymentStatus(): void {
    if (!this.orderNumber || !this.guestToken) return;

    this.checkoutService.getPaymentStatus(this.orderNumber, this.guestToken).subscribe({
      next: (status) => {
        this.paymentStatus = status;
      },
      error: (err) => {
        console.warn('Could not refresh payment status:', err);
      }
    });
  }

  onRetryPayment(): void {
    if (!this.orderNumber || !this.guestToken || this.isRetrying) {
      return;
    }

    this.isRetrying = true;
    this.retryErrorMessage = '';

    const retryIdempotencyKey = this.checkoutService.generateIdempotencyKey();

    this.checkoutService.retryPayment(this.orderNumber, this.guestToken, retryIdempotencyKey).subscribe({
      next: async (res) => {
        this.isRetrying = false;
        if (res.cashfree?.paymentSessionId) {
          try {
            await this.checkoutService.launchCashfreePayment(res.cashfree.paymentSessionId);
          } catch (sdkError: any) {
            this.retryErrorMessage = 'Could not launch payment gateway. Please refresh and try again.';
          }
        } else {
          this.loadOrderData();
        }
      },
      error: (err) => {
        this.isRetrying = false;
        if (err.status === 409) {
          this.retryErrorMessage = err.error?.message || 'Payment retry cannot be initiated because an earlier attempt is still being verified.';
        } else {
          this.retryErrorMessage = err.error?.message || 'Failed to initialize payment retry. Please try again.';
        }
      }
    });
  }

  /* =======================================================
     CART RECOVERY HELPER
     ======================================================= */

  hasCartRecovery(): boolean {
    return this.cartService.hasCartSnapshot();
  }

  restoreCart(): void {
    const success = this.cartService.restoreCartSnapshot(
      this.cartService.items.length === 0 ? 'replace' : 'merge'
    );
    if (success) {
      this.cartRestoredMessage = 'Your previous cart items have been restored!';
    }
  }

  /* =======================================================
     STATUS STATE DETECTORS
     ======================================================= */

  isStockShortage(): boolean {
    if (!this.orderDetails) return false;
    return this.orderDetails.order.status === 'exception_stock_shortage' ||
           this.orderDetails.payment?.gatewayStatus === 'PAID_STOCK_UNAVAILABLE';
  }

  isDuplicatePaymentSettled(): boolean {
    if (!this.orderDetails) return false;
    return this.orderDetails.payment?.gatewayStatus === 'PAID_DUPLICATE_ORDER_SETTLED';
  }

  isAmbiguousTimeout(): boolean {
    if (!this.orderDetails) return false;
    const gw = this.orderDetails.payment?.gatewayStatus;
    return gw === 'GATEWAY_AMBIGUOUS_TIMEOUT' || gw === 'SETTLEMENT_AMBIGUOUS';
  }

  /* =======================================================
     DISPLAY BADGES, TITLES & NARRATIVES (PRECEDENCE-ENFORCED)
     ======================================================= */

  getStatusBadgeClass(): string {
    if (!this.orderDetails) return 'badge-neutral';

    // 1. Exceptions and Ambiguous states get warning badges
    if (this.isStockShortage() || this.isDuplicatePaymentSettled() || this.isAmbiguousTimeout()) {
      return 'badge-warning';
    }

    const status = this.orderDetails.order.status;
    const paymentStatus = this.orderDetails.order.paymentStatus;

    // 2. Normal confirmed / paid orders
    if (status === 'confirmed' || status === 'paid' || paymentStatus === 'paid') {
      return 'badge-success';
    }

    // 3. Failed orders
    if (status === 'failed' || paymentStatus === 'failed') {
      return 'badge-danger';
    }

    return 'badge-info';
  }

  getStatusDisplayTitle(): string {
    if (!this.orderDetails) return 'Order Status';
    const order = this.orderDetails.order;

    // Precedence 1: Stock Shortage Exception
    if (this.isStockShortage()) {
      return 'Payment Received — Stock Shortage Review';
    }

    // Precedence 2: Duplicate Payment Attempt Captured
    if (this.isDuplicatePaymentSettled()) {
      return 'Payment Received (Duplicate Attempt)';
    }

    // Precedence 3: Ambiguous Gateway Verification
    if (this.isAmbiguousTimeout()) {
      return 'Payment Verification in Progress';
    }

    // Precedence 4: Cash on Delivery Confirmed
    if (order.paymentMethod === 'COD') {
      return 'Order Confirmed (Cash on Delivery)';
    }

    // Precedence 5: Standard Online Paid & Confirmed
    if (order.paymentStatus === 'paid' || order.status === 'paid' || order.status === 'confirmed') {
      return 'Payment Successful & Order Confirmed';
    }

    // Precedence 6: Payment Failed
    if (order.paymentStatus === 'failed' || order.status === 'failed') {
      return 'Payment Incomplete / Failed';
    }

    return 'Order Placed (Payment Pending)';
  }

  getStatusMessage(): string {
    if (!this.orderDetails) return '';
    const order = this.orderDetails.order;

    // Precedence 1: Stock shortage message
    if (this.isStockShortage()) {
      let msg = `Your payment of ₹${order.totalAmount} was safely received. However, because requested stock was exhausted by a concurrent order right before confirmation, this order cannot be fulfilled as placed.`;
      if (this.orderDetails.refund && this.orderDetails.refund.status === 'pending') {
        msg += ` A pending refund record of ₹${this.orderDetails.refund.amount} has been queued for review by our operations team.`;
      } else {
        msg += ' Our customer care team is reviewing your order to process a full refund or provide an alternative item.';
      }
      return msg;
    }

    // Precedence 2: Duplicate payment message
    if (this.isDuplicatePaymentSettled()) {
      let msg = 'This payment attempt was captured by the bank, but your order was already settled by an earlier attempt.';
      if (this.orderDetails.refund && this.orderDetails.refund.status === 'pending') {
        msg += ` A pending refund record of ₹${this.orderDetails.refund.amount} has been queued for review.`;
      } else {
        msg += ' A refund for this additional payment is under review.';
      }
      return msg;
    }

    // Precedence 3: Ambiguous timeout message
    if (this.isAmbiguousTimeout()) {
      return 'We are verifying your transaction outcome with the payment gateway. Please do not submit a duplicate order. Click "Refresh Status" in a moment.';
    }

    // Precedence 4: COD message
    if (order.paymentMethod === 'COD') {
      return 'Thank you for your order! Your crunchy makhana will be freshly prepared and dispatched. Please have cash or UPI ready at the time of delivery.';
    }

    // Precedence 5: Normal paid message
    if (order.paymentStatus === 'paid' || order.status === 'paid' || order.status === 'confirmed') {
      return 'Your payment has been verified by the bank. We are preparing your order for dispatch.';
    }

    // Precedence 6: Failed message
    if (order.paymentStatus === 'failed' || order.status === 'failed') {
      return 'The previous payment attempt was not completed or failed at the gateway. You may retry safely below.';
    }

    return 'We have created your order. Please complete the payment to confirm your purchase.';
  }
}
