import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ProductService } from '../product.service';
import { Product, ProductVariant } from '../product.model';
import { CartService } from '../cart.service';

@Component({
    selector: 'app-product-detail',
    standalone: true,
    imports: [CommonModule, RouterLink],
    templateUrl: './product-detail.component.html',
    styleUrl: './product-detail.component.css'
})
export class ProductDetailComponent implements OnInit {
    private readonly route = inject(ActivatedRoute);
    private readonly router = inject(Router);
    private readonly productService = inject(ProductService);
    private readonly cartService = inject(CartService);

    product: Product | null = null;
    selectedVariant: ProductVariant | null = null;

    loading = true;
    error = '';
    quantity = 1;
    addedToCart = false;

    ngOnInit(): void {
        this.route.paramMap.subscribe(params => {
            const slug = params.get('slug');

            if (!slug) {
                this.error = 'Product not found.';
                this.loading = false;
                return;
            }

            this.loadProduct(slug);
        });
    }

    private loadProduct(slug: string): void {
        this.loading = true;
        this.error = '';

        this.productService.getProductBySlug(slug).subscribe({
            next: product => {
                this.product = product;
                this.selectedVariant = product.variant ?? product.variants?.[0] ?? null;
                this.loading = false;
            },
            error: error => {
                console.error('Product detail error:', error);
                this.error = 'We could not load this product right now.';
                this.loading = false;
            }
        });
    }

    selectVariant(variant: ProductVariant): void {
        this.selectedVariant = variant;
        this.quantity = 1;
        this.addedToCart = false;
    }

    increaseQuantity(): void {
        const available = this.selectedVariant?.inventory?.availableQuantity ?? 0;

        if (this.quantity < available) {
            this.quantity++;
        }
    }

    decreaseQuantity(): void {
        if (this.quantity > 1) {
            this.quantity--;
        }
    }

    get availableQuantity(): number {
        return this.selectedVariant?.inventory?.availableQuantity ?? 0;
    }

    get isAvailable(): boolean {
        return this.availableQuantity > 0;
    }

    get selectedPrice(): number {
        return Number(this.selectedVariant?.sellingPrice ?? 0);
    }

    get selectedImage(): string {
        const sku = this.selectedVariant?.sku ?? '';

        const imageMap: Record<string, string> = {
            'TCH-RAW-100': 'assets/raw-makhana-100g.png',
            'TCH-RAW-200': 'assets/raw-makhana-200g.png',
            'TCH-RAW-500': 'assets/raw-makhana-500g.png',
            'TCH-RAW-1KG': 'assets/raw-makhana-1kg.png',

            'TCH-FLV-HIMALAYAN': 'assets/himalayan-salt.png',
            'TCH-FLV-PERI': 'assets/peri-peri.png',
            'TCH-FLV-PUDINA': 'assets/pudina.png',
            'TCH-FLV-ONION': 'assets/cream-onion.png',
            'TCH-FLV-TOMATO': 'assets/tomato-tangy.png',
            'TCH-FLV-CHILLI': 'assets/chilli-garlic.png',
            'TCH-FLV-BIHARI': 'assets/bihari-chat.png'
        };

        return imageMap[sku] ?? 'assets/raw-makhana-100g.png';
    }


    get variantLabel(): string {
        if (!this.selectedVariant) {
            return '';
        }

        if (this.selectedVariant.weightGrams) {
            return `${this.selectedVariant.weightGrams}g`;
        }

        return this.selectedVariant.flavor ?? this.selectedVariant.name;
    }

    addToCart(): void {
        if (!this.product || !this.selectedVariant || !this.isAvailable) {
            return;
        }

        this.cartService.addToCart({
            product: this.product,
            variant: this.selectedVariant,
            quantity: this.quantity
        });

        this.addedToCart = true;
    }

    buyNow(): void {
        this.addToCart();

        if (this.addedToCart) {
            this.router.navigate(['/cart']);
        }
    }
}