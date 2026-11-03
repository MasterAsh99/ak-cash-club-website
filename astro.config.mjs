// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // Update this to the production domain once it is connected in Cloudflare Pages.
  site: 'https://ak-cash-club-website.pages.dev',
  output: 'static',
  build: {
    // Inline small stylesheets to avoid an extra request on first load.
    inlineStylesheets: 'auto',
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
