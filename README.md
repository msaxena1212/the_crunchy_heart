# The Crunchy Heart — MEAN-style Ecommerce Starter with Neon PostgreSQL

Premium Makhana ecommerce website for **thecrunchyheart.com**.

## Stack

- **Angular 20** — storefront UI
- **Node.js + Express** — REST API
- **Neon PostgreSQL** — cloud database
- **@neondatabase/serverless** — Neon connection from Node.js

> The project keeps the MEAN-style application structure, but uses **Neon PostgreSQL instead of MongoDB**. This is intentional because the commerce domain will benefit from relational data for products, variants, inventory, orders, payments and reporting.

## Product catalogue

### Raw Makhana
- 100g
- 200g
- 500g
- 1kg

### Flavoured Makhana
- Himalayan Salt — 70g
- Peri Peri — 70g
- Pudina — 70g
- Cream & Onion — 70g

## 1. Create the Neon database

Create a Neon project and copy its pooled or direct connection string.

Run `database/schema.sql` against the Neon SQL Editor.

## 2. Configure backend

```bash
cd server
npm install
```

Create `.env` from `.env.example`:

```env
PORT=5000
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require
CLIENT_URL=http://localhost:4200
```

Start:

```bash
npm run dev
```

API: `http://localhost:5000/api`

## 3. Seed initial products

After the API is running:

```bash
curl -X POST http://localhost:5000/api/products/seed
```

Or open the endpoint with a REST client.

## 4. Frontend

```bash
cd client
npm install
npm start
```

App: `http://localhost:4200`

## API

- `GET /api/health`
- `GET /api/products`
- `POST /api/products/seed`
- `POST /api/orders`

## Planned production modules

- Product/variant management
- Inventory and batch management
- Cart and checkout
- Razorpay payments
- COD
- Customer accounts
- Coupons
- Reviews
- Order lifecycle
- Shipping integration
- WhatsApp notifications
- Email notifications
- Meta Pixel + Conversions API
- Google Analytics
- Admin dashboard
