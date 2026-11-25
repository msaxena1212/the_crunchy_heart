import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScrollLockService } from './scroll-lock.service';

describe('ScrollLockService', () => {
  let service: ScrollLockService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ScrollLockService]
    });
    service = TestBed.inject(ScrollLockService);
    document.body.classList.remove('modal-open');
    service.reset();
  });

  afterEach(() => {
    document.body.classList.remove('modal-open');
    service.reset();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should add modal-open class to document.body on lock', () => {
    service.lock();
    expect(document.body.classList.contains('modal-open')).toBe(true);
  });

  it('should support reference counting for multiple locks and unlocks', () => {
    service.lock(); // count = 1
    service.lock(); // count = 2
    expect(document.body.classList.contains('modal-open')).toBe(true);

    service.unlock(); // count = 1
    expect(document.body.classList.contains('modal-open')).toBe(true);

    service.unlock(); // count = 0
    expect(document.body.classList.contains('modal-open')).toBe(false);
  });

  it('should reset lock count and remove modal-open class', () => {
    service.lock();
    service.lock();
    expect(document.body.classList.contains('modal-open')).toBe(true);

    service.reset();
    expect(document.body.classList.contains('modal-open')).toBe(false);
  });
});
