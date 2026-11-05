# The Crunchy Heart — AWS Deployment Guide

This directory contains the production infrastructure configuration for hosting **thecrunchyheart.com** on **AWS EC2** (Ubuntu LTS) with **Amazon RDS PostgreSQL**.

---

## Architecture Overview

```
                      HTTPS (:443)
Customers ───────────────────────────────────► Nginx Reverse Proxy (AWS EC2)
                                                 │
                                                 ├──► [/*] Serves Angular Storefront (/var/www/thecrunchyheart/browser)
                                                 │
                                                 └──► [/api/*] Proxies to Node.js Express (127.0.0.1:5000)
                                                                 │
                                                                 ▼ (TLS verify-full)
                                                         Amazon RDS PostgreSQL
                                                         (Private Subnet in ap-south-1)
```

- **Domain**: `thecrunchyheart.com` and `www.thecrunchyheart.com` (DNS managed on Hostinger).
- **Origin**: Unified Origin (both Storefront and API share the same domain to eliminate cross-origin cookie restrictions and preflight latency).
- **API Supervisor**: systemd unit `thecrunchyheart-api.service`.
- **Database**: AWS RDS PostgreSQL (Multi-AZ recommended, private VPC subnet).

---

## 1. Initial EC2 Instance Setup

1. **Launch an EC2 Instance**:
   - Region: `ap-south-1` (Mumbai).
   - AMI: Ubuntu 24.04 or 22.04 LTS.
   - Instance Type: `t3.medium` or `t4g.medium` (2 vCPU, 4 GiB).
   - Security Group:
     - Inbound `80` (HTTP from `0.0.0.0/0`)
     - Inbound `443` (HTTPS from `0.0.0.0/0`)
     - Inbound `22` (SSH restricted to your admin IP, or use AWS Systems Manager)

2. **Clone Repository & Run Bootstrap**:
   ```bash
   git clone <repo-url> /home/ubuntu/the-crunchy-heart
   cd /home/ubuntu/the-crunchy-heart
   chmod +x deploy/aws-setup.sh deploy/aws-deploy.sh
   ./deploy/aws-setup.sh
   ```

3. **Configure Environment Secrets**:
   Copy `deploy/production.env.example` to `/etc/thecrunchyheart/api.env`:
   ```bash
   sudo cp deploy/production.env.example /etc/thecrunchyheart/api.env
   sudo nano /etc/thecrunchyheart/api.env
   sudo chmod 600 /etc/thecrunchyheart/api.env
   sudo chown tch-api:tch-api /etc/thecrunchyheart/api.env
   ```

4. **Obtain SSL Certificate via Certbot**:
   Point your domain's A records to the EC2 Elastic IP first, then run:
   ```bash
   sudo certbot --nginx -d thecrunchyheart.com -d www.thecrunchyheart.com
   ```

---

## 2. Deploying the Application

Run the zero-downtime deployment script:
```bash
./deploy/aws-deploy.sh
```

This script:
1. Builds the Angular storefront in production mode.
2. Copies the static browser bundle to `/var/www/thecrunchyheart/browser`.
3. Creates a timestamped release in `/var/www/thecrunchyheart-api/releases/`.
4. Installs production Node dependencies (`npm ci --omit=dev`).
5. Atomically switches the `/var/www/thecrunchyheart-api/current` symlink.
6. Gracefully restarts the systemd service and reloads Nginx.

---

## 3. RDS Database Setup

1. Run the canonical database schema and production seed on RDS:
   ```bash
   PGPASSWORD="<db-password>" psql -h <rds-endpoint> -U tch_prod_app -d crunchy_heart -f database/schema.sql
   PGPASSWORD="<db-password>" psql -h <rds-endpoint> -U tch_prod_app -d crunchy_heart -f database/production-seed.sql
   ```
2. Download the AWS RDS Global CA bundle to `/etc/ssl/certs/global-bundle.pem`:
   ```bash
   sudo curl -o /etc/ssl/certs/global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
   ```
3. Create the initial administrator account:
   ```bash
   cd /var/www/thecrunchyheart-api/current
   node src/scripts/create-owner.js
   ```

---

## 4. Useful Operations Commands

- **Check API Status**: `sudo systemctl status thecrunchyheart-api`
- **View Live API Logs**: `sudo journalctl -u thecrunchyheart-api -f`
- **Test Health Endpoint**: `curl http://127.0.0.1:5000/api/health`
- **Nginx Configuration Test**: `sudo nginx -t`
- **Nginx Error Log**: `sudo tail -f /var/log/nginx/error.log`

