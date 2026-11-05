import { Component, ElementRef, Injector, ViewChild, afterNextRender, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CheckoutService } from '../checkout.service';
import {
  SingleFlight,
  classifyRecoveryError,
  isValidRecoveryCode,
  isValidRecoveryEmail,
  normalizeRecoveryCode,
  normalizeRecoveryEmail,
  recoveredOrderCommands,
  recoveryErrorMessage,
} from './order-recovery.logic';

@Component({
  selector: 'tch-recover-order',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './recover-order.component.html',
  styleUrls: ['./recover-order.component.css'],
})
export class RecoverOrderComponent {
  private readonly checkoutService = inject(CheckoutService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  @ViewChild('codeInput') codeInput?: ElementRef<HTMLInputElement>;

  readonly sendFlight = new SingleFlight();
  readonly verifyFlight = new SingleFlight();

  step: 'email' | 'code' = 'email';
  email = '';
  code = '';

  isSending = false;
  isVerifying = false;
  errorMessage = '';
  infoMessage = '';

  /** Sends the code. The server reply is generic, so the code step opens whatever the outcome. */
  requestCode(): void {
    if (!isValidRecoveryEmail(this.email)) {
      this.errorMessage = 'Enter the email address used at checkout.';
      return;
    }
    if (!this.sendFlight.start()) return;

    const email = normalizeRecoveryEmail(this.email);
    this.isSending = true;
    this.errorMessage = '';
    this.infoMessage = '';

    this.checkoutService.requestOrderRecovery(email).subscribe({
      next: res => {
        this.finishSend();
        this.email = email;
        this.step = 'code';
        this.infoMessage = res.message;
        this.focusCodeField();
      },
      error: err => {
        this.finishSend();
        this.errorMessage = recoveryErrorMessage(classifyRecoveryError(err?.status ?? 0));
      },
    });
  }

  /** Verifies the code. On success the guest token is stored and the order page opens. */
  verifyCode(): void {
    if (!isValidRecoveryCode(this.code)) {
      this.errorMessage = 'Enter the six-digit code from the email.';
      return;
    }
    if (!this.verifyFlight.start()) return;

    this.isVerifying = true;
    this.errorMessage = '';
    this.infoMessage = '';

    this.checkoutService
      .verifyOrderRecovery(normalizeRecoveryEmail(this.email), normalizeRecoveryCode(this.code))
      .subscribe({
        next: res => {
          this.finishVerify();
          this.code = '';
          this.checkoutService.saveGuestToken(res.order.order_number, res.guestAccessToken);
          this.router.navigate(recoveredOrderCommands(res.order.order_number));
        },
        error: err => {
          this.finishVerify();
          this.errorMessage = recoveryErrorMessage(classifyRecoveryError(err?.status ?? 0));
        },
      });
  }

  /** Returns to the email step, for a different address. */
  changeEmail(): void {
    this.step = 'email';
    this.code = '';
    this.errorMessage = '';
    this.infoMessage = '';
  }

  /**
   * Moves focus into the code field once it exists, so keyboard and screen-reader users
   * land on the next input. The status line is a live region, so the change is announced.
   */
  private focusCodeField(): void {
    afterNextRender(() => this.codeInput?.nativeElement.focus(), { injector: this.injector });
  }

  private finishSend(): void {
    this.sendFlight.finish();
    this.isSending = false;
  }

  private finishVerify(): void {
    this.verifyFlight.finish();
    this.isVerifying = false;
  }
}
