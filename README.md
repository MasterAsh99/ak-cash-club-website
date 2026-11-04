# AK Cash Club — Website

The public website for **AK Cash Club**, a private poker home game in London, Ontario.

It's a mobile-first site built with [Astro](https://astro.build) and
[Tailwind CSS](https://tailwindcss.com), hosted on Cloudflare Workers.

**Live site:** https://akcashclub.com  
(also reachable at https://ak-cash-club-website.aaronkara99.workers.dev)

It has two parts:

- **The public site**: pre-built pages (home, privacy) served as static files.
- **The member area**: player accounts and private performance tracking, with a host-only
  administration area. These pages are rendered on demand by the same Worker, using
  [Supabase](https://supabase.com) for login and the database.

There are no payments, deposits or online gambling anywhere on the site, and seats are
still arranged by Instagram DM.

| Guide | What’s in it |
| --- | --- |
| [`docs/SETUP.md`](docs/SETUP.md) | **Start here.** Supabase, email (Resend), Cloudflare settings, activating the host account |
| [`docs/SECURITY.md`](docs/SECURITY.md) | How permissions, privacy and the host role are enforced, and how they’re tested |
| [`docs/COMPLIANCE_CHECKLIST.md`](docs/COMPLIANCE_CHECKLIST.md) | Questions to review with a lawyer before launch |
| [`docs/DATA_REQUESTS.md`](docs/DATA_REQUESTS.md) | Handling corrections, data copies and deletion requests |

---

## Before launch: checklist

- [ ] **Member area setup.** Complete [`docs/SETUP.md`](docs/SETUP.md).
- [ ] **Legal review.** Work through [`docs/COMPLIANCE_CHECKLIST.md`](docs/COMPLIANCE_CHECKLIST.md) with a lawyer.

---

## Local setup

Requirements: **Node.js 22+** (see `.nvmrc`) and npm.

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in your Supabase URL + publishable key
npm run dev                      # http://localhost:4321 with live reload
```

Without `.dev.vars`, the public pages work normally and the member pages say the member
area is being set up.

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the local dev server |
| `npm run build` | Build the site into `dist/` |
| `npm run preview` | Serve the built site locally |
| `npm run check` | Generate Cloudflare types and type-check everything |
| `npm test` | Unit tests + database security tests (no accounts needed) |
| `npm run test:e2e` | Browser walkthrough against a local Supabase stand-in (see `tests/e2e/README.md`) |

---

## Deploying (Cloudflare Workers)

The site is connected to Cloudflare **Workers Builds** through GitHub, and **deploys itself**:

- **Merging into `main`** builds the site and publishes it to the live address within a couple of minutes.
- **Every other branch** (for example, a pull request) gets its own preview build. Cloudflare reports
  the result as a check on the pull request.

Cloudflare reads its settings from `wrangler.jsonc`: the server entry for member pages, the
rate limiters, and `PUBLIC_SITE_URL`. The Supabase URL and publishable key are stored as
**Secrets** in the Cloudflare dashboard (see `docs/SETUP.md`). The build command is
`npm run build`.

To deploy by hand from your computer (not usually needed):

```bash
npm run build
npx wrangler deploy
```

### Adding a custom domain later

1. Buy or transfer a domain into Cloudflare.
2. In the dashboard, open **Workers & Pages → ak-cash-club-website → Settings → Domains & Routes**
   and add the domain.
3. Update `site` in `astro.config.mjs` and `PUBLIC_SITE_URL` in `wrangler.jsonc` to the new address.
4. In Supabase, update the **Site URL** and **Redirect URLs** (see `docs/SETUP.md`).

### Headers and caching

`public/_headers` applies to the static files; `src/middleware.ts` sets the same security headers
on member pages, and marks them `private, no-store` so they’re never cached. Hashed files in
`/_astro/` are cached long-term. If you later embed something from another site (an Instagram embed or
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
│   ├── middleware.ts        ← Member pages: session check + security headers
│   ├── lib/                 ← Member-area logic (money in integer cents, stats, chart,
│   │                          validation, Supabase client, page guards, rate limits)
│   ├── layouts/
│   │   ├── BaseLayout.astro   <head>, SEO tags, scroll-reveal script
│   │   └── PortalLayout.astro Member-area layout and navigation
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
│   │   ├── InstagramIcon.astro
│   │   └── portal/            Member-area components (forms, stat tiles, chart, session editor)
│   └── pages/
│       ├── index.astro      The home page (assembles the sections)
│       ├── privacy.astro    Privacy notice
│       ├── 404.astro
│       ├── signup, login, check-email, forgot-password, logout
│       ├── auth/confirm     Landing page for every emailed link
│       ├── dashboard        Player dashboard
│       ├── account          Username, tracking consent, password, email, deletion
│       └── host/            Host-only: sessions, players, audit log, two-factor
├── supabase/
│   ├── migrations/          Database tables, security rules and functions
│   ├── templates/           Branded verification / reset / email-change emails
│   └── config.toml          Reference auth settings
├── tests/                   unit/, db/ (security), e2e/ (browser)
├── docs/                    Setup, security, compliance, data requests
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
- real credentials or API keys (use `.dev.vars` locally and Cloudflare Secrets in production)

Player results live only in the Supabase database, protected by the rules described in
`docs/SECURITY.md`. They are never part of this repository or the public pages.

Schedules, specific stakes and promotion amounts are intentionally left to Instagram, where they
can be kept current and shared with the right people.
