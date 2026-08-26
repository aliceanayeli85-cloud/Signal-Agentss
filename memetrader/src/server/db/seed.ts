import { sql } from 'drizzle-orm';
import { DEFAULT_SETTINGS } from '../../engine/discipline.js';
import { STRATEGIES } from '../../engine/setups/index.js';
import type { Db } from './index.js';
import { settings, strategies } from './schema.js';
import { seedMyMemeCoins } from './seed-watchlist.js';

/**
 * Seeds only structural rows: the single settings record and the strategy
 * catalogue, both of which describe the app itself. No market data, no trades and
 * no results are ever seeded - those would be fabricated history.
 */
export function seedDefaults(db: Db): void {
  const now = Date.now();

  db.insert(settings)
    .values({ id: 1, ...DEFAULT_SETTINGS, updatedAt: now })
    .onConflictDoNothing()
    .run();

  seedMyMemeCoins(db);

  for (const strategy of STRATEGIES) {
    db.insert(strategies)
      .values({
        id: strategy.id,
        name: strategy.name,
        description: strategy.description,
        enabled: 1,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: strategies.id,
        set: { name: strategy.name, description: sql`excluded.description` },
      })
      .run();
  }
}
