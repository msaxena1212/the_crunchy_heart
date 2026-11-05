import { TestBed, ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminService } from '../admin.service';
import { AdminPaymentsComponent, ABSENCE_CONFIRMATION } from './admin-payments.component';

const ATTEMPT_AMBIGUOUS = {
  paymentId: 'pay-amb-1',
  orderNumber: 'TCH-20261102-AAAAAA',
  providerOrderId: 'TCH-20261102-AAAAAA-T1',
  gatewayStatus: 'GATEWAY_AMBIGUOUS_TIMEOUT',
  status: 'created',
  createdAt: '2026-11-02T08:00:00Z',
  updatedAt: '2026-11-02T08:00:00Z',
  legacyUnbound: false,
};

const ATTEMPT_LEGACY = {
  paymentId: 'pay-legacy-1',
  orderNumber: 'TCH-20261102-BBBBBB',
  providerOrderId: null,
  gatewayStatus: 'CASHFREE_PENDING',
  status: 'created',
  createdAt: '2026-11-01T08:00:00Z',
  updatedAt: '2026-11-01T08:00:00Z',
  legacyUnbound: true,
};

const ATTEMPT_IN_FLIGHT = {
  ...ATTEMPT_AMBIGUOUS,
  paymentId: 'pay-flight-1',
  gatewayStatus: 'ATTEMPT_INITIATED',
};

function mockAdminService() {
  return {
    currentAdmin: signal({ id: 'a1', email: 'owner@example.test', fullName: 'Owner', role: 'ADMIN' }),
    getPaymentReview: vi.fn(() => of({ success: true, attempts: [ATTEMPT_AMBIGUOUS, ATTEMPT_LEGACY], conflicts: [] })),
    getPaymentOrders: vi.fn(() => of({ success: true, orders: [] })),
    lookupPaymentAttempt: vi.fn(() => of({ success: true, paymentId: 'pay-amb-1', outcome: 'ORDER_CREATED', changed: true })),
    reconcilePaymentAttempt: vi.fn(() => of({ success: true, paymentId: 'pay-amb-1', reconciled: false, reason: 'PROVIDER_ORDER_NOT_FOUND_INCONCLUSIVE', action: 'KEPT_AMBIGUOUS_BLOCKED' })),
    closePaymentAttempt: vi.fn(() => of({ success: true, paymentId: 'pay-legacy-1', outcome: 'CREATE_NOT_SUBMITTED', changed: true })),
    logout: vi.fn(() => of({})),
  };
}

describe('AdminPaymentsComponent', () => {
  let service: ReturnType<typeof mockAdminService>;
  let fixture: ComponentFixture<AdminPaymentsComponent>;
  let component: AdminPaymentsComponent;
  let router: Router;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const buttons = (label: string): HTMLButtonElement[] =>
    Array.from(el().querySelectorAll('button')).filter(b => b.textContent?.trim().startsWith(label)) as HTMLButtonElement[];

  beforeEach(async () => {
    service = mockAdminService();
    await TestBed.configureTestingModule({
      imports: [AdminPaymentsComponent],
      providers: [provideRouter([]), { provide: AdminService, useValue: service }],
    }).compileComponents();

    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture = TestBed.createComponent(AdminPaymentsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('needs review tab', () => {
    it('loads the review queue on open and shows each attempt', () => {
      expect(service.getPaymentReview).toHaveBeenCalledWith(50);
      expect(el().textContent).toContain('TCH-20261102-AAAAAA');
      expect(el().textContent).toContain('TCH-20261102-BBBBBB');
    });

    it('shows an empty state when nothing needs review', () => {
      service.getPaymentReview.mockReturnValueOnce(of({ success: true, attempts: [], conflicts: [] }));
      component.refresh();
      fixture.detectChanges();
      expect(el().textContent).toContain('Nothing to review');
    });

    it('lists conflicting orders with a clear warning', () => {
      service.getPaymentReview.mockReturnValueOnce(of({
        success: true,
        attempts: [],
        conflicts: [{ orderNumber: 'TCH-CONFLICT-1', liveSessions: 2 }],
      } as any));
      component.refresh();
      fixture.detectChanges();
      expect(el().textContent).toContain('Orders with conflicting live sessions');
      expect(el().textContent).toContain('TCH-CONFLICT-1');
    });
  });

  describe('actions', () => {
    it('sends a lookup once even when the button is clicked twice', () => {
      const pending = new Subject<any>();
      service.lookupPaymentAttempt.mockReturnValueOnce(pending.asObservable());

      component.lookup(component.reviewAttempts[0]);
      component.lookup(component.reviewAttempts[0]);
      fixture.detectChanges();

      expect(service.lookupPaymentAttempt).toHaveBeenCalledTimes(1);
      expect(component.isBusy(`lookup:${ATTEMPT_AMBIGUOUS.paymentId}`)).toBe(true);
      pending.next({ success: true, paymentId: 'pay-amb-1', outcome: 'ORDER_CREATED', changed: true });
      pending.complete();
    });

    it('describes a successful lookup in plain words and refreshes the queue', () => {
      component.lookup(component.reviewAttempts[0]);
      fixture.detectChanges();

      expect(service.lookupPaymentAttempt).toHaveBeenCalledWith('pay-amb-1');
      expect(component.infoMessage).toContain('Provider session attached');
      expect(service.getPaymentReview).toHaveBeenCalledTimes(2);
    });

    it('explains an inconclusive reconcile without implying the order was paid', () => {
      component.reconcile(component.reviewAttempts[0]);
      expect(service.reconcilePaymentAttempt).toHaveBeenCalledWith('pay-amb-1');
      expect(component.infoMessage).toContain('No change');
      expect(component.infoMessage).not.toMatch(/paid/i);
    });

    it('sends the operator to login on 403', () => {
      service.lookupPaymentAttempt.mockReturnValueOnce(throwError(() => ({ status: 403, error: {} })));
      component.lookup(component.reviewAttempts[0]);
      expect(router.navigate).toHaveBeenCalledWith(['/admin/login']);
    });

    it('shows the server message for a refused action', () => {
      service.lookupPaymentAttempt.mockReturnValueOnce(throwError(() => ({
        status: 409,
        error: { message: 'Attempt is CREATE_NOT_SUBMITTED and cannot be resolved by lookup.' },
      })));
      component.lookup(component.reviewAttempts[0]);
      fixture.detectChanges();
      expect(el().querySelector('[role="alert"]')?.textContent).toContain('cannot be resolved by lookup');
    });
  });

  describe('close as not submitted', () => {
    it('offers close only where the server allows it', () => {
      service.getPaymentReview.mockReturnValueOnce(of({ success: true, attempts: [ATTEMPT_IN_FLIGHT], conflicts: [] }));
      component.refresh();
      fixture.detectChanges();
      expect(buttons('Close as not submitted')).toHaveLength(0);
    });

    it('offers close for ambiguous and legacy attempts', () => {
      expect(buttons('Close as not submitted').length).toBe(2);
    });

    it('stays disabled until the exact attestation and a note of at least 10 characters are entered', () => {
      component.openClose(component.reviewAttempts[1]);
      fixture.detectChanges();

      expect(component.closeReady).toBe(false);
      component.closeConfirmation = 'absent';
      component.closeNote = 'Checked the dashboard, not found.';
      expect(component.closeReady).toBe(false);

      component.closeConfirmation = ABSENCE_CONFIRMATION;
      component.closeNote = 'short';
      expect(component.closeReady).toBe(false);

      component.closeNote = 'Checked the dashboard at 10:40 on 2 Nov; not found.';
      expect(component.closeReady).toBe(true);
    });

    it('sends the trimmed note with the attestation and then refreshes', () => {
      component.openClose(component.reviewAttempts[1]);
      component.closeConfirmation = ABSENCE_CONFIRMATION;
      component.closeNote = '   Checked the dashboard: order number absent.   ';
      component.submitClose(component.reviewAttempts[1]);

      expect(service.closePaymentAttempt).toHaveBeenCalledWith('pay-legacy-1', 'Checked the dashboard: order number absent.');
      expect(component.closingId).toBeNull();
      expect(component.infoMessage).toContain('A new payment attempt is now allowed');
    });

    it('does not send a close while one is already in flight', () => {
      const pending = new Subject<any>();
      service.closePaymentAttempt.mockReturnValueOnce(pending.asObservable());
      component.openClose(component.reviewAttempts[1]);
      component.closeConfirmation = ABSENCE_CONFIRMATION;
      component.closeNote = 'Checked the dashboard: order number absent.';

      component.submitClose(component.reviewAttempts[1]);
      component.submitClose(component.reviewAttempts[1]);

      expect(service.closePaymentAttempt).toHaveBeenCalledTimes(1);
      pending.next({ success: true, paymentId: 'pay-legacy-1', outcome: 'CREATE_NOT_SUBMITTED', changed: true });
      pending.complete();
    });
  });

  describe('all online orders tab', () => {
    it('loads the overview and filters it by payment state', () => {
      component.setTab('orders');
      expect(service.getPaymentOrders).toHaveBeenLastCalledWith({ state: '', limit: 50 });

      component.stateFilter = 'UNRESOLVED';
      component.onFilterChange();
      expect(service.getPaymentOrders).toHaveBeenLastCalledWith({ state: 'UNRESOLVED', limit: 50 });
    });

    it('shows each order state with its label', () => {
      service.getPaymentOrders.mockReturnValueOnce(of({
        success: true,
        orders: [{
          orderNumber: 'TCH-OVERVIEW-1',
          orderStatus: 'pending',
          paymentStatus: 'pending',
          totalAmount: 250,
          createdAt: '2026-11-02T08:00:00Z',
          paymentState: 'UNRESOLVED',
          reasons: ['UNRESOLVED_ATTEMPT'],
          attempts: [],
        }],
      } as any));
      component.setTab('orders');
      fixture.detectChanges();
      expect(el().textContent).toContain('TCH-OVERVIEW-1');
      expect(el().textContent).toContain('Unresolved');
    });
  });

  describe('privacy', () => {
    it('never renders a payment session or a raw provider payload', () => {
      service.getPaymentReview.mockReturnValueOnce(of({
        success: true,
        attempts: [ATTEMPT_AMBIGUOUS],
        conflicts: [],
      }));
      component.refresh();
      fixture.detectChanges();
      const text = el().textContent ?? '';
      expect(text).not.toContain('payment_session_id');
      expect(text).not.toContain('raw_response');
      expect(text).not.toMatch(/sess_/);
    });
  });
});
