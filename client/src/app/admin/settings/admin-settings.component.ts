import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminService } from '../admin.service';
import { StoreInfoService } from '../../shared/store-info.service';

@Component({
  selector: 'app-admin-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <section class="settings-page">
      <header class="page-head">
        <h1>Business settings</h1>
        <p>Details shown to customers across the storefront.</p>
      </header>

      <form class="settings-card" (ngSubmit)="save()" #f="ngForm">
        <label for="fssai">FSSAI licence number</label>
        <input id="fssai" name="fssai" type="text" inputmode="numeric" maxlength="14"
               autocomplete="off" placeholder="14-digit licence number"
               [(ngModel)]="fssai" [disabled]="loading || saving" />
        <p class="hint">
          Shown in the storefront footer, on product pages and on order pages. Leave empty to hide it.
        </p>

        <p *ngIf="message" class="msg ok" role="status">{{ message }}</p>
        <p *ngIf="error" class="msg bad" role="alert">{{ error }}</p>

        <button type="submit" class="save-btn" [disabled]="loading || saving">
          {{ saving ? 'Saving...' : 'Save changes' }}
        </button>
      </form>
    </section>
  `,
  styles: [`
    .settings-page { max-width: 640px; }
    .page-head h1 { margin: 0 0 4px; font-size: 2rem; }
    .page-head p { margin: 0 0 20px; color: #667085; }
    .settings-card { background: #fff; border: 1px solid #e4e7ec; border-radius: 14px; padding: 20px; display: grid; gap: 10px; }
    label { font-weight: 600; }
    input { padding: 10px 12px; border: 1px solid #d0d5dd; border-radius: 8px; font: inherit; letter-spacing: .06em; }
    .hint { margin: 0; color: #667085; font-size: .9rem; }
    .msg { margin: 0; padding: 10px 12px; border-radius: 8px; }
    .ok { background: #ecfdf3; color: #067647; }
    .bad { background: #fdecea; color: #b42318; }
    .save-btn { justify-self: start; background: #1e392a; color: #fff; border: 0; border-radius: 10px; padding: 10px 20px; font-weight: 600; cursor: pointer; }
    .save-btn:disabled { opacity: .6; cursor: not-allowed; }
  `],
})
export class AdminSettingsComponent implements OnInit {
  private readonly admin = inject(AdminService);
  private readonly storeInfo = inject(StoreInfoService);

  fssai = '';
  loading = true;
  saving = false;
  message = '';
  error = '';

  ngOnInit(): void {
    this.admin.getBusinessSettings().subscribe({
      next: (res) => { this.fssai = res.fssaiLicenseNumber || ''; this.loading = false; },
      error: () => { this.error = 'Could not load settings.'; this.loading = false; },
    });
  }

  save(): void {
    this.message = '';
    this.error = '';
    const value = this.fssai.replace(/\s+/g, '');
    if (value && !/^\d{14}$/.test(value)) {
      this.error = 'FSSAI licence number must be exactly 14 digits.';
      return;
    }
    this.saving = true;
    this.admin.saveBusinessSettings(value).subscribe({
      next: (res) => {
        this.saving = false;
        this.fssai = res.fssaiLicenseNumber || '';
        this.message = res.fssaiLicenseNumber ? 'FSSAI number saved and now visible on the storefront.' : 'FSSAI number cleared.';
        this.storeInfo.refresh();
      },
      error: (err) => {
        this.saving = false;
        this.error = err.error?.message || err.error?.error?.message || 'Could not save settings.';
      },
    });
  }
}
