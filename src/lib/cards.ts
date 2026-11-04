/** Playing cards for hand notes: codes like "As", "Td", "9c". */
export const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;
export const SUITS = [
  { code: 's', symbol: '♠', name: 'spades', red: false },
  { code: 'h', symbol: '♥', name: 'hearts', red: true },
  { code: 'd', symbol: '♦', name: 'diamonds', red: true },
  { code: 'c', symbol: '♣', name: 'clubs', red: false },
] as const;
export const ALL_CARDS: string[] = SUITS.flatMap((s) => RANKS.map((r) => `${r}${s.code}`));
export const POSITIONS = ['UTG', 'UTG+1', 'UTG+2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'] as const;

const CARD = /^[2-9TJQKA][shdc]$/;
export const isCard = (c: string) => CARD.test(c);

export function cardLabel(code: string): string {
  const suit = SUITS.find((s) => s.code === code[1]);
  const rank = code[0] === 'T' ? '10' : code[0];
  return suit ? `${rank}${suit.symbol}` : code;
}
export function cardName(code: string): string {
  const names: Record<string, string> = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: 'Ten' };
  const suit = SUITS.find((s) => s.code === code[1]);
  return `${names[code[0]!] ?? code[0]} of ${suit?.name ?? '?'}`;
}
export const isRed = (code: string) => code[1] === 'h' || code[1] === 'd';

export interface HandValues {
  id: string;
  played_on: string;
  title: string;
  stakes: string;
  position: string;
  hole: string[]; // length 2 ('' = empty)
  board: string[]; // length 5
  notes: string;
}

export function readHandForm(form: FormData): HandValues {
  const s = (k: string, max: number) => String(form.get(k) ?? '').trim().slice(0, max);
  return {
    id: s('id', 36),
    played_on: s('played_on', 10),
    title: s('title', 80),
    stakes: s('stakes', 40),
    position: s('position', 6),
    hole: [0, 1].map((i) => s(`hole_${i}`, 2)),
    board: [0, 1, 2, 3, 4].map((i) => s(`board_${i}`, 2)),
    notes: s('notes', 2000),
  };
}

export function validateHand(v: HandValues):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.played_on)) errors.played_on = 'Please choose a date.';
  if (!v.title) errors.title = 'Give the hand a short title, e.g. “Hero call on the river”.';
  if (v.position && !(POSITIONS as readonly string[]).includes(v.position)) errors.position = 'Choose a position from the list.';
  const hole = v.hole.filter(Boolean);
  const board = v.board.filter(Boolean);
  if (![...hole, ...board].every(isCard)) errors.cards = 'One of the cards isn’t valid.';
  else if (hole.length === 1) errors.cards = 'Choose both of your hole cards, or neither.';
  else if (board.length > 0 && board.length < 3) errors.cards = 'The board needs the full flop (3 cards), then the turn and river.';
  else if (v.board.slice(0, board.length).some((c) => !c)) errors.cards = 'Fill the board in order: flop, turn, then river.';
  else if (new Set([...hole, ...board]).size !== hole.length + board.length) errors.cards = 'The same card is used twice.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      ...(v.id ? { id: v.id } : {}),
      played_on: v.played_on, title: v.title, stakes: v.stakes, position: v.position,
      hole_cards: hole, board, notes: v.notes,
    },
  };
}
