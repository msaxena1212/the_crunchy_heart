import { TestBed, ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckoutService, RecoveryRequestResponse, RecoveryVerifyResponse } from '../checkout.service';
import { RecoverOrderComponent } from './recover-order.component';

// Every network call goes through this mock. No request leaves the test process.
function mockCheckoutService() {
  return {
    requestOrderRecovery: vi.fn(),
    verifyOrderRecovery: vi.fn(),
    saveGuestToken: vi.fn(),
  };
}

const GENERIC_REPLY: RecoveryRequestResponse = {
  success: true,
  message: 'If a recent order matches these details, a verification code will be sent to the email address on file.',
};

const VERIFIED: RecoveryVerifyResponse = {
  success: true,
  order: {
    order_number: 'REC-ABC123',
    status: 'confirmed',
    payment_status: 'paid',
    total_amount: 500,
    created_at: '2026-10-31T10:00:00Z',
  },
  guestAccessToken: 'v1.payload.signature',
};

describe('RecoverOrderComponent', () => {
  let service: ReturnType<typeof mockCheckoutService>;
  let fixture: ComponentFixture<RecoverOrderComponent>;
  let component: RecoverOrderComponent;
  let router: Router;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const input = (id: string): HTMLInputElement => el().querySelector(`#${id}`) as HTMLInputElement;
  const submitForm = (): void => {
    el().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    fixture.detectChanges();
  };

  beforeEach(async () => {
    service = mockCheckoutService();
    await TestBed.configureTestingModule({
      imports: [RecoverOrderComponent],
      providers: [provideRouter([]), { provide: CheckoutService, useValue: service }],
    }).compileComponents();

    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture = TestBed.createComponent(RecoverOrderComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('email step', () => {
    it('rejects an invalid email without calling the service and shows visible feedback', () => {
      component.email = 'not-an-email';
      component.requestCode();
      fixture.detectChanges();

      expect(service.requestOrderRecovery).not.toHaveBeenCalled();
      const alert = el().querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('Enter the email address used at checkout.');
      expect(component.step).toBe('email');
    });

    it('sends the normalized email and moves to the code step on a generic reply', () => {
      service.requestOrderRecovery.mockReturnValue(of(GENERIC_REPLY));
      component.email = '  Guest@Example.COM ';
      component.requestCode();
      fixture.detectChanges();

      expect(service.requestOrderRecovery).toHaveBeenCalledTimes(1);
      expect(service.requestOrderRecovery).toHaveBeenCalledWith('guest@example.com');
      expect(component.step).toBe('code');
      expect(el().querySelector('[role="alert"]')).toBeNull();
    });

    it('shows the same generic text whether or not an order matched', () => {
      // The server returns one generic reply for both cases, so the screen must not branch on it.
      service.requestOrderRecovery.mockReturnValue(of(GENERIC_REPLY));
      component.email = 'nobody@example.com';
      component.requestCode();
      fixture.detectChanges();

      expect(component.step).toBe('code');
      expect(el().textContent).toContain('Code sent, if the address matches an order.');
      expect(el().textContent).not.toMatch(/no order|not found|does not exist|unknown/i);
    });

    it('submits through the form (keyboard Enter) as well as the button', () => {
      service.requestOrderRecovery.mockReturnValue(of(GENERIC_REPLY));
      component.email = 'guest@example.com';
      fixture.detectChanges();

      submitForm();

      expect(service.requestOrderRecovery).toHaveBeenCalledTimes(1);
      expect(component.step).toBe('code');
    });

    it('shows a visible error and stays on the email step when the service is unavailable', () => {
      service.requestOrderRecovery.mockReturnValue(throwError(() => ({ status: 503 })));
      component.email = 'guest@example.com';
      component.requestCode();
      fixture.detectChanges();

      expect(component.step).toBe('email');
      expect(el().querySelector('[role="alert"]')?.textContent).toContain('not available right now');
    });

    it('shows a connection message on a network failure', () => {
      service.requestOrderRecovery.mockReturnValue(throwError(() => ({ status: 0 })));
      component.email = 'guest@example.com';
      component.requestCode();
      fixture.detectChanges();

      expect(el().querySelector('[role="alert"]')?.textContent).toContain('could not reach the server');
    });
  });

  describe('code step', () => {
    beforeEach(() => {
      service.requestOrderRecovery.mockReturnValue(of(GENERIC_REPLY));
      component.email = 'guest@example.com';
      component.requestCode();
      fixture.detectChanges();
    });

    it('rejects a malformed code without calling the service', () => {
      component.code = '12345';
      component.verifyCode();
      fixture.detectChanges();

      expect(service.verifyOrderRecovery).not.toHaveBeenCalled();
      expect(el().querySelector('[role="alert"]')?.textContent).toContain('six-digit code');
    });

    it('verifies the normalized code, stores the token, and opens the recovered order', () => {
      service.verifyOrderRecovery.mockReturnValue(of(VERIFIED));
      component.code = '123 456';
      component.verifyCode();

      expect(service.verifyOrderRecovery).toHaveBeenCalledWith('guest@example.com', '123456');
      expect(service.saveGuestToken).toHaveBeenCalledWith('REC-ABC123', 'v1.payload.signature');
      expect(router.navigate).toHaveBeenCalledWith(['/orders', 'REC-ABC123']);
      expect(component.code).toBe('');
    });

    it('stores the token before navigating', () => {
      service.verifyOrderRecovery.mockReturnValue(of(VERIFIED));
      const order: string[] = [];
      service.saveGuestToken.mockImplementation(() => order.push('save'));
      vi.mocked(router.navigate).mockImplementation(async () => {
        order.push('navigate');
        return true;
      });
      component.code = '123456';
      component.verifyCode();

      expect(order).toEqual(['save', 'navigate']);
    });

    it('shows the generic invalid-code message for a wrong or expired code and keeps the code step', () => {
      service.verifyOrderRecovery.mockReturnValue(throwError(() => ({ status: 401 })));
      component.code = '000000';
      component.verifyCode();
      fixture.detectChanges();

      expect(el().querySelector('[role="alert"]')?.textContent).toContain('invalid or has expired');
      expect(component.step).toBe('code');
      expect(service.saveGuestToken).not.toHaveBeenCalled();
      expect(router.navigate).not.toHaveBeenCalled();
    });

    it('gives the same message on every wrong attempt, so an exhausted limit is not revealed', () => {
      service.verifyOrderRecovery.mockReturnValue(throwError(() => ({ status: 401 })));
      component.code = '000000';
      component.verifyCode();
      fixture.detectChanges();
      const first = el().querySelector('[role="alert"]')?.textContent;

      component.code = '000001';
      component.verifyCode();
      fixture.detectChanges();
      const later = el().querySelector('[role="alert"]')?.textContent;

      expect(first).toBeTruthy();
      expect(later).toBe(first);
      expect(service.verifyOrderRecovery).toHaveBeenCalledTimes(2);
    });

    it('shows the unavailable message when the service answers 503', () => {
      service.verifyOrderRecovery.mockReturnValue(throwError(() => ({ status: 503 })));
      component.code = '123456';
      component.verifyCode();
      fixture.detectChanges();

      expect(el().querySelector('[role="alert"]')?.textContent).toContain('not available right now');
      expect(router.navigate).not.toHaveBeenCalled();
    });

    it('shows the network message on a connection failure', () => {
      service.verifyOrderRecovery.mockReturnValue(throwError(() => ({ status: 0 })));
      component.code = '123456';
      component.verifyCode();
      fixture.detectChanges();

      expect(el().querySelector('[role="alert"]')?.textContent).toContain('could not reach the server');
    });

    it('returns to the email step and clears the code when the guest changes the address', () => {
      component.code = '123456';
      component.changeEmail();
      fixture.detectChanges();

      expect(component.step).toBe('email');
      expect(component.code).toBe('');
    });
  });

  describe('overlapping submissions', () => {
    it('sends one code request for a double click while the first is in flight', () => {
      const pending = new Subject<RecoveryRequestResponse>();
      service.requestOrderRecovery.mockReturnValue(pending.asObservable());
      component.email = 'guest@example.com';
      component.requestCode();
      component.requestCode();
      fixture.detectChanges();

      expect(service.requestOrderRecovery).toHaveBeenCalledTimes(1);
      const button = el().querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain('Sending code');

      pending.next(GENERIC_REPLY);
      pending.complete();
      fixture.detectChanges();
      expect(component.sendFlight.isBusy).toBe(false);
    });

    it('sends one verification for a double submit while the first is in flight', () => {
      service.requestOrderRecovery.mockReturnValue(of(GENERIC_REPLY));
      component.email = 'guest@example.com';
      component.requestCode();
      fixture.detectChanges();

      const pending = new Subject<RecoveryVerifyResponse>();
      service.verifyOrderRecovery.mockReturnValue(pending.asObservable());
      component.code = '123456';
      component.verifyCode();
      component.verifyCode();
      fixture.detectChanges();

      expect(service.verifyOrderRecovery).toHaveBeenCalledTimes(1);
      const button = el().querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain('Checking code');
    });
  });

  describe('privacy', () => {
    it('never places the code or token in the URL, a query string, or a route link', () => {
      service.requestOrderRecovery.mockReturnValue(of(GENERIC_REPLY));
      service.verifyOrderRecovery.mockReturnValue(of(VERIFIED));
      component.email = 'guest@example.com';
      component.requestCode();
      component.code = '123456';
      component.verifyCode();
      fixture.detectChanges();

      const [commands] = vi.mocked(router.navigate).mock.calls[0];
      expect(commands).toEqual(['/orders', 'REC-ABC123']);
      expect(JSON.stringify(commands)).not.toContain('123456');
      expect(JSON.stringify(commands)).not.toContain('v1.payload');
      expect(window.location.search).toBe('');
    });

    it('writes no code, email, or token to the console', () => {
      const logs = ['log', 'info', 'warn', 'error', 'debug'] as const;
      const spies = logs.map(name => vi.spyOn(console, name).mockImplementation(() => undefined));

      service.requestOrderRecovery.mockReturnValue(of(GENERIC_REPLY));
      service.verifyOrderRecovery.mockReturnValue(throwError(() => ({ status: 401 })));
      component.email = 'guest@example.com';
      component.requestCode();
      component.code = '654321';
      component.verifyCode();

      const written = spies.flatMap(spy => spy.mock.calls.flat().map(String)).join(' ');
      expect(written).not.toContain('guest@example.com');
      expect(written).not.toContain('654321');
    });
  });

  describe('accessibility', () => {
    it('labels both inputs and associates them with their labels', () => {
      const emailLabel = el().querySelector('label[for="recover-email"]');
      expect(emailLabel?.textContent).toContain('Email address');
      expect(input('recover-email')).not.toBeNull();

      service.requestOrderRecovery.mockReturnValue(of(GENERIC_REPLY));
      component.email = 'guest@example.com';
      component.requestCode();
      fixture.detectChanges();

      const codeLabel = el().querySelector('label[for="recover-code"]');
      expect(codeLabel?.textContent).toContain('Six-digit code');
      expect(input('recover-code').getAttribute('autocomplete')).toBe('one-time-code');
      expect(input('recover-code').getAttribute('inputmode')).toBe('numeric');
    });

    it('moves focus into the code field when the code step appears', async () => {
      service.requestOrderRecovery.mockReturnValue(of(GENERIC_REPLY));
      component.email = 'guest@example.com';
      component.requestCode();
      fixture.detectChanges();
      await fixture.whenStable();

      expect(document.activeElement?.id).toBe('recover-code');
    });

    it('announces the step change through a persistent status region', () => {
      const region = el().querySelector('p.sr-only[role="status"]');
      expect(region?.textContent?.trim()).toBe('');

      service.requestOrderRecovery.mockReturnValue(of(GENERIC_REPLY));
      component.email = 'guest@example.com';
      component.requestCode();
      fixture.detectChanges();

      expect(region?.textContent).toContain('Verification code step');
    });

    it('announces errors and status messages to assistive technology', () => {
      component.email = 'bad';
      component.requestCode();
      fixture.detectChanges();

      const alert = el().querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
    });

    it('keeps every action reachable as a native button', () => {
      const buttons = Array.from(el().querySelectorAll('button'));
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button.getAttribute('type')).toBeTruthy();
      }
    });
  });
});
