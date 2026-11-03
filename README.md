# AK Cash Club — Website

The public website for **AK Cash Club**, a private poker home game in London, Ontario.

It's a single-page, mobile-first static site built with [Astro](https://astro.build) and
[Tailwind CSS](https://tailwindcss.com), hosted on [Cloudflare Pages](https://pages.cloudflare.com).
There's no backend, database, forms, payments or online gambling. The site is purely
informational, and all contact goes through Instagram DM.

---

## Before launch: checklist

- [ ] **Logo.** Add the official logo (see [Swapping in the official logo](#swapping-in-the-official-logo)).
- [ ] **Domain.** Update `site` in `astro.config.mjs` to the production URL so canonical and share links are correct.
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

## Deploying to Cloudflare Pages

### Option A: connect the GitHub repo (recommended)

1. In the Cloudflare dashboard go to **Workers & Pages → Create → Pages → Connect to Git**.
2. Select the `ak-cash-club-website` repository.
3. Use these build settings:

   | Setting                | Value           |
   | ---------------------- | --------------- |
   | Framework preset       | Astro           |
   | Build command          | `npm run build` |
   | Build output directory | `dist`          |
   | Environment variable   | `NODE_VERSION` = `22` |

4. Save and deploy. Every push to `main` deploys to production, and every pull request gets
   its own preview URL.
5. To use a custom domain, open **Custom domains** in the Pages project, add it, and then update
   `site` in `astro.config.mjs`.

### Option B: direct upload with Wrangler

```bash
npm run build
npx wrangler pages deploy dist --project-name ak-cash-club-website
```

### Headers and caching

`public/_headers` is copied into the build, and Cloudflare Pages applies it automatically. It sets
security headers (including a strict Content-Security-Policy) and long-term caching for the hashed
files in `/_astro/`. If you later embed something from another site (an Instagram embed or
analytics, for example), you'll need to allow that domain in the CSP.

---

## Project structure

```
├── public/                  Static files served as-is
│   ├── _headers             Cloudflare Pages security + cache headers
│   ├── favicon.svg
│   ├── og-image.png         Preview image used when the link is shared
│   └── robots.txt
├── src/
│   ├── config/site.ts       ← Club name, Instagram handle, nav, game details
│   ├── styles/global.css    ← Brand colours, fonts, buttons, animations
│   ├── layouts/
│   │   └── BaseLayout.astro <head>, SEO tags, scroll-reveal script
│   ├── components/          One file per page section
│   │   ├── Header.astro       Sticky header + mobile menu
│   │   ├── Hero.astro         Cinematic opening section
│   │   ├── About.astro        The club
│   │   ├── Game.astro         The game + "Game information" panel
│   │   ├── Hospitality.astro  Complimentary food & drinks
│   │   ├── Promotions.astro   High hands & jackpots
│   │   ├── Contact.astro      Instagram DM call-to-action
│   │   ├── Footer.astro
│   │   ├── Logo.astro         Brand mark (swap for official logo)
│   │   ├── SectionHeading.astro
│   │   └── InstagramIcon.astro
│   └── pages/
│       ├── index.astro      The home page (assembles the sections)
│       └── 404.astro
├── astro.config.mjs
└── package.json
```

## Editing guide

- **Text and details:** most settings, including the Instagram handle (`@akcashclub`), are in `src/config/site.ts`. The section copy is in each
  component under `src/components/`, written as plain HTML.
- **Game information panel:** edit the `gameDetails` list in `src/config/site.ts`.
- **Reordering or removing sections:** edit `src/pages/index.astro`, and update `nav` in
  `src/config/site.ts` to match.
- **Colours and fonts:** edit the `@theme` block at the top of `src/styles/global.css`.
  - Midnight navy: `midnight-*`, black: `ink`, steel blue: `steel-*`, metallic silver: `silver-*`
  - Headings use Cormorant Garamond and body text uses Inter. Both are self-hosted through
    Fontsource, so no Google Fonts requests are made.
- **Animations:** sections fade in on scroll when they have a `data-reveal` attribute. Add
  `style="--reveal-delay:120ms"` to stagger them. All motion is turned off for visitors who
  enable "reduce motion" on their device.

### Swapping in the official logo

1. Export the logo as **SVG** (best) or a **PNG at 2× size** with a transparent background.
2. Save it as `public/logo.svg` (or `public/logo.png`).
3. In `src/components/Logo.astro`, replace the monogram markup with
   `<img src="/logo.svg" alt="AK Cash Club" width="40" height="40" />`, sizing it as needed.
4. You can also replace `public/favicon.svg` and `public/og-image.png` (1200×630).

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
