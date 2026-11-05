import { describe, it, expect } from 'vitest';
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

describe('Recovery input handling', () => {
  it('trims and lowercases the email before it is sent', () => {
    expect(normalizeRecoveryEmail('  Guest@Example.COM  ')).toBe('guest@example.com');
  });

  it('rejects blank and malformed email addresses', () => {
    expect(isValidRecoveryEmail('')).toBe(false);
    expect(isValidRecoveryEmail('no-at-sign.com')).toBe(false);
    expect(isValidRecoveryEmail('a b@example.com')).toBe(false);
    expect(isValidRecoveryEmail('guest@example.com')).toBe(true);
  });

  it('accepts exactly six digits, allowing spaces typed by the guest', () => {
    expect(normalizeRecoveryCode(' 123 456 ')).toBe('123456');
    expect(isValidRecoveryCode('123 456')).toBe(true);
    expect(isValidRecoveryCode('12345')).toBe(false);
    expect(isValidRecoveryCode('1234567')).toBe(false);
    expect(isValidRecoveryCode('12a456')).toBe(false);
    expect(isValidRecoveryCode('')).toBe(false);
  });
});

describe('Recovery errors', () => {
  it('maps HTTP statuses to failure kinds', () => {
    expect(classifyRecoveryError(0)).toBe('network');
    expect(classifyRecoveryError(401)).toBe('invalid');
    expect(classifyRecoveryError(503)).toBe('unavailable');
    expect(classifyRecoveryError(500)).toBe('unknown');
    expect(classifyRecoveryError(429)).toBe('unknown');
  });

  it('never shows raw status numbers or internal server codes', () => {
    for (const failure of ['invalid', 'unavailable', 'network', 'unknown'] as const) {
      const message = recoveryErrorMessage(failure);
      expect(message).not.toMatch(/\b[45]\d\d\b/);
      expect(message).not.toMatch(/RECOVERY_|EMAIL_|guest|token/i);
    }
  });

  it('tells the guest how to recover from an invalid code', () => {
    expect(recoveryErrorMessage('invalid')).toMatch(/request a new one/);
  });
});

describe('Double-submit prevention', () => {
  it('refuses a second start while busy until the first finishes', () => {
    const flight = new SingleFlight();
    expect(flight.start()).toBe(true);
    expect(flight.isBusy).toBe(true);
    expect(flight.start()).toBe(false);
    flight.finish();
    expect(flight.isBusy).toBe(false);
    expect(flight.start()).toBe(true);
  });
});

describe('Navigation after recovery', () => {
  it('opens the recovered order by number only, with no query string or token', () => {
    const commands = recoveredOrderCommands('  REC-ABC123  ');
    expect(commands).toEqual(['/orders', 'REC-ABC123']);
    for (const part of commands) {
      expect(part).not.toMatch(/[?&=#]/);
    }
  });
});
