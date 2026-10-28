import { useState } from 'react';
import { Badge, Banner, Button, Card, Field, inputClass, Row, Segmented } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import { clockTime, price, usd } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';

export function RobinhoodPage({ symbol: initial }: { symbol: string }) {
  const facts = useApi('/api/robinhood');
  const [symbol, setSymbol] = useState(initial);
  const [tf, setTf] = useState<'1Day' | '1Hour' | '15Min' | '5Min'>('1Day');
  const [t, setT] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const f = facts.data;

  const build = async () => {
    setErr(null);
    setT(null);
    try {
      setT(await api('/api/robinhood/ticket', { body: { symbol, timeframe: tf } }));
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };

  return (
    <>
      <Banner tone="warn" title="This app does not connect to Robinhood and cannot place real orders.">
        It builds a reviewed order ticket. You place it yourself in Robinhood, or paste the prompt into an AI app you connected to Robinhood, and confirm the preview there.
      </Banner>

      <Card title="Real-money order ticket">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Ticker"><input className={inputClass} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /></Field>
        </div>
        <div className="mt-2"><Segmented value={tf} options={[{ value: '1Day', label: 'Daily' }, { value: '1Hour', label: '1h' }, { value: '15Min', label: '15m' }, { value: '5Min', label: '5m' }]} onChange={setTf} /></div>
        <Button className="mt-2 w-full" tone="primary" onClick={build}>Build ticket (uses real-money rules)</Button>
        {err && <p className="mt-2 text-sm text-down">{err}</p>}
        {t && (
          <div className="mt-3 space-y-1">
            <Row label="Ticker">{t.ticket.ticker}</Row>
            <Row label="Buy / sell">{t.ticket.side}</Row>
            <Row label="Quantity">{t.ticket.quantity}</Row>
            <Row label="Order type">{t.ticket.orderType}</Row>
            <Row label="Limit price">{price(t.ticket.limitPrice)}</Row>
            <Row label="Estimated price">{price(t.ticket.estimatedPrice)}</Row>
            <Row label="Estimated value">{usd(t.ticket.estimatedValue)}</Row>
            <Row label="Stop / TP1 / TP2">{price(t.ticket.stopLoss)} / {price(t.ticket.takeProfit1)} / {price(t.ticket.takeProfit2)}</Row>
            <Row label="Planned risk">{usd(t.ticket.plannedRisk)}</Row>
            <p className="text-xs text-down">{t.ticket.potentialLoss}</p>
            <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-dim">
              {t.ticket.warnings.map((w: string) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <p className="text-[11px] text-dim">Built {clockTime(t.generatedAt)} from {t.dataSource}.</p>
            <div className="mt-2 text-xs font-semibold text-dim uppercase">Prompt for an AI app connected to Robinhood</div>
            <pre className="rounded-lg border border-line bg-bg p-2 text-xs whitespace-pre-wrap">{t.agentPrompt}</pre>
            <Button className="w-full" onClick={async () => {
              try {
                await navigator.clipboard.writeText(t.agentPrompt);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}>{copied ? 'Copied' : 'Copy prompt'}</Button>
            <Banner tone="info" title="After it fills">{t.notice}</Banner>
          </div>
        )}
      </Card>

      {f && (
        <>
          <Card title="Official Robinhood integration — verified" right={<Badge>checked {f.checkedOn}</Badge>}>
            <p className="mb-1 text-xs text-dim">Endpoint: {f.officialEndpoint}</p>
            <ul className="list-disc space-y-1 pl-4 text-sm">
              {f.verified.map((v: string) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          </Card>
          <Card title="Not verified — do not assume">
            <ul className="list-disc space-y-1 pl-4 text-sm text-warn">
              {f.unverified.map((v: string) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          </Card>
          <Card title="Setup steps (you do these)">
            <ol className="list-decimal space-y-1 pl-4 text-sm">
              {f.setupSteps.map((v: string) => (
                <li key={v} className="break-words">{v}</li>
              ))}
            </ol>
            <p className="mt-2 text-[11px] text-dim">Never type your Robinhood password anywhere except Robinhood's own sign-in screen.</p>
          </Card>
          <Card title="Why it is not connected here">
            <ul className="list-disc space-y-1 pl-4 text-sm text-dim">
              {f.whyNotConnectedHere.map((v: string) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-dim">Sources: {f.sources.join(' · ')}</p>
          </Card>
        </>
      )}
    </>
  );
}
