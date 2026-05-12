# Domain Setup for Depth Pipeline (Future)

When you get a domain, follow these steps to connect it to the depth pipeline server:

## 1. Point DNS to the server
In your domain registrar's DNS settings, add an A record:
- **Subdomain:** `depth.yourdomain.com` (or any subdomain you prefer)
- **Type:** A
- **Value:** `72.62.81.209`

## 2. Update nginx server_name
On the VPS, edit the nginx config:
```bash
nano /etc/nginx/sites-available/depth-pipeline
```
Change `server_name depth.srv1207892.hstgr.cloud;` to your new subdomain:
```nginx
server_name depth.yourdomain.com;
```
Then reload nginx:
```bash
nginx -t && systemctl reload nginx
```

## 3. Get HTTPS certificate
```bash
certbot --nginx -d depth.yourdomain.com
```

## 4. Update frontend env and redeploy
In `/Users/rupesh/roofing-app/.env`, update:
```
VITE_DEPTH_SERVICE_URL=https://depth.yourdomain.com
```
Then redeploy to Vercel:
```bash
cd /Users/rupesh/roofing-app
npm run deploy:vercel
```
