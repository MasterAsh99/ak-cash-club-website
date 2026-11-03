/**
 * Site-wide settings and copy.
 *
 * Most day-to-day edits (Instagram handle, wording, section text) happen here,
 * so components stay focused on layout.
 *
 * PRIVACY: never add the venue address, player names, phone numbers,
 * or financial details to this file — it is published publicly.
 */

export const site = {
  name: 'AK Cash Club',
  shortName: 'AK',
  tagline: 'A private poker home game',
  city: 'London, Ontario',
  description:
    'AK Cash Club is a private poker home game in London, Ontario — low-to-medium-stakes No-Limit Texas Hold’em cash games with complimentary food and drinks. Seats by Instagram DM.',

  /**
   * Instagram handle WITHOUT the "@".
   * TODO: replace with the club's real handle before launch.
   */
  instagramHandle: 'akcashclub',
} as const;

export const instagramUrl = `https://www.instagram.com/${site.instagramHandle}/`;
/** Opens a DM thread on mobile (Instagram app) and the inbox on desktop. */
export const instagramDmUrl = `https://ig.me/m/${site.instagramHandle}`;

export const nav = [
  { label: 'The Club', href: '#about' },
  { label: 'The Game', href: '#game' },
  { label: 'Hospitality', href: '#hospitality' },
  { label: 'Promotions', href: '#promotions' },
  { label: 'Join', href: '#contact' },
] as const;

/**
 * Game details shown in the "Game information" panel.
 * Only list facts the club has confirmed. Schedules and promotion amounts
 * are intentionally announced on Instagram rather than hard-coded here.
 */
export const gameDetails = [
  { label: 'Game', value: 'No-Limit Texas Hold’em' },
  { label: 'Format', value: 'Cash game' },
  { label: 'Stakes', value: 'Low to medium' },
  { label: 'Location', value: 'London, Ontario', note: 'Address shared privately with confirmed players' },
  { label: 'Schedule', value: 'Announced on Instagram' },
  { label: 'Seating', value: 'Request a seat by Instagram DM' },
] as const;
