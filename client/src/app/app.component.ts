
import { CommonModule } from '@angular/common';
import { Component, DestroyRef, inject } from '@angular/core';
import {
  NavigationEnd,
  Router,
  RouterOutlet,
} from '@angular/router';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { StorefrontHeader } from './shared/storefront-header/storefront-header';
import { StorefrontFooter } from './shared/storefront-footer/storefront-footer';
import { MiniCartDrawerComponent } from './shared/mini-cart-drawer/mini-cart-drawer.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    StorefrontHeader,
    StorefrontFooter,
    MiniCartDrawerComponent,
  ],
  template: `
    <tch-storefront-header
      *ngIf="showStorefrontShell">
    </tch-storefront-header>

    <router-outlet></router-outlet>

    <tch-mini-cart-drawer
      *ngIf="showStorefrontShell">
    </tch-mini-cart-drawer>

    <tch-storefront-footer
      *ngIf="showStorefrontShell">
    </tch-storefront-footer>
  `,
})
export class AppComponent {
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  showStorefrontShell = !this.router.url.startsWith('/admin');

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd =>
          event instanceof NavigationEnd
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        this.showStorefrontShell =
          !event.urlAfterRedirects.startsWith('/admin');
      });
  }
}
