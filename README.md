# Manga Reader

Local-network manga reader PWA. Monorepo with 4 packages: provider-types, extensions, server, app.

# What
This repo is fullstack, meaning that it needs the pc and the iphone on the same local network for it to work.

# Why
I did this because the usual repos are either android only or too bloated in features, hence missing in features I actually use. I want a streamlined reading experience, which this repo does.

# How
The frontend is thin layer that just consumes what the pc works on. This helps in keeping battery usage minimal. All the heavy lifting is done by the backend. The backend uses chromium and cloakbrowser to keep cloudflare warm and the signing services for each specific manga warm. It consumes the manga requested by the frontend in a queue, but with priority of what the frontend sent the latest, so a priority queue.


## iOS PWA Setup

The app runs over HTTPS using mkcert certificates. iOS devices must trust the root CA before the PWA works.

### 1. Generate certificates

```bash
# Install mkcert if you don't have it
# https://github.com/FiloSottile/mkcert

# Create the root CA (one-time)
mkcert -install

# Generate certs for your local IP (replace with yours)
mkdir -p ~/.local/share/mkcert/pwa
mkcert -key-file ~/.local/share/mkcert/pwa/key.pem \
       -cert-file ~/.local/share/mkcert/pwa/cert.pem \
       "192.168.1.x"
```

### 2. Install root CA on iPhone

1. Open Safari on iPhone and go to `https://<server-ip>:11555/api/cert`
2. Tap "Allow" when prompted to download the profile
3. Go to Settings > General > VPN & Device Management > the downloaded profile > Install
4. Go to Settings > General > About > Certificate Trust Settings > enable the mkcert root CA

### 3. Add to Home Screen

1. Open `https://<server-ip>:11555` in Safari
2. Tap Share > Add to Home Screen
