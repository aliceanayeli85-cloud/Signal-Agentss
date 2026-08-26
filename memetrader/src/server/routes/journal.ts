import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import * as z from 'zod/v4';
import { GRADES, POST_TRADE_QUESTIONS, PRE_TRADE_QUESTIONS } from '../../shared/journal-questions.js';
import type { JournalEntry } from '../../shared/types.js';
import { getDb } from '../db/index.js';
import { tradeJournal } from '../db/schema.js';
import { parse } from '../lib/validate.js';
import { getTrade } from '../services/trades.js';

export const journalRouter: Router = Router();

journalRouter.get('/questions', (_req, res) => {
  res.json({ pre: PRE_TRADE_QUESTIONS, post: POST_TRADE_QUESTIONS, grades: GRADES });
});

function toEntry(row: typeof tradeJournal.$inferSelect): JournalEntry {
  let answers: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(row.answers);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      answers = parsed as Record<string, string>;
    }
  } catch {
    // A corrupted row must not take down the journal; it renders as empty answers.
    answers = {};
  }
  return {
    id: row.id,
    tradeId: row.tradeId,
    createdAt: row.createdAt,
    phase: row.phase as 'pre' | 'post',
    answers,
    grade: (row.grade as JournalEntry['grade']) ?? null,
  };
}

journalRouter.get('/', (_req, res, next) => {
  try {
    const db = getDb();
    const rows = db.select().from(tradeJournal).orderBy(desc(tradeJournal.createdAt)).all();
    res.json({ entries: rows.map(toEntry) });
  } catch (error) {
    next(error);
  }
});

journalRouter.get('/:tradeId', (req, res, next) => {
  try {
    const tradeId = parse(z.coerce.number().int().positive(), req.params.tradeId, 'trade id');
    const db = getDb();
    const rows = db.select().from(tradeJournal).where(eq(tradeJournal.tradeId, tradeId)).all();
    res.json({ entries: rows.map(toEntry) });
  } catch (error) {
    next(error);
  }
});

const entrySchema = z.object({
  tradeId: z.number().int().positive(),
  phase: z.enum(['pre', 'post']),
  answers: z.record(z.string().max(60), z.string().max(4000)),
  grade: z.enum(GRADES).nullable().optional(),
});

journalRouter.post('/', (req, res, next) => {
  try {
    const body = parse(entrySchema, req.body, 'journal entry');
    // Throws NotFoundError when the trade does not exist, so orphan entries
    // cannot be written.
    getTrade(body.tradeId);

    const db = getDb();
    const now = Date.now();
    const row = db
      .insert(tradeJournal)
      .values({
        tradeId: body.tradeId,
        createdAt: now,
        phase: body.phase,
        answers: JSON.stringify(body.answers),
        grade: body.grade ?? null,
      })
      .onConflictDoUpdate({
        target: [tradeJournal.tradeId, tradeJournal.phase],
        set: {
          answers: JSON.stringify(body.answers),
          grade: body.grade ?? null,
          createdAt: now,
        },
      })
      .returning()
      .get();

    res.status(201).json(toEntry(row));
  } catch (error) {
    next(error);
  }
});
