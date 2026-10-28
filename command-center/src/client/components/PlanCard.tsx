import { clockTime, price, shares, usd } from '../lib/format.js';
import { Badge, Card, Explain, Row } from './ui.js';

const ENTRY_STATUS: Record<string, { tone: 'up' | 'warn' | 'down'; text: string }> = {
  in_entry_zone: { tone: 'up', text: 'Price is in the entry zone' },
  waiting_for_trigger: { tone: 'warn', text: 'Waiting for confirmation' },
  past_entry_zone: { tone: 'down', text: 'Price already ran — do not chase' },
  below_stop: { tone: 'down', text: 'Price is below the stop — setup invalid' },
};

export function PlanCard({ plan }: { plan: any }) {
  const ok = plan.status === 'TRADE_PLAN';
  const es = plan.entryStatus ? ENTRY_STATUS[plan.entryStatus] : null;
  return (
    <Card
      title="Trade plan"
      right={
        <span className="text-[11px] text-dim">
          {plan.dataSource ?? 'no data'} · {clockTime(plan.priceTime)}
        </span>
      }
    >
      <div className={`mb-3 rounded-lg border p-3 text-center text-sm font-bold ${ok ? 'border-up/40 bg-up/10 text-up' : 'border-down/40 bg-down/10 text-down'}`}>{plan.headline}</div>

      <Row label="Ticker / price">{plan.symbol} · {price(plan.price)}</Row>
      <Row label="Timeframe">{plan.timeframe}</Row>
      <Row label="Trend">{plan.trend} (bigger picture: {plan.higherTimeframeTrend})</Row>
      <Row label="Setup">{plan.setupLabel ?? 'None'}</Row>
      {es && <Row label="Entry status"><Badge tone={es.tone}>{es.text}</Badge></Row>}

      {plan.plannedEntry !== null && (
        <>
          <Row label={<>Entry zone<Explain term="entry zone">The price range where buying fits the plan. Sizing assumes the top of the zone (the worst planned fill).</Explain></>}>
            {price(plan.entryLow)} – {price(plan.entryHigh)}
          </Row>
          <Row label={<>Stop-loss<Explain term="stop-loss">The price where the idea is proven wrong and you sell to cap the loss. It is not a guarantee: a gap can fill below it.</Explain></>}>
            <span className="text-down">{price(plan.stop)}</span>
          </Row>
          <Row label="Take-profit 1">
            <span className="text-up">{price(plan.tp1?.price)}</span> <span className="text-dim">({plan.tp1?.rewardRisk.toFixed(2)}R, {plan.tp1?.basis})</span>
          </Row>
          <Row label="Take-profit 2">
            <span className="text-up">{price(plan.tp2?.price)}</span> <span className="text-dim">({plan.tp2?.rewardRisk.toFixed(2)}R, {plan.tp2?.basis})</span>
          </Row>
          <Row label="Risk per share">{usd(plan.riskPerShare)}</Row>
          <Row label={<>Reward-to-risk<Explain term="reward-to-risk">How many dollars you aim to make for each dollar you risk. 2R means the target is twice as far as the stop.</Explain></>}>
            {plan.rewardRisk?.toFixed(2)}R
          </Row>
          <Row label={<>Position size<Explain term="position size">Shares chosen so that hitting the stop loses about your risk budget — not more — after costs.</Explain></>}>
            {plan.shares !== null ? `${shares(plan.shares)} sh · ${usd(plan.positionValue)}` : '—'}
          </Row>
          <Row label="Max planned loss">
            <span className="text-down">{usd(plan.maxPlannedLoss)}</span> <span className="text-dim">(budget {usd(plan.riskBudgetUsd)})</span>
          </Row>
          <Row label="Potential profit at TP1 / TP2">
            {usd(plan.tp1?.potentialProfit)} / {usd(plan.tp2?.potentialProfit)}
          </Row>
          <Row label={<>Est. costs & slippage<Explain term="slippage">Slippage is paying a bit more when you buy, or getting a bit less when you sell, than the price on screen. Regulatory fees apply to sells.</Explain></>}>
            {plan.costs ? `${usd(plan.costs.total, 3)} (slippage ${usd(plan.costs.entrySlippage + plan.costs.exitSlippage, 3)}, fees ${usd(plan.costs.regulatoryFees)})` : '—'}
          </Row>
        </>
      )}

      {plan.confirmation?.length > 0 && <List title="Confirmation needed before entry" items={plan.confirmation} tone="info" />}
      {plan.invalidation && <List title="What would prove this wrong" items={[plan.invalidation]} tone="warn" />}
      {plan.reasonsFor?.length > 0 && <List title="Reasons to enter" items={plan.reasonsFor} tone="up" />}
      {plan.reasonsAgainst?.length > 0 && <List title="Reasons to avoid" items={plan.reasonsAgainst} tone="down" />}

      <div className="mt-3">
        <div className="mb-1 text-xs font-semibold text-dim uppercase">Rule checks</div>
        <ul className="space-y-1">
          {plan.checks.map((c: any) => (
            <li key={c.name} className="flex gap-2 text-xs">
              <span className={c.pass ? 'text-up' : 'text-down'}>{c.pass ? '✓' : '✗'}</span>
              <span>
                <span className="font-semibold">{c.name}:</span> <span className="text-dim">{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <List title="Always remember" items={plan.warnings} tone="dim" />
    </Card>
  );
}

function List({ title, items, tone }: { title: string; items: string[]; tone: 'up' | 'down' | 'warn' | 'info' | 'dim' }) {
  const color = { up: 'text-up', down: 'text-down', warn: 'text-warn', info: 'text-info', dim: 'text-dim' }[tone];
  return (
    <div className="mt-3">
      <div className={`mb-1 text-xs font-semibold uppercase ${color}`}>{title}</div>
      <ul className="list-disc space-y-0.5 pl-4 text-xs text-ink/85">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}
