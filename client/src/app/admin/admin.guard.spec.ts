import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter, Router, UrlTree } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { AdminService } from './admin.service';
import { adminAuthGuard } from './admin.guard';
import { routes } from '../app.routes';

const route = {} as any;
const state = { url: '/admin/payments' } as any;

describe('adminAuthGuard', () => {
  it('redirects an unauthenticated visitor to the admin login', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideRouter([])] });
    const service = TestBed.inject(AdminService);
    service.currentAdmin.set(null);

    const result = TestBed.runInInjectionContext(() => adminAuthGuard(route, state));

    expect(result).toBeInstanceOf(UrlTree);
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe('/admin/login');
  });

  it('allows an authenticated administrator through', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideRouter([])] });
    const service = TestBed.inject(AdminService);
    service.currentAdmin.set({ id: 'a1', email: 'owner@example.test', fullName: 'Owner', role: 'ADMIN' });

    const result = TestBed.runInInjectionContext(() => adminAuthGuard(route, state));

    expect(result).toBe(true);
  });
});

describe('admin route table', () => {
  it('protects the owner console with the guard, and nests every page under it', () => {
    const shell = routes.find(r => r.path === 'admin');
    expect(shell, 'the owner console route exists').toBeDefined();
    expect(shell!.canActivate).toEqual([adminAuthGuard]);
    const pages = (shell!.children ?? []).map(r => r.path);
    for (const expected of ['dashboard', 'orders', 'orders/:orderNumber', 'payments', 'refunds', 'products', 'inventory', 'coupons', 'customers', 'analytics', 'social']) {
      expect(pages, expected).toContain(expected);
    }
  });

  it('keeps the login page public', () => {
    const login = routes.find(r => r.path === 'admin/login');
    expect(login).toBeDefined();
    expect(login!.canActivate).toBeUndefined();
  });
});
