# THE CRUNCHY HEART — Complete Product Catalogue Expansion
## Document 10: Storefront & Admin API Specifications

**Date**: November 18, 2026  
**Scope**: REST API Endpoints, Request/Response Payloads, Authentication & Privacy Rules

---

### 1. Public Storefront Catalogue APIs

#### A. List Categories
- **`GET /api/categories`**
- **Description**: Returns all active customer-facing categories ordered by `sort_order`.
- **Response `200 OK`**:
```json
{
  "categories": [
    {
      "id": "c1f7a28e-...",
      "name": "Dry Fruits & Nuts",
      "slug": "dry-fruits",
      "description": "Hand-picked almonds, cashews, walnuts, raisins and exotic dried fruits.",
      "imageUrl": "assets/categories/dry-fruits.webp",
      "sortOrder": 3
    }
  ]
}
```

#### B. List Products
- **`GET /api/products`**
- **Query Parameters**:
  - `category` (optional, slug string)
  - `subcategory` (optional, slug string)
  - `search` (optional, string)
  - `limit` (default: 50)
- **Security Rule**: Excludes `cost_price`, `supplier_id`, and products where `publication_status != 'active'`.
- **Response `200 OK`**:
```json
{
  "products": [
    {
      "id": "p9b2c3d1-...",
      "name": "Mamra Almond",
      "slug": "mamra-almond",
      "brand": "The Crunchy Heart",
      "category": { "name": "Dry Fruits & Nuts", "slug": "dry-fruits" },
      "subcategory": { "name": "Almonds", "slug": "almonds" },
      "imageUrl": "assets/products/mamra-almond.webp",
      "variants": [
        {
          "id": "v1a2b3c4-...",
          "sku": "TCH-ALM-MAMRA-250G",
          "name": "250g",
          "weightGrams": 250,
          "sellingPrice": 1200,
          "mrp": 1400,
          "taxRate": 5.0,
          "badge": "Premium Pick",
          "inventory": { "availableQuantity": 20 }
        }
      ]
    }
  ]
}
```

#### C. Get Product Details
- **`GET /api/products/:slug`**
- **Description**: Detailed product data for PDP view.

---

### 2. Customer Auth & Account APIs

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `POST` | `/api/auth/customer/otp/request` | Requests 6-digit OTP for mobile number. | Public |
| `POST` | `/api/auth/customer/otp/verify` | Validates OTP (`111111`) and issues Bearer JWT. | Public |
| `GET` | `/api/auth/customer/me` | Fetches active customer profile. | Bearer Token |
| `GET` | `/api/auth/customer/orders` | Retrieves customer past order history. | Bearer Token |
| `PUT` | `/api/auth/customer/profile` | Updates customer Name and Email. | Bearer Token |

---

### 3. Admin Catalogue & Inventory Management APIs

*All endpoints require `Authorization: Bearer <ADMIN_SESSION_TOKEN>`.*

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/admin/products` | Lists products with stock on hand, reservations, selling price, and internal cost price. |
| `GET` | `/api/admin/products/:id` | Returns complete product detail and editable variant list. |
| `PUT` | `/api/admin/products/:id` | Updates name, description, active flag, image URL, and publication status. |
| `PUT` | `/api/admin/variants/:id` | Updates MRP, selling price, cost price, and active status. |
| `GET` | `/api/admin/inventory` | Live stock on hand, reservations, and reorder levels. |
| `POST` | `/api/admin/inventory/adjust` | Records an immutable stock adjustment ledger entry. |
