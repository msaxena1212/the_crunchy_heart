#!/usr/bin/env bash
# ==============================================================================
# The Crunchy Heart — AWS Deployment Script
# Builds Angular storefront, updates API releases, switches symlink, and reloads
# ==============================================================================
set -euo pipefail

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RELEASE_DIR="/var/www/thecrunchyheart-api/releases/${TIMESTAMP}"

echo ">>> [1/5] Building Angular Storefront..."
cd client
npm ci
npm run build -- --configuration production
cd ..

echo ">>> [2/5] Deploying Storefront Static Assets to Nginx..."
sudo rm -rf /var/www/thecrunchyheart/browser/*
sudo cp -r client/dist/the-crunchy-heart/browser/* /var/www/thecrunchyheart/browser/
sudo chown -R www-data:www-data /var/www/thecrunchyheart

echo ">>> [3/5] Packaging API Release (${TIMESTAMP})..."
sudo mkdir -p "${RELEASE_DIR}"
sudo cp -r server/src "${RELEASE_DIR}/"
sudo cp server/package.json "${RELEASE_DIR}/"
sudo cp server/package-lock.json "${RELEASE_DIR}/"

echo ">>> Installing production API dependencies..."
cd "${RELEASE_DIR}"
sudo npm ci --omit=dev
sudo chown -R tch-api:tch-api "${RELEASE_DIR}"
cd -

echo ">>> [4/5] Updating 'current' release symlink..."
sudo ln -sfn "${RELEASE_DIR}" /var/www/thecrunchyheart-api/current
sudo chown -h tch-api:tch-api /var/www/thecrunchyheart-api/current

echo ">>> [5/5] Reloading services..."
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl restart thecrunchyheart-api

# Keep only the last 5 releases
cd /var/www/thecrunchyheart-api/releases
sudo ls -1dt * | tail -n +6 | xargs sudo rm -rf 2>/dev/null || true

echo ">>> Deployment successful! Service status:"
sudo systemctl status thecrunchyheart-api --no-pager

