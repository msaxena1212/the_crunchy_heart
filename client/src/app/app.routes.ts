import { Routes } from '@angular/router';

export const routes: Routes = [
    {
        path: '',
        pathMatch: 'full',
        loadComponent: () =>
            import('./home.component')
                .then(m => m.HomeComponent)
    },

    {
        path: 'product/:slug',
        loadComponent: () =>
            import('./product-detail/product-detail.component')
                .then(m => m.ProductDetailComponent)
    },

    {
        path: '**',
        redirectTo: ''
    }
];