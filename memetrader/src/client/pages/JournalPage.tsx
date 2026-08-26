import { useEffect, useState } from 'react';
import type { JournalEntry, PaperTradeRecord } from '../../shared/types.js';
import { GRADES, POST_TRADE_QUESTIONS, PRE_TRADE_QUESTIONS } from '../../shared/journal-questions.js';
import { ApiError, api } from '../lib/api.js';
import { fmtDateTime, fmtR, fmtUsd } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';
import { Badge, Button, DataUnavailable, Loading, Panel } from '../components/primitives.js';

/**
 * TRADE JOURNAL.
 *
 * The pre-trade questions exist to make the user articulate a plan before the
 * position exists; the post-trade questions exist to separate "the plan was
 * wrong" from "I did not follow the plan", which are completely different
 * problems with completely different fixes.
 */
export function JournalPage() {
  const trades = useApi<{ trades: PaperTradeRecord[] }>('/api/trading/paper-trades');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const entries = useApi<{ entries: JournalEntry[] }>(selectedId ? `/api/journal/${selectedId}` : null);

  const [phase, setPhase] = useState<'pre' | 'post'>('pre');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [grade, setGrade] = useState<(typeof GRADES)[number] | ''>('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = trades.data?.trades.find((t) => t.id === selectedId) ?? null;

  // Load whatever has already been written for this trade and phase.
  useEffect(() => {
    const existing = entries.data?.entries.find((entry) => entry.phase === phase);
    setAnswers(existing?.answers ?? {});
    setGrade((existing?.grade as (typeof GRADES)[number]) ?? '');
    setStatus(null);
    setError(null);
  }, [entries.data, phase, selectedId]);

  const questions = phase === 'pre' ? PRE_TRADE_QUESTIONS : POST_TRADE_QUESTIONS;

  const save = async () => {
    if (!selectedId) return;
    setError(null);
    try {
      await api.post('/api/journal', {
        tradeId: selectedId,
        phase,
        answers,
        grade: phase === 'post' && grade ? grade : null,
      });
      setStatus('Saved.');
      entries.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[320px_minmax(0,1fr)] gap-2 p-2">
      <Panel title="Trades">
        {trades.loading && !trades.data ? (
          <Loading />
        ) : trades.error ? (
          <DataUnavailable reason={trades.error.message} />
        ) : !trades.data || trades.data.trades.length === 0 ? (
          <p className="text-xs text-term-dim">No paper trades recorded yet.</p>
        ) : (
          <div className="space-y-1">
            {trades.data.trades.map((trade) => (
              <button
                key={trade.id}
                type="button"
                onClick={() => setSelectedId(trade.id)}
                className={`block w-full rounded border px-2 py-1.5 text-left transition ${
                  selectedId === trade.id
                    ? 'border-term-accent/60 bg-term-accent/10'
                    : 'border-term-border bg-term-panel-2 hover:border-term-border-bright'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-term-text">
                    #{trade.id} {trade.symbol}
                  </span>
                  <Badge tone={trade.status === 'open' ? 'info' : trade.status === 'closed' ? 'neutral' : 'warn'}>
                    {trade.status}
                  </Badge>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-term-dim">
                  <span>{fmtDateTime(trade.createdAt)}</span>
                  {trade.rMultiple !== null ? (
                    <span className={trade.rMultiple >= 0 ? 'text-term-up' : 'text-term-down'}>
                      {fmtR(trade.rMultiple)}
                    </span>
                  ) : null}
                </div>
              </button>
            ))}
          </div>
        )}
      </Panel>

      <div className="flex min-h-0 flex-col gap-2 overflow-auto">
        {!selected ? (
          <Panel title="Journal">
            <p className="text-xs leading-relaxed text-term-dim">
              Select a trade to log it. Answer the pre-trade questions before the position moves —
              writing the plan down after the fact records a memory, not a plan. The post-trade
              questions separate a wrong plan from a plan you did not follow.
            </p>
          </Panel>
        ) : (
          <>
            <Panel
              title={`#${selected.id} ${selected.symbol}`}
              subtitle={`${selected.direction} · ${selected.timeframe} · ${selected.strategy ?? 'no strategy recorded'}`}
              actions={
                <div className="flex gap-1">
                  {(['pre', 'post'] as const).map((entry) => (
                    <button
                      key={entry}
                      type="button"
                      onClick={() => setPhase(entry)}
                      className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition ${
                        phase === entry
                          ? 'border-term-accent/60 bg-term-accent/10 text-term-accent'
                          : 'border-term-border text-term-dim hover:text-term-text'
                      }`}
                    >
                      {entry === 'pre' ? 'Before trade' : 'After trade'}
                    </button>
                  ))}
                </div>
              }
            >
              <div className="mb-3 grid grid-cols-5 gap-3 text-[11px]">
                <Stat label="Entry" value={String(selected.entry)} />
                <Stat label="Stop" value={String(selected.stop)} />
                <Stat label="Risk" value={selected.riskAmount === null ? '—' : fmtUsd(selected.riskAmount)} />
                <Stat label="P&L" value={selected.pnl === null ? 'open' : fmtUsd(selected.pnl)} />
                <Stat label="R" value={selected.rMultiple === null ? 'open' : fmtR(selected.rMultiple)} />
              </div>
              {selected.marketConditions ? (
                <p className="mb-3 rounded border border-term-border bg-term-panel-2 p-2 text-[11px] text-term-muted">
                  Conditions at entry: {selected.marketConditions}
                </p>
              ) : null}
              {selected.fomoFlagged === 1 ? (
                <p className="mb-3 rounded border border-term-warn/40 bg-term-warn/5 p-2 text-[11px] text-term-warn">
                  This trade was taken after a FOMO warning was raised and acknowledged.
                </p>
              ) : null}

              <div className="space-y-3">
                {questions.map((question) => (
                  <div key={question.id}>
                    <label className="mb-1 block text-[11px] font-medium text-term-text">
                      {question.prompt}
                    </label>
                    {question.kind === 'yesno' ? (
                      <div className="flex gap-1.5">
                        {['yes', 'no'].map((option) => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => setAnswers((current) => ({ ...current, [question.id]: option }))}
                            className={`rounded border px-3 py-1 text-[11px] uppercase tracking-wider transition ${
                              answers[question.id] === option
                                ? 'border-term-info/60 bg-term-info/10 text-term-info'
                                : 'border-term-border text-term-dim hover:text-term-text'
                            }`}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <textarea
                        value={answers[question.id] ?? ''}
                        onChange={(event) =>
                          setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                        }
                        rows={2}
                        className="w-full rounded border border-term-border bg-term-bg px-2 py-1.5 text-xs text-term-text outline-none transition focus:border-term-info"
                      />
                    )}
                  </div>
                ))}

                {phase === 'post' ? (
                  <div>
                    <span className="mb-1 block text-[11px] font-medium text-term-text">
                      Grade your execution (not the outcome)
                    </span>
                    <div className="flex gap-1.5">
                      {GRADES.map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => setGrade(option)}
                          className={`num rounded border px-3 py-1 text-xs font-bold transition ${
                            grade === option
                              ? 'border-term-accent/60 bg-term-accent/10 text-term-accent'
                              : 'border-term-border text-term-dim hover:text-term-text'
                          }`}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed text-term-dim">
                      Grade the process. A trade that followed the plan and lost is an A; a trade that
                      broke every rule and won is an F.
                    </p>
                  </div>
                ) : null}

                <div className="flex items-center gap-2">
                  <Button onClick={save} variant="primary">Save entry</Button>
                  {status ? <span className="text-[11px] text-term-up">{status}</span> : null}
                  {error ? <span className="text-[11px] text-term-down">{error}</span> : null}
                </div>
              </div>
            </Panel>

            {entries.data && entries.data.entries.length > 0 ? (
              <Panel title="Saved entries">
                <div className="space-y-2">
                  {entries.data.entries.map((entry) => (
                    <div key={entry.id} className="rounded border border-term-border bg-term-panel-2 p-2.5">
                      <div className="mb-1.5 flex items-center gap-2">
                        <Badge tone={entry.phase === 'pre' ? 'info' : 'neutral'}>
                          {entry.phase === 'pre' ? 'Before trade' : 'After trade'}
                        </Badge>
                        {entry.grade ? <Badge tone="warn">Grade {entry.grade}</Badge> : null}
                        <span className="text-[10px] text-term-dim">{fmtDateTime(entry.createdAt)}</span>
                      </div>
                      <dl className="space-y-1">
                        {Object.entries(entry.answers).map(([key, value]) => (
                          <div key={key}>
                            <dt className="text-[10px] uppercase tracking-widest text-term-dim">{key}</dt>
                            <dd className="text-[11px] text-term-text">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))}
                </div>
              </Panel>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-widest text-term-dim">{label}</div>
      <div className="num text-[11px] text-term-text">{value}</div>
    </div>
  );
}
