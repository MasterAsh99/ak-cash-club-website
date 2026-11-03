# AK Cash Club — Website

The public website for **AK Cash Club**, a private poker home game in London, Ontario.

It's a single-page, mobile-first static site built with [Astro](https://astro.build) and
[Tailwind CSS](https://tailwindcss.com), hosted on Cloudflare Workers.

**Live site:** https://ak-cash-club-website.aaronkara99.workers.dev
There's no backend, database, forms, payments or online gambling. The site is purely
informational, and all contact goes through Instagram DM.

---

## Before launch: checklist

- [ ] **Copy review.** Read through each section and adjust the wording to the club's voice.

---

## Local setup

Requirements: **Node.js 22+** (see `.nvmrc`) and npm.

```bash
npm install
npm run dev        # http://localhost:4321 with live reload
```

| Command           | What it does                                  |
| ----------------- | --------------------------------------------- |
| `npm run dev`     | Start the local dev server                    |
| `npm run build`   | Build the production site into `dist/`        |
| `npm run preview` | Serve the built `dist/` locally to check it   |

---

## Deploying (Cloudflare Workers)

The site is connected to Cloudflare **Workers Builds** through GitHub, and **deploys itself**:

- **Merging into `main`** builds the site and publishes it to the live address within a couple of minutes.
- **Every other branch** (for example, a pull request) gets its own preview build. Cloudflare reports
  the result as a check on the pull request.

Cloudflare reads its settings from `wrangler.jsonc`, which tells it to serve the built files in
`dist/` and to show the custom 404 page for unknown URLs. The build command is `npm run build`.

To deploy by hand from your computer (not usually needed):

```bash
npm run build
npx wrangler deploy
```

### Adding a custom domain later

1. Buy or transfer a domain into Cloudflare.
2. In the dashboard, open **Workers & Pages → ak-cash-club-website → Settings → Domains & Routes**
   and add the domain.
3. Update `site` in `astro.config.mjs` to the new address, so share links and canonical tags use it.

### Headers and caching

`public/_headers` is copied into the build, and Cloudflare applies it automatically. It sets
security headers (including a strict Content-Security-Policy) and long-term caching for the hashed
files in `/_astro/`. If you later embed something from another site (an Instagram embed or
analytics, for example), you'll need to allow that domain in the CSP.

---

## Project structure

```
├── public/                  Static files served as-is
│   ├── _headers             Cloudflare security + cache headers
│   ├── brand/               Emblem in web sizes (96/192/320/640 px, WebP)
│   ├── favicon.ico, favicon-32.png, apple-touch-icon.png
│   ├── og-image.jpg         Preview image used when the link is shared (1200×630)
│   └── robots.txt
├── assets/brand/            Full-resolution logo sources (kept in the repo, not deployed)
├── src/
│   ├── config/site.ts       ← Club name, Instagram handle, nav, game details, equipment links
│   ├── styles/global.css    ← Brand colours, fonts, buttons, animations
│   ├── layouts/
│   │   └── BaseLayout.astro <head>, SEO tags, scroll-reveal script
│   ├── components/          One file per page section
│   │   ├── Header.astro       Sticky header + mobile menu
│   │   ├── Hero.astro         Cinematic opening section
│   │   ├── About.astro        The club
│   │   ├── Game.astro         The game + "Game information" panel
│   │   ├── Equipment.astro    Table + cards (links to Straight Poker Supplies)
│   │   ├── Hospitality.astro  Free food, non-alcoholic drinks, alcohol policy (BYOB)
│   │   ├── Promotions.astro   High hands & jackpots
│   │   ├── Contact.astro      Instagram DM call-to-action
│   │   ├── Footer.astro
│   │   ├── Logo.astro         Emblem (header, hero, footer, 404)
│   │   ├── SectionHeading.astro
│   │   └── InstagramIcon.astro
│   └── pages/
│       ├── index.astro      The home page (assembles the sections)
│       └── 404.astro
├── astro.config.mjs         Site address and build settings
├── wrangler.jsonc           Cloudflare Workers settings
└── package.json
```

## Editing guide

- **Text and details:** most settings, including the Instagram handle (`@akcashclub`), are in `src/config/site.ts`. The section copy is in each
  component under `src/components/`, written as plain HTML.
- **Game information panel:** edit the `gameDetails` list in `src/config/site.ts`.
- **Equipment links** (Straight Poker Supplies, the Manhattan table, KEM cards): edit `links` in
  `src/config/site.ts`.
- **Reordering or removing sections:** edit `src/pages/index.astro`, and update `nav` in
  `src/config/site.ts` to match.
- **Colours and fonts:** edit the `@theme` block at the top of `src/styles/global.css`.
  - Midnight navy: `midnight-*`, black: `ink`, steel blue: `steel-*`, metallic silver: `silver-*`
  - Headings use Cormorant Garamond and body text uses Inter. Both are self-hosted through
    Fontsource, so no Google Fonts requests are made.
- **Animations:** sections fade in on scroll when they have a `data-reveal` attribute. Add
  `style="--reveal-delay:120ms"` to stagger them. All motion is turned off for visitors who
  enable "reduce motion" on their device.

### Updating the logo

The official emblem's full-resolution source is `assets/brand/emblem-original.png`, and
`assets/brand/emblem-circle-master.png` is the same emblem cropped to a circle with a transparent
background. The site uses smaller copies made from the circular master:

| File                                   | Used for                            |
| -------------------------------------- | ----------------------------------- |
| `public/brand/emblem-{96,192,320,640}.webp` | Header, hero, footer, 404 page |
| `public/favicon.ico`, `favicon-32.png`  | Browser tab icon                    |
| `public/apple-touch-icon.png`           | iPhone home-screen icon             |
| `public/og-image.jpg`                   | Link preview on social and messaging apps |

If the logo ever changes, replace those files with new versions at the same sizes. For best
results, keep the emblem as a circle with a transparent background.

---

## Privacy and content rules

This repository and site are public. **Never add:**

- the venue address or anything that pinpoints it
- player names, photos or any player information
- private phone numbers or email addresses
- financial information (buy-ins, bankrolls, payouts or results)
- payment, deposit or online gambling features

Schedules, specific stakes and promotion amounts are intentionally left to Instagram, where they
can be kept current and shared with the right people.
