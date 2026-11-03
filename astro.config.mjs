// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // Live address on Cloudflare Workers. Update this if you add a custom domain.
  site: 'https://ak-cash-club-website.aaronkara99.workers.dev',
  output: 'static',
  build: {
    // Inline small stylesheets to avoid an extra request on first load.
    inlineStylesheets: 'auto',
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
