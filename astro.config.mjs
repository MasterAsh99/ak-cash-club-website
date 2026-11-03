// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  // Live address on Cloudflare Workers. Update this if you add a custom domain.
  site: 'https://ak-cash-club-website.aaronkara99.workers.dev',

  // Marketing pages are still pre-built at build time. Member pages opt in to
  // on-demand rendering with `export const prerender = false`.
  output: 'static',
  adapter: cloudflare({
    // No runtime image processing is needed; avoids provisioning an Images binding.
    imageService: 'compile',
  }),
  // Supabase manages login sessions in cookies; Astro's own KV-backed session
  // store isn't needed (and would provision a KV namespace on deploy).
  session: false,

  security: {
    // Reject cross-site form submissions to on-demand pages (CSRF protection).
    checkOrigin: true,
  },

  build: {
    // Inline small stylesheets to avoid an extra request on first load.
    inlineStylesheets: 'auto',
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
