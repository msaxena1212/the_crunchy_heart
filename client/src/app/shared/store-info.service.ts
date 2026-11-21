import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { getApiBaseUrl } from '../product.service';

/** Public store details managed from the admin portal (e.g. the FSSAI licence number). */
@Injectable({ providedIn: 'root' })
export class StoreInfoService {
  private readonly http = inject(HttpClient);
  readonly fssaiLicenseNumber = signal<string | null>(null);

  constructor() {
    this.refresh();
  }

  refresh(): void {
    this.http
      .get<{ success: boolean; fssaiLicenseNumber: string | null }>(`${getApiBaseUrl()}/store-info`)
      .subscribe({
        next: (res) => this.fssaiLicenseNumber.set(res.fssaiLicenseNumber || null),
        error: () => this.fssaiLicenseNumber.set(null),
      });
  }
}
