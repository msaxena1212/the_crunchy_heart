import { Routes } from '@angular/router';

export const routes: Routes = [
    {
        path: '',
        loadComponent: () =>
            import('./app.component').then(m => m.AppComponent)
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