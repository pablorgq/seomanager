# SEO Manager

SEO branding asset generator that creates unique, independent-looking blog identities for off-page SEO campaigns and link building.

## What it does

- Generates complete blog brand packages: name, title, tagline, about us, color palette, logo image, and cover hero image
- Bulk image generator for blog post photography (multiple styles and sizes)
- Export brands as JSON, CSV, or TXT
- All generation powered by OpenAI (GPT-4o for text, DALL-E / GPT-Image for images)

## Stack

- Node.js 18+ (ESM)
- Express (static file server)
- Vanilla JS frontend — no build step
- Deployed on Railway

## Setup

```bash
npm install
npm start
```

Open `http://localhost:3000`, click the gear icon, and enter your OpenAI API key. The key is stored in your browser's `localStorage` and never sent to any server.

## Deploy to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Select this repository — Railway auto-detects Node.js and runs `npm start`
4. Railway assigns a public URL automatically

No environment variables needed — the OpenAI key is entered per-user in the UI.

## Project structure

```
/public
  index.html    — full-page UI
  style.css     — dark editorial theme, responsive
  app.js        — all logic (OpenAI calls, export, copy/download)
server.mjs      — Express static server
railway.json    — Railway deployment config
```
