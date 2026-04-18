# Runbook

## Components

This repo can run in two roles:

### 1. Preview renderer
- entrypoint: `src/server.mjs`
- serves preview HTML and debug endpoints

### 2. Remote extractor reference server
- entrypoint: `src/remote_extractor_server.mjs`
- serves JSON extraction results only

---

## Recommended deployment model

### On VPS
Run the preview renderer:
- `EXTRACTOR_MODE=remote`
- `REMOTE_EXTRACTOR_URL=http://home-or-other-ip:3200`

### On home/residential/LTE machine
Run the remote extractor:
- `EXTRACTOR_MODE=local`
- `node src/remote_extractor_server.mjs`

This keeps preview rendering on the VPS while moving Instagram extraction to a better IP environment.

---

## Local commands

### Start renderer
```bash
npm start
```

### Start remote extractor reference server
```bash
node src/remote_extractor_server.mjs
```

### Deploy-ready files for a home extractor
See:
- `deploy/HOME_EXTRACTOR_SETUP.md`
- `deploy/insta-remote-extractor.service`
- `deploy/insta-remote-extractor.env.example`

### Deploy-ready files for the VPS renderer
See:
- `deploy/VPS_RENDERER_SETUP.md`
- `deploy/insta-preview-renderer.service`
- `deploy/insta-preview-renderer.env.example`

---

## Expected remote extractor contract

### Request
`GET /extract/:shortcode`

### Success response
```json
{
  "ok": true,
  "source": "local-instaloader",
  "durationMs": 1234,
  "data": {
    "shortcode": "DWU3kwlDyW7",
    "owner_username": "example",
    "caption": "...",
    "media": [
      {
        "type": "video",
        "url": "https://...",
        "thumbnail": "https://..."
      }
    ]
  },
  "cache": {
    "hit": false,
    "cachedAt": 0,
    "expiresAt": 0,
    "ttlMs": 21600000
  }
}
```

### Failure response
```json
{
  "ok": false,
  "source": "local-instaloader",
  "errorCode": "ConnectionException",
  "error": "...",
  "durationMs": 1234,
  "cache": {
    "hit": false,
    "cachedAt": 0,
    "expiresAt": 0,
    "ttlMs": 1800000
  }
}
```

---

## Why this split exists

The VPS is good for:
- stable preview URLs
- HTML rendering
- health/debug
- orchestration

The VPS is currently bad for:
- primary Instagram extraction

So the design keeps those concerns separate.
