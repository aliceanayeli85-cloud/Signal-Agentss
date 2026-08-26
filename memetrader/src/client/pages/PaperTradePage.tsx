import { useState } from 'react';
import type { PaperTradeRecord } from '../../shared/types.js';
import { ApiError, api } from '../lib/api.js';
import { fmtDateTime, fmtPrice, fmtR, fmtUsd } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';
import { Badge, Button, DataUnavailable, Freshness, Loading, Panel, TextInput } from '../components/primitives.js';

interface LivePosition {
  trade: PaperTradeRecord;
  priceStatus: 'ok' | 'unavailable';
  reason?: string;
  currentPrice: number | null;
  unrealisedPnl: number | null;
  unrealisedR: number | null;
  fetchedAt: number;
}

/**
 * Open paper positions marked against live prices, plus the closing workflow.
 *
 * A position whose price could not be fetched shows DATA UNAVAILABLE for its
 * unrealised P&L. It does not fall back to the entry price, which would render a
 * losing position as flat.
 */
export function PaperTradePage() {
  const live = useApi<{ positions: LivePosition[] }>('/api/trading/paper-trades/live', 20_000);
  const closed = useApi<{ trades: PaperTradeRecord[] }>('/api/trading/paper-trades?status=closed');
  const [closing, setClosing] = useState<number | null>(null);
  const [exitPrice, setExitPrice] = useState('');
  const [exitReason, setExitReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submitClose = async (id: number) => {
    setError(null);
    try {
      await api.post(`/api/trading/paper-trades/${id}/close`, {
        exitPrice: Number(exitPrice),
        exitReason: exitReason.trim() || 'Closed manually',
      });
      setClosing(null);
      setExitPrice('');
      setExitReason('');
      live.reload();
      closed.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-2 p-2">
      <Panel
        title="Open paper positions"
        subtitle={<Freshness fetchedAt={live.fetchedAt} staleAfterMs={45_000} />}
        actions={<Button onClick={() => live.reload()} variant="ghost">Refresh</Button>}
      >
        {live.loading && !live.data ? (
          <Loading label="Marking positions" />
        ) : live.error ? (
          <DataUnavailable reason={live.error.message} />
        ) : !live.data || live.data.positions.length === 0 ? (
          <p className="text-xs leading-relaxed text-term-dim">
            No open paper positions. Open one from the Meme, Day Trade or Swing desk — every entry
            runs the discipline check first.
          </p>
        ) : (
          <div className="space-y-2">
            {live.data.positions.map((position) => (
              <div key={position.trade.id} className="rounded border border-term-border bg-term-panel-2 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-term-text">#{position.trade.id} {position.trade.symbol}</span>
                  <Badge tone={position.trade.direction === 'long' ? 'up' : 'down'}>{position.trade.direction}</Badge>
                  <Badge>{position.trade.timeframe}</Badge>
                  {position.trade.strategy ? <Badge tone="info">{position.trade.strategy}</Badge> : null}
                  {position.trade.fomoFlagged === 1 ? <Badge tone="warn">FOMO flagged</Badge> : null}
                  <span className="text-[10px] text-term-dim">{fmtDateTime(position.trade.createdAt)}</span>
                </div>

                <div className="mt-2 grid grid-cols-6 gap-2 text-[11px]">
                  <Cell label="Entry" value={fmtPrice(position.trade.entry)} />
                  <Cell label="Stop" value={fmtPrice(position.trade.stop)} tone="text-term-down" />
                  <Cell label="TP2" value={fmtPrice(position.trade.tp2)} tone="text-term-up" />
                  <Cell label="Size" value={fmtPrice(position.trade.positionSize)} />
                  <Cell
                    label="Current"
                    value={position.priceStatus === 'ok' ? fmtPrice(position.currentPrice) : 'DATA UNAVAILABLE'}
                    tone={position.priceStatus === 'ok' ? undefined : 'text-term-warn'}
                  />
                  <Cell
                    label="Unrealised"
                    value={
                      position.priceStatus === 'ok'
                        ? `${fmtUsd(position.unrealisedPnl)} · ${fmtR(position.unrealisedR)}`
                        : '—'
                    }
                    tone={
                      position.priceStatus !== 'ok'
                        ? 'text-term-warn'
                        : (position.unrealisedPnl ?? 0) >= 0
                          ? 'text-term-up'
                          : 'text-term-down'
                    }
                  />
                </div>

                {position.priceStatus === 'unavailable' ? (
                  <p className="mt-1.5 text-[10px] text-term-warn">{position.reason}</p>
                ) : null}

                {closing === position.trade.id ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <div className="w-40">
                      <span className="mb-1 block text-[10px] uppercase tracking-widest text-term-dim">Exit price</span>
                      <TextInput type="number" value={exitPrice} onChange={setExitPrice} />
                    </div>
                    <div className="min-w-[220px] flex-1">
                      <span className="mb-1 block text-[10px] uppercase tracking-widest text-term-dim">
                        Reason for exit
                      </span>
                      <TextInput value={exitReason} onChange={setExitReason} placeholder="TP2 hit / stopped out / invalidated / cut early" />
                    </div>
                    <Button variant="primary" onClick={() => submitClose(position.trade.id)}>Confirm close</Button>
                    <Button variant="ghost" onClick={() => setClosing(null)}>Cancel</Button>
                  </div>
                ) : (
                  <div className="mt-2 flex gap-2">
                    <Button
                      onClick={() => {
                        setClosing(position.trade.id);
                        setExitPrice(position.currentPrice !== null ? String(position.currentPrice) : '');
                        setExitReason('');
                      }}
                    >
                      Close trade
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {error ? (
          <div className="mt-2 rounded border border-term-down/40 bg-term-down/5 p-2.5 text-[11px] text-term-down">
            {error}
          </div>
        ) : null}
      </Panel>

      <Panel title="Closed paper trades">
        {closed.loading && !closed.data ? (
          <Loading />
        ) : closed.error ? (
          <DataUnavailable reason={closed.error.message} />
        ) : !closed.data || closed.data.trades.length === 0 ? (
          <p className="text-xs text-term-dim">No closed trades recorded yet.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-term-border text-[9px] uppercase tracking-widest text-term-dim">
                <th className="px-2 py-1 text-left">#</th>
                <th className="px-2 py-1 text-left">Symbol</th>
                <th className="px-2 py-1 text-left">Strategy</th>
                <th className="px-2 py-1 text-left">TF</th>
                <th className="px-2 py-1 text-right">Entry</th>
                <th className="px-2 py-1 text-right">Exit</th>
                <th className="px-2 py-1 text-left">Exit reason</th>
                <th className="px-2 py-1 text-right">P&amp;L</th>
                <th className="px-2 py-1 text-right">R</th>
                <th className="px-2 py-1 text-right">Setup</th>
                <th className="px-2 py-1 text-left">Closed</th>
              </tr>
            </thead>
            <tbody>
              {closed.data.trades.map((trade) => (
                <tr key={trade.id} className="border-b border-term-border/40">
                  <td className="num px-2 py-1 text-[10px] text-term-dim">{trade.id}</td>
                  <td className="px-2 py-1 text-[10px] font-semibold text-term-text">{trade.symbol}</td>
                  <td className="px-2 py-1 text-[10px] text-term-muted">{trade.strategy ?? '—'}</td>
                  <td className="num px-2 py-1 text-[10px] text-term-dim">{trade.timeframe}</td>
                  <td className="num px-2 py-1 text-right text-[10px] text-term-muted">{fmtPrice(trade.entry)}</td>
                  <td className="num px-2 py-1 text-right text-[10px] text-term-muted">{fmtPrice(trade.exitPrice)}</td>
                  <td className="px-2 py-1 text-[10px] text-term-dim">{trade.exitReason ?? '—'}</td>
                  <td className={`num px-2 py-1 text-right text-[10px] ${(trade.pnl ?? 0) >= 0 ? 'text-term-up' : 'text-term-down'}`}>
                    {fmtUsd(trade.pnl)}
                  </td>
                  <td className={`num px-2 py-1 text-right text-[10px] ${(trade.rMultiple ?? 0) >= 0 ? 'text-term-up' : 'text-term-down'}`}>
                    {fmtR(trade.rMultiple)}
                  </td>
                  <td className="num px-2 py-1 text-right text-[10px] text-term-dim">{trade.setupScore ?? '—'}</td>
                  <td className="num px-2 py-1 text-[10px] text-term-dim">{fmtDateTime(trade.closedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-widest text-term-dim">{label}</div>
      <div className={`num text-[11px] ${tone ?? 'text-term-text'}`}>{value}</div>
    </div>
  );
}
