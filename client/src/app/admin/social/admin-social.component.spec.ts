import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminService } from '../admin.service';
import { AdminSocialComponent } from './admin-social.component';

const DRAFT = {
  id: 'draft-1',
  platform: 'instagram',
  title: 'Launch',
  body: 'Crunchy and light.',
  mediaUrl: null,
  status: 'draft',
  createdAt: '2026-11-02T08:00:00Z',
  updatedAt: '2026-11-02T08:00:00Z',
};

function integrations(connected: Record<string, boolean>) {
  const status = (name: string) => ({
    connected: !!connected[name],
    missingConfig: connected[name] ? [] : [`${name.toUpperCase()}_ACCESS_TOKEN`],
  });
  return {
    success: true,
    analytics: { connected: false, missingConfig: ['GA_PROPERTY_ID'] },
    socialAccounts: {
      instagram: status('instagram'),
      tiktok: status('tiktok'),
      youtube: status('youtube'),
      pinterest: status('pinterest'),
    },
  };
}

describe('AdminSocialComponent', () => {
  let service: any;
  let fixture: ComponentFixture<AdminSocialComponent>;
  let component: AdminSocialComponent;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const publishButton = (): HTMLButtonElement | undefined =>
    Array.from(el().querySelectorAll('button')).find(b => b.textContent?.trim() === 'Publish') as HTMLButtonElement | undefined;

  beforeEach(async () => {
    service = {
      currentAdmin: signal(null),
      getIntegrations: vi.fn(() => of(integrations({}))),
      getSocialDrafts: vi.fn(() => of({ success: true, drafts: [DRAFT] })),
      createSocialDraft: vi.fn(() => of({ success: true, draft: DRAFT })),
      updateSocialDraft: vi.fn(() => of({ success: true, draft: DRAFT })),
      publishSocialDraft: vi.fn(() => of({ success: true })),
    };
    await TestBed.configureTestingModule({
      imports: [AdminSocialComponent],
      providers: [provideRouter([]), { provide: AdminService, useValue: service }],
    }).compileComponents();
    fixture = TestBed.createComponent(AdminSocialComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('keeps Publish disabled while the platform account is not connected', () => {
    expect(component.canPublish).toBe(false);
    expect(publishButton()?.disabled).toBe(true);
    expect(el().textContent).toContain('INSTAGRAM_ACCESS_TOKEN is missing');
  });

  it('refuses a publish click when the account is not connected, so nothing is sent', () => {
    component.publish(DRAFT as any);
    expect(service.publishSocialDraft).not.toHaveBeenCalled();
  });

  it('enables Publish only when the account is connected, and still reports the server refusal', () => {
    service.getIntegrations.mockReturnValue(of(integrations({ instagram: true })));
    component.loadIntegrations();
    fixture.detectChanges();
    expect(publishButton()?.disabled).toBe(false);

    service.publishSocialDraft.mockReturnValueOnce(throwError(() => ({ status: 409, error: { message: 'Publishing is not available in this build yet. The draft is saved.' } })));
    component.publish(DRAFT as any);
    fixture.detectChanges();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('Publishing is not available');
  });

  it('shows the drafts for the selected platform', () => {
    expect(el().textContent).toContain('Launch');
    component.selectPlatform('tiktok');
    expect(service.getSocialDrafts).toHaveBeenLastCalledWith('tiktok');
  });

  it('does not allow a media link that is not https', () => {
    component.form = { title: 'T', body: 'B', mediaUrl: 'http://example.test/a.jpg' };
    expect(component.formValid).toBe(false);
    component.form = { title: 'T', body: 'B', mediaUrl: 'https://example.test/a.jpg' };
    expect(component.formValid).toBe(true);
  });

  it('saves a new draft once, and states it has not been published', () => {
    component.form = { title: 'New', body: 'Body text', mediaUrl: '' };
    component.save();
    component.save();
    expect(service.createSocialDraft).toHaveBeenCalledTimes(1);
    expect(service.createSocialDraft).toHaveBeenCalledWith({ platform: 'instagram', title: 'New', body: 'Body text', mediaUrl: null });
    expect(component.infoMessage).toContain('has not been published');
  });

  it('edits an existing draft through the update call', () => {
    component.edit(DRAFT as any);
    component.form.body = 'Updated text';
    component.save();
    expect(service.updateSocialDraft).toHaveBeenCalledWith('draft-1', expect.objectContaining({ body: 'Updated text' }));
  });

  it('sends the operator to login on 403', () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    service.createSocialDraft.mockReturnValueOnce(throwError(() => ({ status: 403, error: {} })));
    component.form = { title: 'T', body: 'B', mediaUrl: '' };
    component.save();
    expect(navigate).toHaveBeenCalledWith(['/admin/login']);
  });
});
