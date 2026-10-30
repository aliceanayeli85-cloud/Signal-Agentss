import { useState } from 'react';
import type { Nav } from '../App.js';
import { OpportunityCard } from '../components/agent.js';
import { Banner, Card, Segmented } from '../components/ui.js';
import { clockTime } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';

const FILTERS = [
  { value: 'buy', label: 'Buy ideas' },
  { value: 'held', label: 'Owned' },
  { value: 'avoid', label: 'Avoid' },
  { value: 'all', label: 'All' },
] as const;

export function IdeasPage({ nav }: { nav: Nav }) {
  const r = useApi('/api/agent/opportunities', 120_000);
  const [f, setF] = useState<(typeof FILTERS)[number]['value']>('buy');
  const [showRules, setShowRules] = useState(false);
  const all: any[] = r.data?.opportunities ?? [];
  const list = all.filter((o) => (f === 'buy' ? o.classification === 'BUY WATCHLIST' || o.classification === 'STRONG BUY SETUP' : f === 'held' ? o.held : f === 'avoid' ? o.classification === 'AVOID' || o.classification === 'SELL WATCH' : true));
  return (
    <>
      <div className="flex items-end justify-between">
        <h1 className="text-xl font-bold">Top opportunities</h1>
        {r.data?.run && <span className="text-[11px] text-dim">scan {clockTime(r.data.run.finishedAt)} · {all.length} analysed</span>}
      </div>
      <Segmented value={f} options={[...FILTERS]} onChange={setF} />
      {r.error && <Banner tone="down" title="Problem">{r.error.message}</Banner>}
      {r.data && !r.data.run && <Banner tone="info" title="No scan yet">Run a scan from the Agent tab.</Banner>}
      <div className="space-y-2">
        {list.slice(0, 60).map((o) => (
          <OpportunityCard key={o.symbol} o={o} onOpen={() => nav.go('more', { more: 'stock', symbol: o.symbol })} />
        ))}
        {r.data?.run && list.length === 0 && <p className="text-sm text-dim">Nothing in this group.</p>}
      </div>
      {r.data && (
        <Card title="How labels and ranking work">
          <p className="text-xs text-ink/85">{r.data.rankingRule}</p>
          <button className="mt-2 text-xs text-info underline" onClick={() => setShowRules(!showRules)}>{showRules ? 'Hide' : 'Show'} the exact rule for each label</button>
          {showRules && (
            <dl className="mt-2 space-y-1.5 text-xs">
              {Object.entries(r.data.classRules).map(([k, v]) => (
                <div key={k}>
                  <dt className="font-semibold">{k}</dt>
                  <dd className="text-ink/80">{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
      )}
    </>
  );
}
