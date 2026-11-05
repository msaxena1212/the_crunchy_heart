import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminService } from '../admin.service';
import { AdminAnalyticsComponent } from './admin-analytics.component';

describe('AdminAnalyticsComponent', () => {
  let fixture: ComponentFixture<AdminAnalyticsComponent>;
  let service: any;

  beforeEach(async () => {
    service = {
      currentAdmin: signal(null),
      getIntegrations: vi.fn(() => of({
        success: true,
        analytics: { connected: false, missingConfig: ['GA_PROPERTY_ID', 'GOOGLE_APPLICATION_CREDENTIALS'] },
        socialAccounts: {
          instagram: { connected: false, missingConfig: [] },
          tiktok: { connected: false, missingConfig: [] },
          youtube: { connected: false, missingConfig: [] },
          pinterest: { connected: false, missingConfig: [] },
        },
      })),
    };
    await TestBed.configureTestingModule({
      imports: [AdminAnalyticsComponent],
      providers: [provideRouter([]), { provide: AdminService, useValue: service }],
    }).compileComponents();
    fixture = TestBed.createComponent(AdminAnalyticsComponent);
    fixture.detectChanges();
  });

  it('states that analytics is not connected and names the missing settings', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Not connected');
    expect(text).toContain('GA_PROPERTY_ID');
    expect(text).toContain('GOOGLE_APPLICATION_CREDENTIALS');
  });

  it('shows no placeholder figures before the property is connected', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('No figures are shown until the property is connected');
    expect(text).not.toMatch(/\d{2,}\s*(visits|sessions|users)/i);
  });
});
