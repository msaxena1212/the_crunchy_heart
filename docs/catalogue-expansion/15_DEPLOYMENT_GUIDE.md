# THE CRUNCHY HEART — Complete Product Catalogue Expansion
## Document 15: Staging & Production Deployment Operations Guide

**Date**: November 18, 2026  
**Target Host**: AWS EC2 Staging Instance (`3.7.248.4`)  
**Repository Directory**: `/var/www/the-crunchy-heart-staging`  
**Neon Branch**: `br-icy-glade-b5g747q0` (Staging)

---

### 1. Pre-Deployment Step: Staging Neon Database Migration

Before deploying application code, apply the additive migration and seed script to the Neon Staging branch:

```bash
# From workspace root
node server/src/scripts/apply-master-catalogue-staging.mjs
```
*Guarantees: Zero tables dropped, zero columns altered, zero foreign keys deleted.*

---

### 2. Application Deployment Sequence on EC2

#### Step 1: Connect to EC2 Server
```bash
ssh -i "E:\The Crunchy Heart\the-crunchy-heart-staging.pem" ubuntu@3.7.248.4
```
*(Ensure your public IP is whitelisted in Security Group `sg-07b96f8f20a6bc09c` on port 22).*

#### Step 2: Pull Latest Commits
```bash
cd /var/www/the-crunchy-heart-staging
git pull origin main
```

#### Step 3: Install Dependencies (if changed)
```bash
npm --prefix server install --omit=dev
npm --prefix client install
```

#### Step 4: Build Storefront Client
```bash
npm --prefix client run build
```

#### Step 5: Restart Backend Service & Reload Nginx
```bash
# Restart Node.js backend daemon
sudo systemctl restart crunchy-heart-staging
# Or if managed by PM2:
# pm2 restart crunchy-heart-staging

# Reload Nginx web server
sudo systemctl reload nginx
```

---

### 3. Post-Deployment Verification Commands

Run these smoke tests on the live staging domain:
```bash
# 1. Storefront homepage
curl -I https://staging.thecrunchyheart.com/

# 2. Categories API
curl -s https://staging.thecrunchyheart.com/api/categories | jq .

# 3. Dedicated Dry Fruits category PLP
curl -I https://staging.thecrunchyheart.com/category/dry-fruits

# 4. Product details API (verifying price & variant structure)
curl -s https://staging.thecrunchyheart.com/api/products/premium-almond | jq .

# 5. Customer OTP request API
curl -X POST https://staging.thecrunchyheart.com/api/auth/customer/otp/request \
  -H "Content-Type: application/json" \
  -d '{"phone": "9876543210"}'
```
All commands should return `200 OK` responses.
