import { Settings } from '../models/Settings.js';
import { STAGE_KEYS, STAGE_PRICES, type StageKey } from './stages.js';

export type StagePrices = Record<StageKey, number>;

const isValidPrice = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 100;

// Current monthly prices: admin-panel values where set, defaults otherwise.
export async function getStagePrices(): Promise<StagePrices> {
  const s = await Settings.findOne().select('stagePrices');
  const saved = (s?.get('stagePrices') || {}) as Record<string, unknown>;
  const prices = { ...STAGE_PRICES };
  for (const key of STAGE_KEYS) {
    const n = Number(saved[key]);
    if (isValidPrice(n)) prices[key] = n;
  }
  return prices;
}

// Checks prices sent from the admin panel. Returns an error message, or the clean prices.
export function parseStagePrices(input: unknown): { ok: true; prices: Partial<StagePrices> } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') return { ok: false, message: 'Stage prices are missing' };
  const prices: Partial<StagePrices> = {};
  for (const key of STAGE_KEYS) {
    const raw = (input as Record<string, unknown>)[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!isValidPrice(n)) return { ok: false, message: `The ${key} price must be a whole number of at least ₦100` };
    prices[key] = n;
  }
  return { ok: true, prices };
}
