import { useState } from 'react';
import type { AssetClass, MarketSnapshot } from '../../shared/types.js';
import { api, qs } from '../lib/api.js';
import { fmtPct, fmtPrice, fmtUsd } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';
import { Badge, Button, DataUnavailable, Freshness, Loading, TextInput } from './primitives.js';

export type ScannerTab =
  | 'meme'
  | 'crypto'
  | 'stocks'
  | 'watchlist'
  | 'new-pairs'
  | 'top-momentum'
  | 'unusual-volume'
  | 'potential-breakouts';

const TABS: { id: ScannerTab; label: string }[] = [
  { id: 'meme', label: 'Meme Coins' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'stocks', label: 'Stocks' },
  { id: 'watchlist', label: 'Watchlist' },
  { id: 'new-pairs', label: 'New Pairs' },
  { id: 'top-momentum', label: 'Top Momentum' },
  { id: 'unusual-volume', label: 'Unusual Volume' },
  { id: 'potential-breakouts', label: 'Potential Breakouts' },
];

interface ScanResponse {
  results: MarketSnapshot[];
  sources: { source: string; status: 'ok' | 'unavailable'; reason?: string; count: number }[];
  fetchedAt: number;
}

interface WatchlistLiveResponse {
  items: (
    | {
        status: 'ok';
        item: { id: number; assetId: string; symbol: string; timeframe: string; status: string; assetClass: AssetClass };
        price: number | null;
        changePct24h: number | null;
        volume24h: number | null;
        setupScore: number | null;
        riskScore: number | null;
        structure: string;
        derivedStatus: string;
      }
    | {
        status: 'unavailable';
        item: { id: number; assetId: string; symbol: string; timeframe: string; status: string; assetClass: AssetClass };
        reason: string;
      }
  )[];
}

export function Scanner({
  selectedId,
  onSelect,
  defaultTab = 'meme',
}: {
  selectedId: string | null;
  onSelect: (snapshot: { assetId: string; symbol: string; assetClass: AssetClass }) => void;
  defaultTab?: ScannerTab;
}) {
  const [tab, setTab] = useState<ScannerTab>(defaultTab);
  const [query, setQuery] = useState('');
  const [searchPath, setSearchPath] = useState<string | null>(null);

  const scan = useApi<ScanResponse>(
    tab === 'watchlist' || searchPath ? null : `/api/market/scan${qs({ tab })}`,
  );
  const searchResult = useApi<ScanResponse>(searchPath);
  const watchlist = useApi<WatchlistLiveResponse>(tab === 'watchlist' ? '/api/watchlist/live' : null);

  const active = searchPath ? searchResult : scan;

  const runSearch = () => {
    const trimmed = query.trim();
    setSearchPath(trimmed ? `/api/market/search${qs({ q: trimmed })}` : null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-term-border p-2">
        <div className="flex gap-1.5">
          <TextInput value={query} onChange={setQuery} placeholder="Search symbol or address…" />
          <Button onClick={runSearch}>Find</Button>
          {searchPath ? (
            <Button variant="ghost" onClick={() => { setSearchPath(null); setQuery(''); }}>
              Clear
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => { setTab(entry.id); setSearchPath(null); }}
              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition ${
                tab === entry.id && !searchPath
                  ? 'border-term-info/60 bg-term-info/10 text-term-info'
                  : 'border-term-border text-term-dim hover:border-term-border-bright hover:text-term-text'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'watchlist' && !searchPath ? (
          <WatchlistRows state={watchlist} selectedId={selectedId} onSelect={onSelect} />
        ) : (
          <ScanRows state={active} selectedId={selectedId} onSelect={onSelect} />
        )}
      </div>

      <div className="shrink-0 border-t border-term-border px-2 py-1.5">
        <Freshness fetchedAt={active.fetchedAt ?? watchlist.fetchedAt} />
      </div>
    </div>
  );
}

function ScanRows({
  state,
  selectedId,
  onSelect,
}: {
  state: ReturnType<typeof useApi<ScanResponse>>;
  selectedId: string | null;
  onSelect: (snapshot: { assetId: string; symbol: string; assetClass: AssetClass }) => void;
}) {
  if (state.loading && !state.data) return <div className="p-2"><Loading label="Scanning" /></div>;
  if (state.error) return <div className="p-2"><DataUnavailable reason={state.error.message} /></div>;
  if (!state.data) return null;

  const failed = state.data.sources.filter((s) => s.status === 'unavailable');

  return (
    <div>
      {failed.length > 0 ? (
        <div className="border-b border-term-warn/30 bg-term-warn/5 p-2">
          {failed.map((source) => (
            <p key={source.source} className="text-[10px] leading-relaxed text-term-warn">
              <span className="font-semibold">{source.source} unavailable:</span> {source.reason}
            </p>
          ))}
        </div>
      ) : null}

      {state.data.results.length === 0 ? (
        <div className="p-2">
          <DataUnavailable reason="No markets matched this tab from the connected data sources. This is an empty result, not a data failure — try another tab or search for a symbol." />
        </div>
      ) : (
        <div className="divide-y divide-term-border/50">
          {state.data.results.map((snapshot) => (
            <button
              key={snapshot.id}
              type="button"
              data-testid="scanner-row"
              onClick={() =>
                onSelect({ assetId: snapshot.id, symbol: snapshot.symbol, assetClass: snapshot.assetClass })
              }
              className={`block w-full px-2 py-1.5 text-left transition hover:bg-term-panel-2 ${
                selectedId === snapshot.id ? 'bg-term-accent/10' : ''
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[11px] font-semibold text-term-text">
                  {snapshot.symbol}
                </span>
                <span className="num shrink-0 text-[11px] text-term-text">
                  {fmtPrice(snapshot.priceUsd)}
                </span>
              </div>
              <div className="mt-0.5 flex items-baseline justify-between gap-2">
                <span className="truncate text-[9px] uppercase tracking-wider text-term-dim">
                  {snapshot.chain ?? snapshot.quoteSymbol ?? snapshot.provider}
                </span>
                <span className="flex shrink-0 items-baseline gap-2 text-[10px]">
                  <span className="text-term-dim">
                    L {snapshot.liquidityUsd === null ? '—' : fmtUsd(snapshot.liquidityUsd)}
                  </span>
                  <span className="text-term-dim">
                    V {snapshot.volume.h24 === undefined ? '—' : fmtUsd(snapshot.volume.h24)}
                  </span>
                  <span
                    className={`num w-14 text-right ${
                      (snapshot.priceChangePct.h24 ?? 0) > 0
                        ? 'text-term-up'
                        : (snapshot.priceChangePct.h24 ?? 0) < 0
                          ? 'text-term-down'
                          : 'text-term-muted'
                    }`}
                  >
                    {fmtPct(snapshot.priceChangePct.h24, 1)}
                  </span>
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function WatchlistRows({
  state,
  selectedId,
  onSelect,
}: {
  state: ReturnType<typeof useApi<WatchlistLiveResponse>>;
  selectedId: string | null;
  onSelect: (snapshot: { assetId: string; symbol: string; assetClass: AssetClass }) => void;
}) {
  if (state.loading && !state.data) return <div className="p-2"><Loading label="Evaluating watchlist" /></div>;
  if (state.error) return <div className="p-2"><DataUnavailable reason={state.error.message} /></div>;
  if (!state.data) return null;

  if (state.data.items.length === 0) {
    return (
      <div className="p-3 text-[11px] leading-relaxed text-term-dim">
        Your watchlist is empty. Select a market from another tab and use “Watch” on the analysis
        panel to add it.
      </div>
    );
  }

  const statusTone: Record<string, 'up' | 'warn' | 'info' | 'down' | 'neutral'> = {
    'ENTRY CONDITIONS MET': 'up',
    'SETUP FORMING': 'info',
    WATCH: 'neutral',
    INVALIDATED: 'down',
    'NO TRADE': 'warn',
  };

  return (
    <div className="divide-y divide-term-border/50">
      {state.data.items.map((entry) => (
        <button
          key={entry.item.id}
          type="button"
          onClick={() =>
            onSelect({
              assetId: entry.item.assetId,
              symbol: entry.item.symbol,
              assetClass: entry.item.assetClass,
            })
          }
          className={`block w-full px-2 py-2 text-left transition hover:bg-term-panel-2 ${
            selectedId === entry.item.assetId ? 'bg-term-accent/10' : ''
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-term-text">{entry.item.symbol}</span>
            <span className="num text-[10px] uppercase text-term-dim">{entry.item.timeframe}</span>
          </div>
          {entry.status === 'unavailable' ? (
            <div className="mt-1 text-[10px] text-term-warn">DATA UNAVAILABLE — {entry.reason}</div>
          ) : (
            <div className="mt-1 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="num text-[11px] text-term-text">{fmtPrice(entry.price)}</span>
                <span
                  className={`num text-[11px] ${
                    (entry.changePct24h ?? 0) > 0 ? 'text-term-up' : (entry.changePct24h ?? 0) < 0 ? 'text-term-down' : 'text-term-muted'
                  }`}
                >
                  {fmtPct(entry.changePct24h)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <Badge tone={statusTone[entry.derivedStatus] ?? 'neutral'}>{entry.derivedStatus}</Badge>
                <span className="text-[10px] text-term-dim">
                  Setup {entry.setupScore ?? '—'} · Risk {entry.riskScore ?? '—'}
                </span>
              </div>
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

export async function addToWatchlist(payload: {
  assetId: string;
  symbol: string;
  assetClass: AssetClass;
  timeframe: string;
}): Promise<void> {
  await api.post('/api/watchlist', payload);
}
