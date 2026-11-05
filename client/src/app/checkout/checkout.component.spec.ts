import { TestBed, ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CartService } from '../cart.service';
import { CheckoutService } from '../checkout.service';
import { CheckoutComponent } from './checkout.component';

// The existing behaviour is the specification: a key is kept while the order content is
// unchanged, and a new key is generated when it changes. Nothing here changes that.

let keySeq = 0;

function mockCheckoutService() {
  return {
    generateIdempotencyKey: vi.fn(() => `key-${++keySeq}`),
    previewCheckout: vi.fn(() => of({ success: true, items: [], totalAmount: 0 })),
    createOrder: vi.fn(),
    saveGuestToken: vi.fn(),
    launchCashfreePayment: vi.fn(),
  };
}

function mockCartService(items: any[]) {
  return {
    items,
    clearCart: vi.fn(),
    saveCartSnapshot: vi.fn(),
  };
}

const CART = [
  { variantId: 'var-b', quantity: 2, productName: 'Bhujia', variantName: '250g', unitPrice: 100 },
  { variantId: 'var-a', quantity: 1, productName: 'Chips', variantName: '100g', unitPrice: 50 },
];

const VALID_FORM = {
  name: 'Asha Rao',
  phone: '9876543210',
  email: 'asha@example.test',
  addressLine1: '12 Lake Road',
  addressLine2: '',
  landmark: '',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001',
  paymentMethod: 'ONLINE',
  notes: '',
};

describe('CheckoutComponent idempotency keys', () => {
  let checkout: ReturnType<typeof mockCheckoutService>;
  let cart: ReturnType<typeof mockCartService>;
  let fixture: ComponentFixture<CheckoutComponent>;
  let component: CheckoutComponent;

  const submittedKeys = (): string[] =>
    checkout.createOrder.mock.calls.map(call => call[0].idempotencyKey as string);

  // Makes the next createOrder fail, so the form returns to idle and can be resubmitted.
  const failNext = () => checkout.createOrder.mockReturnValueOnce(throwError(() => ({ status: 0, error: {} })));

  beforeEach(async () => {
    checkout = mockCheckoutService();
    cart = mockCartService(CART.map(item => ({ ...item })));
    await TestBed.configureTestingModule({
      imports: [CheckoutComponent],
      providers: [
        provideRouter([]),
        { provide: CheckoutService, useValue: checkout },
        { provide: CartService, useValue: cart },
      ],
    }).compileComponents();

    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(CheckoutComponent);
    component = fixture.componentInstance;
    component.checkoutForm.patchValue(VALID_FORM);
    fixture.detectChanges();
  });

  it('keeps the same key for an unchanged cart and checkout payload across an unchanged retry', () => {
    failNext();
    component.onSubmit();
    failNext();
    component.onSubmit();

    expect(checkout.createOrder).toHaveBeenCalledTimes(2);
    const [first, second] = submittedKeys();
    expect(second).toBe(first);
  });

  it('sends the key the component holds after the first submission', () => {
    // The key generated on page load is replaced at the first submit, because the
    // submitted content is recorded only then. The sent key is the one kept afterwards.
    failNext();
    component.onSubmit();

    expect(submittedKeys()[0]).not.toBe('');
    expect(submittedKeys()[0]).toBe(component.idempotencyKey);
  });

  it('does not rotate the key on re-render or change detection', () => {
    failNext();
    component.onSubmit();
    const afterSubmit = component.idempotencyKey;

    fixture.detectChanges();
    fixture.detectChanges();
    fixture.detectChanges();

    expect(component.idempotencyKey).toBe(afterSubmit);
    failNext();
    component.onSubmit();
    expect(submittedKeys()[1]).toBe(afterSubmit);
  });

  it('generates a new key when a quantity changes', () => {
    failNext();
    component.onSubmit();
    cart.items[0].quantity = 3;
    failNext();
    component.onSubmit();

    const [first, second] = submittedKeys();
    expect(second).not.toBe(first);
  });

  it('generates a new key when an item is added or removed', () => {
    failNext();
    component.onSubmit();
    cart.items.push({ variantId: 'var-c', quantity: 1, productName: 'Namkeen', variantName: '50g', unitPrice: 30 });
    failNext();
    component.onSubmit();
    cart.items.splice(0, 2);
    failNext();
    component.onSubmit();

    const keys = submittedKeys();
    expect(new Set(keys).size).toBe(3);
  });

  it('keeps the key when only the order of the cart items changes, because items are sorted', () => {
    failNext();
    component.onSubmit();
    cart.items.reverse();
    failNext();
    component.onSubmit();

    const [first, second] = submittedKeys();
    expect(second).toBe(first);
  });

  it('generates a new key when the shipping address changes', () => {
    failNext();
    component.onSubmit();
    component.checkoutForm.patchValue({ addressLine1: '99 Hill Street' });
    failNext();
    component.onSubmit();

    const [first, second] = submittedKeys();
    expect(second).not.toBe(first);
  });

  it('generates a new key when the payment method changes', () => {
    failNext();
    component.onSubmit();
    component.checkoutForm.patchValue({ paymentMethod: 'COD' });
    failNext();
    component.onSubmit();

    const [first, second] = submittedKeys();
    expect(second).not.toBe(first);
  });

  it('generates a new key when the order notes change', () => {
    failNext();
    component.onSubmit();
    component.checkoutForm.patchValue({ notes: 'Ring the bell twice' });
    failNext();
    component.onSubmit();

    const [first, second] = submittedKeys();
    expect(second).not.toBe(first);
  });

  it('ignores surrounding whitespace in the content, so it does not rotate the key', () => {
    failNext();
    component.onSubmit();
    component.checkoutForm.patchValue({ name: `  ${VALID_FORM.name}  ` });
    failNext();
    component.onSubmit();

    const [first, second] = submittedKeys();
    expect(second).toBe(first);
  });

  it('generates a new key when the content is changed and then changed back, since the last submitted content differs', () => {
    failNext();
    component.onSubmit();
    component.checkoutForm.patchValue({ notes: 'temporary' });
    failNext();
    component.onSubmit();
    component.checkoutForm.patchValue({ notes: '' });
    failNext();
    component.onSubmit();

    const [first, , third] = submittedKeys();
    expect(third).not.toBe(first);
  });

  it('sends one order for a duplicate submission while the first is still in flight', () => {
    const pending = new Subject<any>();
    checkout.createOrder.mockReturnValueOnce(pending.asObservable());

    component.onSubmit();
    component.onSubmit();
    component.onSubmit();

    expect(checkout.createOrder).toHaveBeenCalledTimes(1);
    expect(component.isSubmitting).toBe(true);
  });

  it('keeps the same key for a duplicate submission, so a server replay cannot create a second order', () => {
    const pending = new Subject<any>();
    checkout.createOrder.mockReturnValueOnce(pending.asObservable());
    component.onSubmit();
    component.onSubmit();

    expect(submittedKeys()).toHaveLength(1);
  });

  it('does not submit when the form is invalid', () => {
    component.checkoutForm.patchValue({ phone: '123' });
    component.onSubmit();

    expect(checkout.createOrder).not.toHaveBeenCalled();
  });
});
