/*
|--------------------------------------------------------------------------
| Order recovery: pure logic
|--------------------------------------------------------------------------
| Kept free of Angular so it can be tested directly. The recovery screen
| never puts the email, the code, or the guest token in a URL, a query
| string, or a log line. Navigation uses router commands only.
|--------------------------------------------------------------------------
*/

export const RECOVERY_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const RECOVERY_CODE_PATTERN = /^\d{6}$/;

export type RecoveryFailure = 'invalid' | 'unavailable' | 'network' | 'unknown';

export function normalizeRecoveryEmail(raw: string): string {
  return String(raw || '').trim().toLowerCase();
}

export function isValidRecoveryEmail(raw: string): boolean {
  return RECOVERY_EMAIL_PATTERN.test(normalizeRecoveryEmail(raw));
}

export function normalizeRecoveryCode(raw: string): string {
  return String(raw || '').replace(/\s+/g, '');
}

export function isValidRecoveryCode(raw: string): boolean {
  return RECOVERY_CODE_PATTERN.test(normalizeRecoveryCode(raw));
}

/** Maps an HTTP status from the recovery endpoints to a failure kind. */
export function classifyRecoveryError(status: number): RecoveryFailure {
  if (status === 0) return 'network';
  if (status === 401) return 'invalid';
  if (status === 503) return 'unavailable';
  return 'unknown';
}

export function recoveryErrorMessage(failure: RecoveryFailure): string {
  switch (failure) {
    case 'invalid':
      return 'That code is invalid or has expired. Check the latest code in your email, or request a new one.';
    case 'unavailable':
      return 'Order recovery is not available right now. Please try again later, or contact customer care.';
    case 'network':
      return 'We could not reach the server. Check your connection and try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/**
 * Prevents overlapping submissions. start() returns false while a request is in
 * flight, so a double click or Enter key repeat sends one request only.
 */
export class SingleFlight {
  private busy = false;

  get isBusy(): boolean {
    return this.busy;
  }

  start(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }

  finish(): void {
    this.busy = false;
  }
}

/** Router commands for the recovered order page. The number is the only value in the path. */
export function recoveredOrderCommands(orderNumber: string): string[] {
  return ['/orders', String(orderNumber || '').trim()];
}
