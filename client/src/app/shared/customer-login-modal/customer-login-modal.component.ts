import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { CustomerAuthService } from '../customer-auth.service';

@Component({
  selector: 'tch-customer-login-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div *ngIf="isOpen" class="modal-backdrop" (click)="onBackdropClick($event)">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <button type="button" class="close-btn" (click)="close()" aria-label="Close modal">✕</button>

        <div class="modal-header">
          <span class="heart-icon">♡</span>
          <h2 id="modal-title">{{ step === 'phone' ? 'Sign In / Register' : 'Enter OTP' }}</h2>
          <p class="subtitle">
            {{ step === 'phone'
                ? 'Enter your mobile number to view orders and manage your account'
                : 'We sent a 6-digit verification code to +91 ' + phone }}
          </p>
        </div>

        <!-- ERROR MESSAGE -->
        <div *ngIf="errorMessage" class="error-banner">
          {{ errorMessage }}
        </div>

        <!-- SUCCESS MESSAGE -->
        <div *ngIf="successMessage" class="success-banner">
          {{ successMessage }}
        </div>

        <!-- STEP 1: PHONE INPUT -->
        <form *ngIf="step === 'phone'" (ngSubmit)="sendOtp()" class="modal-form">
          <div class="input-group">
            <label for="login-phone">Mobile Number</label>
            <div class="phone-input-wrap">
              <span class="country-prefix">+91</span>
              <input
                id="login-phone"
                type="tel"
                inputmode="numeric"
                pattern="[0-9]*"
                maxlength="10"
                placeholder="9876543210"
                [(ngModel)]="phone"
                name="phone"
                (input)="onPhoneInput($event)"
                autofocus
                [disabled]="isLoading"
                required />
            </div>
            <span class="field-hint">A 6-digit verification OTP will be sent.</span>
          </div>

          <button
            type="submit"
            class="submit-btn"
            [disabled]="isLoading || !isPhoneValid">
            <span *ngIf="!isLoading">Get OTP →</span>
            <span *ngIf="isLoading" class="spinner-text">Sending OTP...</span>
          </button>
        </form>

        <!-- STEP 2: OTP INPUT -->
        <form *ngIf="step === 'otp'" (ngSubmit)="verifyOtp()" class="modal-form">
          <div class="input-group">
            <label for="login-otp">6-Digit OTP</label>
            <input
              id="login-otp"
              type="text"
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength="6"
              placeholder="111111"
              [(ngModel)]="otp"
              name="otp"
              (input)="onOtpInput($event)"
              class="otp-input"
              autofocus
              [disabled]="isLoading"
              required />
            <span class="field-hint test-code-hint">
              Enter numeric 6-digit code. <strong>(Test OTP: 111111)</strong>
            </span>
          </div>

          <button
            type="submit"
            class="submit-btn"
            [disabled]="isLoading || !isOtpValid">
            <span *ngIf="!isLoading">Verify & Sign In →</span>
            <span *ngIf="isLoading" class="spinner-text">Verifying...</span>
          </button>

          <div class="resend-row">
            <button
              type="button"
              class="link-btn"
              (click)="changeNumber()"
              [disabled]="isLoading">
              Change Number
            </button>
            <span class="dot-separator">•</span>
            <button
              type="button"
              class="link-btn"
              [disabled]="isLoading || resendCountdown > 0"
              (click)="resendOtp()">
              {{ resendCountdown > 0 ? 'Resend in ' + resendCountdown + 's' : 'Resend OTP' }}
            </button>
          </div>
        </form>

        <div class="modal-footer">
          <p>By continuing, you agree to The Crunchy Heart Terms & Privacy Policy.</p>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      height: 100dvh;
      background: rgba(18, 30, 22, 0.6);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      animation: fadeIn 200ms ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .modal-card {
      position: relative;
      background: #fffdf8;
      border: 1px solid #e8e0d2;
      border-radius: 20px;
      width: 100%;
      max-width: 420px;
      max-height: calc(100dvh - 32px);
      overflow-y: auto;
      padding: 32px 28px;
      box-shadow: 0 24px 50px rgba(18, 30, 22, 0.22);
      animation: slideUp 240ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes slideUp {
      from { opacity: 0; transform: translateY(16px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .close-btn {
      position: absolute;
      top: 16px;
      right: 18px;
      background: transparent;
      border: none;
      font-size: 18px;
      color: #7a7265;
      cursor: pointer;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      transition: background 160ms, color 160ms;
    }

    .close-btn:hover {
      background: #f1ebd8;
      color: #1e392a;
    }

    .modal-header {
      text-align: center;
      margin-bottom: 24px;
    }

    .heart-icon {
      font-size: 28px;
      color: #a17c35;
      display: inline-block;
      margin-bottom: 8px;
    }

    .modal-header h2 {
      margin: 0 0 8px;
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 24px;
      font-weight: 700;
      color: #1e392a;
      letter-spacing: -0.02em;
    }

    .subtitle {
      margin: 0;
      font-size: 13.5px;
      color: #6d665b;
      line-height: 1.5;
    }

    .error-banner {
      background: #fdf2f0;
      color: #b64232;
      border: 1px solid #f6cfc7;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 18px;
      text-align: center;
    }

    .success-banner {
      background: #f0f7f2;
      color: #1e5934;
      border: 1px solid #c2e2cc;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 18px;
      text-align: center;
    }

    .modal-form {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .input-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .input-group label {
      font-size: 12.5px;
      font-weight: 600;
      color: #1e392a;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .phone-input-wrap {
      display: flex;
      align-items: center;
      border: 1.5px solid #dcd1c2;
      border-radius: 10px;
      background: #ffffff;
      overflow: hidden;
      transition: border-color 160ms;
    }

    .phone-input-wrap:focus-within {
      border-color: #1e392a;
      box-shadow: 0 0 0 3px rgba(30, 57, 42, 0.1);
    }

    .country-prefix {
      padding: 12px 14px;
      background: #f8f4ec;
      border-right: 1.5px solid #dcd1c2;
      font-weight: 600;
      color: #4a453e;
      font-size: 14px;
    }

    .phone-input-wrap input {
      flex: 1;
      border: none;
      outline: none;
      padding: 12px 14px;
      font-size: 15px;
      font-weight: 500;
      color: #1e392a;
      background: transparent;
    }

    .otp-input {
      border: 1.5px solid #dcd1c2;
      border-radius: 10px;
      padding: 12px 14px;
      font-size: 20px;
      letter-spacing: 8px;
      text-align: center;
      font-weight: 700;
      color: #1e392a;
      outline: none;
      transition: border-color 160ms;
    }

    .otp-input:focus {
      border-color: #1e392a;
      box-shadow: 0 0 0 3px rgba(30, 57, 42, 0.1);
    }

    .field-hint {
      font-size: 11.5px;
      color: #8c8477;
    }

    .test-code-hint {
      color: #a17c35;
    }

    .submit-btn {
      background: #1e392a;
      color: #fff9ec;
      border: none;
      border-radius: 10px;
      padding: 14px;
      font-size: 14.5px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 180ms, transform 180ms;
    }

    .submit-btn:hover:not(:disabled) {
      background: #274b37;
      transform: translateY(-1px);
    }

    .submit-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .resend-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      font-size: 13px;
    }

    .link-btn {
      background: none;
      border: none;
      color: #a17c35;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      padding: 4px;
      text-decoration: underline;
    }

    .link-btn:disabled {
      color: #9c9588;
      cursor: not-allowed;
      text-decoration: none;
    }

    .dot-separator {
      color: #c0b9ac;
    }

    .modal-footer {
      margin-top: 24px;
      text-align: center;
      font-size: 11px;
      color: #9a9285;
      line-height: 1.4;
    }

    @media (max-width: 480px) {
      .modal-card {
        padding: 24px 20px;
        border-radius: 18px;
      }

      .modal-header h2 {
        font-size: 21px;
      }

      .subtitle {
        font-size: 13px;
      }

      .country-prefix {
        padding: 10px 12px;
        font-size: 13.5px;
      }

      .phone-input-wrap input {
        padding: 10px 12px;
        font-size: 14.5px;
      }

      .otp-input {
        letter-spacing: 6px;
        font-size: 18px;
        padding: 10px 12px;
      }

      .submit-btn {
        padding: 12px;
        font-size: 14px;
      }

      .close-btn {
        top: 12px;
        right: 12px;
        width: 36px;
        height: 36px;
        font-size: 20px;
      }
    }
  `]
})
export class CustomerLoginModalComponent implements OnInit, OnDestroy {
  private readonly customerAuthService = inject(CustomerAuthService);
  private readonly router = inject(Router);

  isOpen = false;
  redirectUrl: string | undefined;
  step: 'phone' | 'otp' = 'phone';

  phone = '';
  otp = '';

  isLoading = false;
  errorMessage = '';
  successMessage = '';

  resendCountdown = 0;
  private timerRef: any = null;
  private sub = new Subscription();

  ngOnInit(): void {
    this.sub.add(
      this.customerAuthService.loginModal$.subscribe(state => {
        this.isOpen = state.isOpen;
        this.redirectUrl = state.redirectUrl;
        if (this.isOpen) {
          this.resetForm();
        } else {
          this.clearTimer();
        }
      })
    );
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
    this.clearTimer();
  }

  get isPhoneValid(): boolean {
    return /^[6-9]\d{9}$/.test(this.phone.trim());
  }

  get isOtpValid(): boolean {
    return /^\d{6}$/.test(this.otp.trim());
  }

  onPhoneInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.phone = input.value.replace(/\D/g, '').slice(0, 10);
  }

  onOtpInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.otp = input.value.replace(/\D/g, '').slice(0, 6);
  }

  sendOtp(): void {
    if (!this.isPhoneValid || this.isLoading) return;

    this.isLoading = true;
    this.errorMessage = '';
    this.successMessage = '';

    this.customerAuthService.requestOtp(this.phone.trim()).subscribe({
      next: (res) => {
        this.isLoading = false;
        if (res.success) {
          this.step = 'otp';
          this.startCountdown(30);
          this.successMessage = res.message || 'OTP sent successfully! Use 111111 for testing.';
        } else {
          this.errorMessage = res.message || 'Failed to send OTP. Please try again.';
        }
      },
      error: (err) => {
        this.isLoading = false;
        this.errorMessage = err.error?.message || 'Unable to connect to server. Please try again.';
      }
    });
  }

  verifyOtp(): void {
    if (!this.isOtpValid || this.isLoading) return;

    this.isLoading = true;
    this.errorMessage = '';
    this.successMessage = '';

    this.customerAuthService.verifyOtp(this.phone.trim(), this.otp.trim()).subscribe({
      next: (res) => {
        this.isLoading = false;
        if (res.success) {
          this.close();
          if (this.redirectUrl) {
            void this.router.navigateByUrl(this.redirectUrl);
          }
        }
      },
      error: (err) => {
        this.isLoading = false;
        this.errorMessage = err.error?.message || 'Invalid OTP code. Please enter 111111.';
      }
    });
  }

  resendOtp(): void {
    if (this.resendCountdown > 0 || this.isLoading) return;
    this.sendOtp();
  }

  changeNumber(): void {
    this.step = 'phone';
    this.otp = '';
    this.errorMessage = '';
    this.successMessage = '';
    this.clearTimer();
  }

  close(): void {
    this.customerAuthService.closeLoginModal();
  }

  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('modal-backdrop')) {
      this.close();
    }
  }

  private resetForm(): void {
    this.step = 'phone';
    this.phone = '';
    this.otp = '';
    this.isLoading = false;
    this.errorMessage = '';
    this.successMessage = '';
    this.clearTimer();
  }

  private startCountdown(seconds: number): void {
    this.clearTimer();
    this.resendCountdown = seconds;
    this.timerRef = setInterval(() => {
      this.resendCountdown--;
      if (this.resendCountdown <= 0) {
        this.clearTimer();
      }
    }, 1000);
  }

  private clearTimer(): void {
    if (this.timerRef) {
      clearInterval(this.timerRef);
      this.timerRef = null;
    }
  }
}
