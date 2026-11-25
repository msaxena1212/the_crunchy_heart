import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

@Injectable({
  providedIn: 'root'
})
export class ScrollLockService {
  private readonly platformId = inject(PLATFORM_ID);
  private lockCount = 0;

  lock(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.lockCount++;
    if (this.lockCount === 1) {
      document.body.classList.add('modal-open');
    }
  }

  unlock(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.lockCount = Math.max(0, this.lockCount - 1);
    if (this.lockCount === 0) {
      document.body.classList.remove('modal-open');
    }
  }

  reset(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.lockCount = 0;
    document.body.classList.remove('modal-open');
  }
}
