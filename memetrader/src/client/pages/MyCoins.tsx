import { useState } from 'react';
import type { TokenReport, Timeframe } from '../../shared/types.js';
import { TIMEFRAMES } from '../../shared/types.js';
import { ApiError, api, qs } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { TokenCard } from '../components/TokenCard.js';
import { TokenDetail } from './TokenDetail.js';
import { Button, DataUnavailable, Freshness, Loading, Panel, TextInput } from '../components/primitives.js';

interface TokensResponse {
  list: string;
  timeframe: Timeframe;
  count: number;
  tokens: { watchlistId: number; report: TokenReport | null; error?: string; requestedAddress?: string }[];
  fetchedAt: number;
}

interface HealthResponse {
  refresher: { running: boolean; requests: number; stored: number; lastError: string | null; gapMs: number };
}

const LIST = 'MY MEME COINS';

/**
 * MY MEME COINS.
 *
 * Cards refresh on a poll. Market data (price, liquidity, volume, transactions)
 * is live on every load; chart-derived analysis comes from the local candle
 * store that the background refresher fills, so a freshly added token shows its
 * market data immediately and its structure once bars have been collected.
 */
export function MyCoins() {
  const [timeframe, setTimeframe] = useState<Timeframe>('15m');
  const [selected, setSelected] = useState<string | null>(null);
  const [newAddress, setNewAddress] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const tokens = useApi<TokensResponse>(
    `/api/watchlist/tokens${qs({ list: LIST, timeframe })}`,
    45_000,
  );
  const health = useApi<HealthResponse>('/api/health', 30_000);

  const addToken = async () => {
    const address = newAddress.trim();
    if (!address) return;
    setAdding(true);
    setAddError(null);
    try {
      await api.post('/api/watchlist/tokens', { address, chain: 'solana', list: LIST, timeframe });
      setNewAddress('');
      tokens.reload();
    } catch (error) {
      setAddError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setAdding(false);
    }
  };

  if (selected) {
    return (
      <TokenDetail
        address={selected}
        timeframe={timeframe}
        onBack={() => setSelected(null)}
      />
    );
  }

  const refresher = health.data?.refresher;

  return (
    <div className="h-full min-h-0 overflow-auto p-2">
      <Panel
        title={LIST}
        subtitle={
          <Freshness fetchedAt={tokens.fetchedAt} staleAfterMs={90_000} source={`${tokens.data?.count ?? 0} tokens`} />
        }
        actions={
          <div className="flex items-center gap-1">
            {TIMEFRAMES.map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => setTimeframe(entry)}
                className={`num rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase transition ${
                  timeframe === entry
                    ? 'border-term-accent/60 bg-term-accent/10 text-term-accent'
                    : 'border-term-border text-term-dim hover:text-term-text'
                }`}
              >
                {entry}
              </button>
            ))}
            <Button onClick={() => tokens.reload()} variant="ghost">Refresh</Button>
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[320px] flex-1">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-term-dim">
              Add a Solana token by contract address
            </span>
            <TextInput
              value={newAddress}
              onChange={setNewAddress}
              placeholder="Paste a token mint address…"
              disabled={adding}
            />
          </div>
          <Button onClick={addToken} disabled={adding || newAddress.trim().length < 20} variant="primary">
            {adding ? 'Resolving…' : 'Add token'}
          </Button>
        </div>
        {addError ? (
          <p className="mb-3 rounded border border-term-down/40 bg-term-down/5 p-2 text-[11px] text-term-down">
            {addError}
          </p>
        ) : null}

        {refresher ? (
          <p className="mb-3 rounded border border-term-border bg-term-panel-2 p-2 text-[10px] leading-relaxed text-term-dim">
            Chart refresher: {refresher.running ? 'running' : 'stopped'} · {refresher.requests} requests made ·{' '}
            {refresher.stored.toLocaleString('en-US')} bars stored · one request every{' '}
            {Math.round(refresher.gapMs / 1000)}s.{' '}
            {refresher.lastError ? `Last issue: ${refresher.lastError}` : 'No errors.'}
            {' '}Price, liquidity, volume and transaction figures are fetched live on every refresh; only OHLCV is
            rate limited and collected in the background.
          </p>
        ) : null}

        {tokens.loading && !tokens.data ? (
          <Loading label="Loading tokens" />
        ) : tokens.error ? (
          <DataUnavailable reason={tokens.error.message} />
        ) : !tokens.data || tokens.data.tokens.length === 0 ? (
          <p className="text-xs text-term-dim">This watchlist is empty.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2 2xl:grid-cols-3">
            {tokens.data.tokens.map((entry) =>
              entry.report ? (
                <TokenCard key={entry.watchlistId} report={entry.report} onOpen={setSelected} />
              ) : (
                <div key={entry.watchlistId} className="rounded border border-term-down/40 bg-term-panel p-3">
                  <div className="num mb-2 truncate text-[11px] text-term-muted">
                    {entry.requestedAddress ?? 'unknown address'}
                  </div>
                  <DataUnavailable reason={entry.error ?? 'The report for this token failed.'} />
                </div>
              ),
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
