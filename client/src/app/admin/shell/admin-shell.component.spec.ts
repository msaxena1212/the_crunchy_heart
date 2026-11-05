import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AdminService } from '../admin.service';
import { AdminShellComponent, ADMIN_NAV } from './admin-shell.component';

describe('AdminShellComponent navigation', () => {
  let service: any;

  beforeEach(async () => {
    service = {
      currentAdmin: signal({ id: 'a1', email: 'owner@example.test', fullName: 'Owner', role: 'ADMIN' }),
      logout: vi.fn(() => of({})),
    };
    await TestBed.configureTestingModule({
      imports: [AdminShellComponent],
      providers: [provideRouter([]), { provide: AdminService, useValue: service }],
    }).compileComponents();
  });

  it('lists every module in the left navigation, grouped by function', () => {
    const paths = ADMIN_NAV.flatMap(g => g.items.map(i => i.path));
    for (const expected of [
      '/admin/dashboard', '/admin/orders', '/admin/payments', '/admin/refunds',
      '/admin/products', '/admin/inventory', '/admin/coupons', '/admin/customers',
      '/admin/analytics', '/admin/social',
    ]) {
      expect(paths).toContain(expected);
    }
    expect(ADMIN_NAV.map(g => g.title)).toEqual(['Overview', 'Sales', 'Catalogue', 'Customers', 'Marketing']);
  });

  it('renders the navigation in the sidebar, not in a top bar', () => {
    const fixture = TestBed.createComponent(AdminShellComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const sidebar = el.querySelector('aside.sidebar');
    expect(sidebar).not.toBeNull();
    const links = Array.from(sidebar!.querySelectorAll('a.nav-link')).map(a => a.textContent?.trim());
    expect(links).toEqual(expect.arrayContaining(['Dashboard', 'Orders', 'Payments', 'Refund reviews', 'Products', 'Social media']));
    expect(el.querySelector('header.admin-navbar')).toBeNull();
  });

  it('signs out and returns to the login page', () => {
    const fixture = TestBed.createComponent(AdminShellComponent);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    fixture.componentInstance.onLogout();
    expect(service.logout).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/admin/login']);
  });

  it('still returns to login if sign-out fails', () => {
    service.logout.mockReturnValueOnce(throwError(() => new Error('network')));
    const fixture = TestBed.createComponent(AdminShellComponent);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    fixture.componentInstance.onLogout();
    expect(navigate).toHaveBeenCalledWith(['/admin/login']);
  });
});
