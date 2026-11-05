#!/usr/bin/env bash
# ==============================================================================
# The Crunchy Heart — AWS EC2 Instance Bootstrap Script (Ubuntu LTS)
# Installs Node.js 22 LTS, Nginx, Certbot, creates service user & directories
# ==============================================================================
set -euo pipefail

echo ">>> [1/7] Updating apt packages..."
sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y curl git ufw nginx certbot python3-certbot-nginx

echo ">>> [2/7] Installing Node.js 22 LTS..."
if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
node -v
npm -v

echo ">>> [3/7] Creating service user tch-api and application directories..."
if ! id "tch-api" &>/dev/null; then
    sudo useradd --system --no-create-home --shell /bin/false tch-api
fi

sudo mkdir -p /var/www/thecrunchyheart/browser
sudo mkdir -p /var/www/thecrunchyheart-api/releases
sudo mkdir -p /etc/thecrunchyheart
sudo mkdir -p /var/www/certbot

sudo chown -R www-data:www-data /var/www/thecrunchyheart
sudo chown -R tch-api:tch-api /var/www/thecrunchyheart-api
sudo chmod 750 /etc/thecrunchyheart

echo ">>> [4/7] Installing Nginx configuration..."
sudo cp deploy/nginx/thecrunchyheart.conf /etc/nginx/sites-available/thecrunchyheart.conf
if [ -f /etc/nginx/sites-enabled/default ]; then
    sudo rm /etc/nginx/sites-enabled/default
fi
if [ ! -f /etc/nginx/sites-enabled/thecrunchyheart.conf ]; then
    sudo ln -s /etc/nginx/sites-available/thecrunchyheart.conf /etc/nginx/sites-enabled/
fi

echo ">>> [5/7] Installing systemd service..."
sudo cp deploy/systemd/thecrunchyheart-api.service /etc/systemd/system/thecrunchyheart-api.service
sudo systemctl daemon-reload

echo ">>> [6/7] Configuring UFW Firewall..."
sudo ufw allow 'Nginx Full'
sudo ufw allow OpenSSH
sudo ufw --force enable

echo ">>> [7/7] Setup complete!"
echo "Next steps:"
echo "1. Create /etc/thecrunchyheart/api.env with your production credentials."
echo "2. Obtain SSL certificate: sudo certbot --nginx -d thecrunchyheart.com -d www.thecrunchyheart.com"
echo "3. Run deploy/aws-deploy.sh to deploy the application."

