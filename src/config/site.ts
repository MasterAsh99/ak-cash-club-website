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
    'AK Cash Club is a private No-Limit Texas Hold’em cash game in London, Ontario: low-to-medium stakes, a Manhattan-style table, KEM cards, and complimentary food and non-alcoholic drinks. Members request seats on this website.',

  /** Instagram handle WITHOUT the "@". Used for every Instagram link and button. */
  instagramHandle: 'akcashclub',
} as const;

export const instagramUrl = `https://www.instagram.com/${site.instagramHandle}/`;

/**
 * Outside links used in the Equipment section.
 * Swap these if you'd rather point to a different product page.
 */
export const links = {
  /** Straight Poker Supplies home page */
  straightPoker: 'https://www.straightpokersupplies.com/',
  /** Manhattan series tables at Straight Poker Supplies */
  manhattanTable: 'https://www.straightpokersupplies.com/poker-tables/manhattan-series-poker-table.html',
  /** KEM Arrow poker-size (regular index) cards at Straight Poker Supplies */
  kemCards: 'https://www.straightpokersupplies.com/kem-playing-cards-arrow-poker-wide-regular-red-blue.html',
} as const;

/**
 * Game details shown in the "Game information" panel.
 * Only list facts the club has confirmed. Promotion amounts are announced on
 * Instagram rather than hard-coded here; game dates live in Upcoming Games.
 */
export const gameDetails = [
  { label: 'Game', value: 'No-Limit Texas Hold’em' },
  { label: 'Format', value: 'Cash game' },
  { label: 'Stakes', value: 'Low to medium' },
  { label: 'Location', value: 'London, Ontario', note: 'Address shared privately with confirmed players' },
  { label: 'Schedule', value: 'Listed in Upcoming Games', note: 'Sign in to see games and request a seat' },
  { label: 'Table', value: 'Manhattan-style, in blue felt', note: 'From Straight Poker Supplies' },
  { label: 'Cards', value: 'KEM, poker size' },
  { label: 'Hospitality', value: 'Complimentary food and non-alcoholic drinks' },
  { label: 'Alcohol', value: 'Not served by the hosts', note: 'You’re welcome to bring your own (BYOB)' },
  { label: 'Seating', value: 'Requested on this website', note: 'Confirmed by the host; waitlist when full' },
] as const;
