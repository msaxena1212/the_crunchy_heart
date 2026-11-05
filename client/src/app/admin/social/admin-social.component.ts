import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AdminIntegrationsResponse, AdminService, SocialDraft, SocialPlatform } from '../admin.service';

export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatform, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  pinterest: 'Pinterest',
};

const BODY_LIMIT = 2200;
const TITLE_LIMIT = 200;

@Component({
  selector: 'app-admin-social',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-social.component.html',
  styleUrls: ['../admin-shared.css'],
})
export class AdminSocialComponent implements OnInit {
  private adminService = inject(AdminService);
  private router = inject(Router);

  readonly platforms: SocialPlatform[] = ['instagram', 'tiktok', 'youtube', 'pinterest'];
  readonly labels = SOCIAL_PLATFORM_LABELS;
  readonly bodyLimit = BODY_LIMIT;
  readonly titleLimit = TITLE_LIMIT;

  platform: SocialPlatform = 'instagram';
  integrations: AdminIntegrationsResponse | null = null;
  drafts: SocialDraft[] = [];

  editingId: string | null = null;
  form = { title: '', body: '', mediaUrl: '' };

  isLoading = true;
  isSaving = false;
  busy = false;
  errorMessage = '';
  infoMessage = '';

  ngOnInit(): void {
    this.loadIntegrations();
    this.loadDrafts();
  }

  selectPlatform(platform: SocialPlatform): void {
    this.platform = platform;
    this.resetForm();
    this.loadDrafts();
  }

  get accountStatus() {
    return this.integrations?.socialAccounts[this.platform] ?? null;
  }

  get canPublish(): boolean {
    return Boolean(this.accountStatus?.connected);
  }

  get formValid(): boolean {
    const title = this.form.title.trim();
    const body = this.form.body.trim();
    const media = this.form.mediaUrl.trim();
    const mediaOk = !media || /^https:\/\/\S+$/.test(media);
    return title.length > 0 && title.length <= TITLE_LIMIT && body.length > 0 && body.length <= BODY_LIMIT && mediaOk;
  }

  loadIntegrations(): void {
    this.adminService.getIntegrations().subscribe({
      next: res => { this.integrations = res; },
      error: err => this.onError(err),
    });
  }

  /** keepMessages preserves the outcome of an action that just ran. */
  loadDrafts(keepMessages = false): void {
    this.isLoading = true;
    if (!keepMessages) this.clearMessages();
    this.adminService.getSocialDrafts(this.platform).subscribe({
      next: res => { this.isLoading = false; this.drafts = res.drafts; },
      error: err => this.onError(err),
    });
  }

  edit(draft: SocialDraft): void {
    this.editingId = draft.id;
    this.form = { title: draft.title, body: draft.body, mediaUrl: draft.mediaUrl ?? '' };
    this.clearMessages();
  }

  resetForm(): void {
    this.editingId = null;
    this.form = { title: '', body: '', mediaUrl: '' };
  }

  save(): void {
    if (!this.formValid || this.isSaving) return;
    this.isSaving = true;
    this.clearMessages();
    const input = {
      platform: this.platform,
      title: this.form.title.trim(),
      body: this.form.body.trim(),
      mediaUrl: this.form.mediaUrl.trim() || null,
    };
    const request = this.editingId
      ? this.adminService.updateSocialDraft(this.editingId, input)
      : this.adminService.createSocialDraft(input);

    request.subscribe({
      next: () => {
        this.isSaving = false;
        this.infoMessage = this.editingId ? 'Draft updated.' : 'Draft saved. It has not been published.';
        this.resetForm();
        this.loadDrafts(true);
      },
      error: err => {
        this.isSaving = false;
        this.handleError(err);
      },
    });
  }

  publish(draft: SocialDraft): void {
    if (!this.canPublish || this.busy) return;
    this.busy = true;
    this.clearMessages();
    this.adminService.publishSocialDraft(draft.id).subscribe({
      next: () => {
        this.busy = false;
        this.infoMessage = 'Published.';
        this.loadDrafts(true);
      },
      error: err => {
        this.busy = false;
        this.handleError(err);
      },
    });
  }

  private handleError(err: { status?: number; error?: { message?: string } }): void {
    if (err?.status === 401 || err?.status === 403) {
      this.router.navigate(['/admin/login']);
      return;
    }
    this.errorMessage = err?.error?.message || 'The request failed. Please retry.';
  }

  private onError(err: { status?: number; error?: { message?: string } }): void {
    this.isLoading = false;
    this.handleError(err);
  }

  private clearMessages(): void {
    this.errorMessage = '';
    this.infoMessage = '';
  }
}
