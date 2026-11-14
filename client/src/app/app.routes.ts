import { Routes } from '@angular/router';
import { adminAuthGuard } from './admin/admin.guard';

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
        path: 'shop',
        loadComponent: () =>
            import('./category/category.component')
                .then(m => m.CategoryComponent),
        data: { slug: 'all' }
    },

    {
        path: 'category/:slug',
        loadComponent: () =>
            import('./category/category.component')
                .then(m => m.CategoryComponent)
    },

    {
        path: 'bulk',
        loadComponent: () =>
            import('./bulk/bulk.component')
                .then(m => m.BulkComponent)
    },

    {
        path: 'cart',
        loadComponent: () =>
            import('./cart/cart.component')
                .then(m => m.CartComponent)
    },

    {
        path: 'checkout',
        loadComponent: () =>
            import('./checkout/checkout.component')
                .then(m => m.CheckoutComponent)
    },

    {
        path: 'recover-order',
        loadComponent: () =>
            import('./recover-order/recover-order.component')
                .then(m => m.RecoverOrderComponent)
    },

    {
        path: 'orders/:orderNumber',
        loadComponent: () =>
            import('./order-confirmation/order-confirmation.component')
                .then(m => m.OrderConfirmationComponent)
    },

    {
        path: 'order-confirmation',
        loadComponent: () =>
            import('./order-confirmation/order-confirmation.component')
                .then(m => m.OrderConfirmationComponent)
    },

    {
        path: 'payment/callback',
        loadComponent: () =>
            import('./order-confirmation/order-confirmation.component')
                .then(m => m.OrderConfirmationComponent)
    },

    // Owner console. Login is public; every other admin page sits under the shell, which applies the guard.
    {
        path: 'admin/login',
        loadComponent: () =>
            import('./admin/login/admin-login.component')
                .then(m => m.AdminLoginComponent)
    },
    {
        path: 'admin',
        canActivate: [adminAuthGuard],
        loadComponent: () =>
            import('./admin/shell/admin-shell.component')
                .then(m => m.AdminShellComponent),
        children: [
            { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
            {
                path: 'dashboard',
                loadComponent: () => import('./admin/dashboard/admin-dashboard.component').then(m => m.AdminDashboardComponent)
            },
            {
                path: 'orders',
                loadComponent: () => import('./admin/orders/admin-orders.component').then(m => m.AdminOrdersComponent)
            },
            {
                path: 'orders/:orderNumber',
                loadComponent: () => import('./admin/order-detail/admin-order-detail.component').then(m => m.AdminOrderDetailComponent)
            },
            {
                path: 'payments',
                loadComponent: () => import('./admin/payments/admin-payments.component').then(m => m.AdminPaymentsComponent)
            },
            {
                path: 'refunds',
                loadComponent: () => import('./admin/refunds/admin-refunds.component').then(m => m.AdminRefundsComponent)
            },
            {
                path: 'products',
                loadComponent: () => import('./admin/products/admin-products.component').then(m => m.AdminProductsComponent)
            },
            {
                path: 'products/:productId',
                loadComponent: () => import('./admin/products/admin-product-edit.component').then(m => m.AdminProductEditComponent)
            },
            {
                path: 'inventory',
                loadComponent: () => import('./admin/inventory/admin-inventory.component').then(m => m.AdminInventoryComponent)
            },
            {
                path: 'coupons',
                loadComponent: () => import('./admin/coupons/admin-coupons.component').then(m => m.AdminCouponsComponent)
            },
            {
                path: 'customers',
                loadComponent: () => import('./admin/customers/admin-customers.component').then(m => m.AdminCustomersComponent)
            },
            {
                path: 'analytics',
                loadComponent: () => import('./admin/analytics/admin-analytics.component').then(m => m.AdminAnalyticsComponent)
            },
            {
                path: 'social',
                loadComponent: () => import('./admin/social/admin-social.component').then(m => m.AdminSocialComponent)
            },
        ]
    },

    {
        path: '**',
        redirectTo: ''
    }
];