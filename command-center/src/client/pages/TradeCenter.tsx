import { useState } from 'react';
import type { Nav } from '../App.js';
import { Badge, Banner, Button, Card, inputClass, Row } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import { clockTime, price, signedUsd, usd } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';

export function TradeCenter({ nav }: { nav: Nav }) {
  const t = useApi('/api/agent/tickets', 60_000);
  const tickets: any[] = t.data?.tickets ?? [];
  return (
    <>
      <h1 className="text-xl font-bold">Trade Center</h1>
      <Banner tone="warn" title="Every real-money order needs your explicit approval">
        The agent prepares tickets. Approving one records your decision and shows the exact steps — you then place it yourself in Robinhood. Nothing is ever sent automatically.
      </Banner>
      {t.error && <Banner tone="down" title="Problem">{t.error.message}</Banner>}
      {tickets.length === 0 && (
        <Card title="No tickets yet">
          <p className="text-sm text-dim">Open an idea (or one of your holdings) and press "Prepare buy ticket" / "Prepare sell ticket". Buy tickets are refused when the plan does not fit your cash — the agent will tell you to keep your money instead.</p>
          <div className="mt-2 flex gap-2">
            <Button className="flex-1" onClick={() => nav.go('ideas')}>Ideas</Button>
            <Button className="flex-1" onClick={() => nav.go('robinhood')}>My holdings</Button>
          </div>
        </Card>
      )}
      {tickets.map((x) => (
        <Ticket key={x.id} x={x} onChange={t.reload} />
      ))}
      <Card title="Practice instead">
        <p className="text-xs text-dim">Simulated orders (no real money) are under More → Paper trading, and the experimental C1 strategy runs its own paper portfolio.</p>
      </Card>
    </>
  );
}

function Ticket({ x, onChange }: { x: any; onChange: () => void }) {
  const k = x.ticket;
  const [typed, setTyped] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const decide = async (d: 'approve' | 'reject') => {
    try {
      const r = await api(`/api/agent/tickets/${x.id}/${d}`, { body: d === 'approve' ? { confirm: typed } : {} });
      setMsg(r.message);
      onChange();
    } catch (e) {
      setMsg((e as ApiError).message);
    }
  };
  const tone = x.status === 'approved' ? 'up' : x.status === 'proposed' ? 'info' : 'dim';
  return (
    <Card title={`${k.side} ${x.symbol}`} right={<Badge tone={tone}>{x.status}</Badge>}>
      <Row label="Company">{k.name ?? '—'}</Row>
      <Row label="Recommendation">{k.classification}</Row>
      <Row label="Quantity">{`${k.shares} shares (≈ ${usd(k.dollarAmount)})`}</Row>
      <Row label="Order type">{k.orderType}</Row>
      <Row label="Limit / reference price">{price(k.limitPrice)}</Row>
      {k.side === 'BUY' && (
        <>
          <Row label="Entry range">{`${price(k.entryRange[0])} – ${price(k.entryRange[1])}`}</Row>
          <Row label="Stop-loss">{price(k.stop)}</Row>
          <Row label="Targets">{`${price(k.tp1)} / ${price(k.tp2)}`}</Row>
          <Row label="Reward-to-risk">{k.rewardRisk.toFixed(2)}</Row>
          <Row label="Max planned loss">{`${usd(k.maxLoss)} — more on a gap`}</Row>
          <Row label="Est. costs">{usd(k.costs, 3)}</Row>
        </>
      )}
      {k.side === 'SELL' && <Row label="Est. profit / loss vs cost">{signedUsd(k.estimatedPnl)}</Row>}
      <p className="mt-2 text-xs text-ink/85">{k.reasons.join(' ')}</p>
      <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-dim">
        {k.warnings.map((w: string) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-dim">Created {clockTime(x.created_at)} · expires {clockTime(x.expires_at)}</p>
      {x.status === 'proposed' && (
        <div className="mt-2 space-y-2">
          <input className={inputClass} placeholder="Type APPROVE to approve" value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="characters" />
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => decide('reject')}>Reject</Button>
            <Button className="flex-1" tone="primary" disabled={typed !== 'APPROVE'} onClick={() => decide('approve')}>Approve plan</Button>
          </div>
        </div>
      )}
      {x.status === 'approved' && (
        <div className="mt-2 space-y-2">
          <Banner tone="up" title="Approved — now place it yourself">
            In the Robinhood app: search {x.symbol} → {k.side === 'BUY' ? 'Buy' : 'Sell'} → enter the amount → review → submit. Or paste this into an AI app connected to Robinhood and reply CONFIRM only if the preview matches:
          </Banner>
          <pre className="rounded-lg border border-line bg-bg p-2 text-xs whitespace-pre-wrap">{k.agentPrompt}</pre>
          <Button className="w-full" onClick={async () => {
            try {
              await navigator.clipboard.writeText(k.agentPrompt);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}>{copied ? 'Copied' : 'Copy prompt'}</Button>
          <p className="text-[11px] text-dim">After it fills, update My Robinhood with the real shares and cost.</p>
        </div>
      )}
      {msg && <p className="mt-2 text-xs text-info">{msg}</p>}
    </Card>
  );
}
