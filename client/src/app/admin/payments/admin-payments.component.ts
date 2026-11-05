import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Observable } from 'rxjs';
import {
  AdminService,
  PaymentAttemptActionResult,
  PaymentAttemptReviewItem,
  PaymentAttemptState,
  PaymentStateOrder,
} from '../admin.service';

/** Stored by the server. The attestation must be typed exactly; it is not a secret. */
export const ABSENCE_CONFIRMATION = 'ABSENT_IN_PROVIDER_DASHBOARD';

const STATE_LABELS: Record<PaymentAttemptState, string> = {
  PAID: 'Paid',
  CONFLICT: 'Conflict',
  UNRESOLVED: 'Unresolved',
  RESUMABLE: 'Resumable',
  NO_LIVE: 'No live session',
  NO_ATTEMPT: 'No attempt',
};

/** A payment attempt as shown in either tab. Identifiers and statuses only. */
export interface AttemptRow {
  paymentId: string;
  orderNumber: string;
  providerOrderId: string | null;
  gatewayStatus: string;
  status: string;
  createdAt: string;
  legacyUnbound: boolean;
}

@Component({
  selector: 'app-admin-payments',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-payments.component.html',
  styleUrls: ['./admin-payments.component.css'],
})
export class AdminPaymentsComponent implements OnInit {
  adminService = inject(AdminService);
  private router = inject(Router);

  readonly confirmationValue = ABSENCE_CONFIRMATION;
  readonly stateOptions: PaymentAttemptState[] = ['UNRESOLVED', 'CONFLICT', 'RESUMABLE', 'NO_LIVE', 'PAID', 'NO_ATTEMPT'];

  tab: 'review' | 'orders' = 'review';
  stateFilter: PaymentAttemptState | '' = '';

  reviewAttempts: AttemptRow[] = [];
  conflicts: Array<{ orderNumber: string; liveSessions: number }> = [];
  orders: PaymentStateOrder[] = [];

  isLoading = false;
  errorMessage = '';
  infoMessage = '';

  /** One action at a time, so a double click cannot send the same request twice. */
  busyKey: string | null = null;

  closingId: string | null = null;
  closeConfirmation = '';
  closeNote = '';

  ngOnInit(): void {
    this.loadReview();
  }

  setTab(tab: 'review' | 'orders'): void {
    this.tab = tab;
    this.clearMessages();
    this.refresh();
  }

  refresh(): void {
    if (this.tab === 'review') {
      this.loadReview();
    } else {
      this.loadOrders();
    }
  }

  /** Reloads the review queue. keepMessages preserves the outcome of an action that just ran. */
  loadReview(keepMessages = false): void {
    this.isLoading = true;
    if (!keepMessages) this.clearMessages();
    this.adminService.getPaymentReview(50).subscribe({
      next: res => {
        this.isLoading = false;
        this.reviewAttempts = res.attempts.map(a => this.toRow(a));
        this.conflicts = res.conflicts;
      },
      error: err => this.onLoadError(err),
    });
  }

  loadOrders(keepMessages = false): void {
    this.isLoading = true;
    if (!keepMessages) this.clearMessages();
    this.adminService.getPaymentOrders({ state: this.stateFilter, limit: 50 }).subscribe({
      next: res => {
        this.isLoading = false;
        this.orders = res.orders;
      },
      error: err => this.onLoadError(err),
    });
  }

  onFilterChange(): void {
    this.loadOrders();
  }

  /** Attempts that the actions apply to, from whichever tab is open. */
  get actionableAttempts(): AttemptRow[] {
    if (this.tab === 'review') return this.reviewAttempts;
    return this.orders.flatMap(order =>
      order.attempts.map(a => ({
        paymentId: a.paymentId,
        orderNumber: order.orderNumber,
        providerOrderId: a.providerOrderId,
        gatewayStatus: a.gatewayStatus,
        status: a.status,
        createdAt: a.createdAt,
        legacyUnbound: a.legacyUnbound,
      }))
    );
  }

  canLookup(attempt: AttemptRow): boolean {
    return ['ATTEMPT_INITIATED', 'GATEWAY_AMBIGUOUS_TIMEOUT', 'CASHFREE_PENDING'].includes(attempt.gatewayStatus);
  }

  /** Close is offered only where the server allows it, so the button matches the refusal. */
  canClose(attempt: AttemptRow): boolean {
    return attempt.gatewayStatus === 'GATEWAY_AMBIGUOUS_TIMEOUT' || (attempt.gatewayStatus === 'CASHFREE_PENDING' && attempt.legacyUnbound);
  }

  lookup(attempt: AttemptRow): void {
    this.runAction(`lookup:${attempt.paymentId}`, () => this.adminService.lookupPaymentAttempt(attempt.paymentId), res => this.describeLookup(res));
  }

  reconcile(attempt: AttemptRow): void {
    this.runAction(`reconcile:${attempt.paymentId}`, () => this.adminService.reconcilePaymentAttempt(attempt.paymentId), res => this.describeReconcile(res));
  }

  openClose(attempt: AttemptRow): void {
    this.closingId = attempt.paymentId;
    this.closeConfirmation = '';
    this.closeNote = '';
    this.clearMessages();
  }

  cancelClose(): void {
    this.closingId = null;
    this.closeConfirmation = '';
    this.closeNote = '';
  }

  get closeReady(): boolean {
    const note = this.closeNote.trim();
    return this.closeConfirmation.trim() === this.confirmationValue && note.length >= 10 && note.length <= 500;
  }

  submitClose(attempt: AttemptRow): void {
    if (!this.closeReady) return;
    const note = this.closeNote.trim();
    this.runAction(
      `close:${attempt.paymentId}`,
      () => this.adminService.closePaymentAttempt(attempt.paymentId, note),
      () => 'Attempt closed as not submitted. A new payment attempt is now allowed for this order.',
      () => this.cancelClose()
    );
  }

  stateLabel(state: PaymentAttemptState): string {
    return STATE_LABELS[state] ?? state;
  }

  stateBadgeClass(state: PaymentAttemptState): string {
    switch (state) {
      case 'PAID': return 'badge-paid';
      case 'CONFLICT': return 'badge-conflict';
      case 'UNRESOLVED': return 'badge-unresolved';
      case 'RESUMABLE': return 'badge-resumable';
      default: return 'badge-default';
    }
  }

  isBusy(key: string): boolean {
    return this.busyKey === key;
  }

  onLogout(): void {
    this.adminService.logout().subscribe({
      next: () => this.router.navigate(['/admin/login']),
      error: () => this.router.navigate(['/admin/login']),
    });
  }

  /**
   * Runs one operator action. The request is sent once, the list is refreshed afterwards, and
   * the outcome is described in plain words. A session expiry sends the operator to login.
   */
  private runAction(
    key: string,
    call: () => Observable<PaymentAttemptActionResult>,
    describe: (res: PaymentAttemptActionResult) => string,
    onSuccess?: () => void
  ): void {
    if (this.busyKey) return;
    this.busyKey = key;
    this.clearMessages();
    call().subscribe({
      next: res => {
        this.busyKey = null;
        this.infoMessage = describe(res);
        onSuccess?.();
        // Reload without clearing the outcome, so the operator sees what the action did.
        if (this.tab === 'review') {
          this.loadReview(true);
        } else {
          this.loadOrders(true);
        }
      },
      error: err => {
        this.busyKey = null;
        this.handleError(err);
      },
    });
  }

  private describeLookup(res: PaymentAttemptActionResult): string {
    switch (res.outcome) {
      case 'ORDER_CREATED':
        return 'Provider session attached. The order can now be resumed.';
      case 'RUN_RECONCILE':
        return 'The provider reports this order as paid. Run reconcile to record the payment from provider evidence.';
      default:
        return `No change. The provider lookup was inconclusive (${res.reason ?? 'unknown reason'}).`;
    }
  }

  private describeReconcile(res: PaymentAttemptActionResult): string {
    if (res.reconciled) {
      return 'Reconciled from provider evidence.';
    }
    return `No change. Reconciliation did not record a payment (${res.reason ?? res.action ?? 'no reason given'}).`;
  }

  private toRow(a: PaymentAttemptReviewItem): AttemptRow {
    return {
      paymentId: a.paymentId,
      orderNumber: a.orderNumber,
      providerOrderId: a.providerOrderId,
      gatewayStatus: a.gatewayStatus,
      status: a.status,
      createdAt: a.createdAt,
      legacyUnbound: a.legacyUnbound,
    };
  }

  private onLoadError(err: { status?: number; error?: { message?: string } }): void {
    this.isLoading = false;
    this.handleError(err);
  }

  private handleError(err: { status?: number; error?: { message?: string } }): void {
    if (err?.status === 401 || err?.status === 403) {
      this.router.navigate(['/admin/login']);
      return;
    }
    this.errorMessage = err?.error?.message || 'The request failed. Please retry.';
  }

  private clearMessages(): void {
    this.errorMessage = '';
    this.infoMessage = '';
  }
}
