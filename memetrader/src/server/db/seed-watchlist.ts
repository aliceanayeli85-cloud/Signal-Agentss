import { and, eq } from 'drizzle-orm';
import type { Db } from './index.js';
import { watchlists } from './schema.js';
import { logger } from '../lib/logger.js';

export const MY_MEME_COINS = 'MY MEME COINS';

/**
 * The permanent starter watchlist.
 *
 * These are token CONTRACT addresses, which is what a user actually has. No
 * name, symbol, price or any other property is recorded here - every one of
 * those is resolved through the data providers at read time, and reported as
 * unavailable if resolution fails.
 */
export const MY_MEME_COIN_ADDRESSES: { chain: string; address: string }[] = [
  { chain: 'solana', address: 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump' },
  { chain: 'solana', address: 'DTFa5QRfiDqPWGTvpKvrrfvQZfKodqhsu9XNaKWKpump' },
  { chain: 'solana', address: 'ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg' },
  { chain: 'solana', address: '4N4DnNo3qpPks9aQCkcWkzoir8tnvT6diS4TnnZibonk' },
];

/**
 * Inserts the starter list if it is not already present.
 *
 * `symbol` is seeded with the contract address itself rather than a guessed
 * ticker: it is a placeholder the app replaces the first time the address
 * resolves. Seeding a plausible-looking symbol would be fabricated data.
 */
export function seedMyMemeCoins(db: Db): void {
  const now = Date.now();
  for (const [index, entry] of MY_MEME_COIN_ADDRESSES.entries()) {
    const existing = db
      .select({ id: watchlists.id })
      .from(watchlists)
      .where(
        and(eq(watchlists.listName, MY_MEME_COINS), eq(watchlists.tokenAddress, entry.address)),
      )
      .get();
    if (existing) continue;

    db.insert(watchlists)
      .values({
        assetId: '',
        symbol: entry.address,
        name: null,
        assetClass: 'meme',
        chain: entry.chain,
        pairAddress: null,
        tokenAddress: entry.address,
        listName: MY_MEME_COINS,
        pinned: 1,
        timeframe: '15m',
        status: 'WATCH',
        note: null,
        createdAt: now + index,
      })
      .run();
    logger.info('seeded watchlist token', { list: MY_MEME_COINS, address: entry.address });
  }
}

/** Persists the resolved identity so the UI has a real label before data loads. */
export function persistResolution(
  db: Db,
  tokenAddress: string,
  resolved: { assetId: string; symbol: string; name: string | null; pairAddress: string | null },
): void {
  db.update(watchlists)
    .set({
      assetId: resolved.assetId,
      symbol: resolved.symbol,
      name: resolved.name,
      pairAddress: resolved.pairAddress,
    })
    .where(eq(watchlists.tokenAddress, tokenAddress))
    .run();
}
