import { Badge, Banner, Card, Row } from '../components/ui.js';
import { pct } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';

const p = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(d)}%`);
const r4 = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x.toFixed(4));

export function HistoryPage() {
  const h = useApi('/api/agent/history', 120_000);
  const d = h.data;
  return (
    <>
      <h1 className="text-xl font-bold">AI History</h1>
      {h.error && <Banner tone="down" title="Problem">{h.error.message}</Banner>}
      {d && !d.model && <Banner tone="warn" title="No trained model">The forecast model file is missing.</Banner>}
      {d?.model && (
        <Card title={`Forecast model ${d.model.version} — validation record`}>
          <p className="mb-2 text-xs text-dim">
            Trained {d.model.splits.trainEnd ? `on data to ${d.model.splits.trainEnd}` : ''}; calibrated on {d.model.splits.validationStart}–{d.model.splits.validationEnd}; tested once on {d.model.splits.testStart} onward (never used for fitting). 109 liquid US stocks and ETFs, daily candles, costs not included in direction scoring.
          </p>
          {d.model.horizons.map((m: any) => (
            <div key={m.horizon} className="mb-3 rounded-lg border border-line bg-panel2 p-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{m.horizon}-day direction</span>
                <Badge tone={m.report.status === 'VALIDATED' ? 'up' : 'warn'}>{m.report.status}</Badge>
              </div>
              <ul className="mt-1 list-disc pl-4 text-xs text-ink/85">
                {m.report.reasons.map((x: string) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <div className="mt-2">
                <Row label="Samples (train / val / test)">{`${m.report.samples.train.toLocaleString()} / ${m.report.samples.validation.toLocaleString()} / ${m.report.samples.test.toLocaleString()}`}</Row>
                <Row label="Base rate (train)">{p(m.baseRate)}</Row>
                <Row label="Test Brier: model / base">{`${r4(m.report.test.brier)} / ${r4(m.report.test.baseBrier)}`}</Row>
                <Row label="Brier skill (90% CI)">{`${p(m.report.test.brierSkill, 2)} [${p(m.report.test.brierSkillCi[0], 2)}, ${p(m.report.test.brierSkillCi[1], 2)}]`}</Row>
                <Row label="vs momentum rule">{p(m.report.test.momentumSkill, 2)}</Row>
                <Row label="Test accuracy">{p(m.report.test.accuracy)}</Row>
                <Row label="Calibration error">{`${(m.report.calibrationError * 100).toFixed(1)} pts`}</Row>
                <Row label="Top − bottom bucket return">{p(m.report.spread, 2)}</Row>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-info">Calibration by bucket (predicted vs what happened on test)</summary>
                <table className="mt-1 w-full text-[11px]">
                  <thead className="text-dim">
                    <tr>
                      <th className="text-left">Bucket</th>
                      <th className="text-right">Predicted P(up)</th>
                      <th className="text-right">Test actual</th>
                      <th className="text-right">Test n</th>
                      <th className="text-right">Test avg return</th>
                    </tr>
                  </thead>
                  <tbody className="num">
                    {m.buckets.map((b: any, i: number) => (
                      <tr key={i} className="border-t border-line/60">
                        <td>{i + 1}</td>
                        <td className="text-right">{p(b.pUp)}</td>
                        <td className="text-right">{p(b.testPUp)}</td>
                        <td className="text-right">{b.testN.toLocaleString()}</td>
                        <td className="text-right">{p(b.testMeanRet, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          ))}
          <p className="text-[11px] text-dim">Brier score measures probability accuracy (lower is better). A model is only allowed to show probabilities if it beats both simple benchmarks on the test years. None did, so the app shows INSUFFICIENT EVIDENCE and keeps the model in shadow mode.</p>
        </Card>
      )}
      {d && (
        <Card title="Live forward test (shadow mode)">
          <p className="mb-2 text-xs text-dim">{d.note}</p>
          <Row label="Predictions recorded since">{d.firstPrediction ?? 'none yet'}</Row>
          <Row label="Waiting for their outcome">{d.unresolved}</Row>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="text-dim">
                <tr>
                  <th className="text-left">Horizon</th>
                  <th className="text-right">Resolved</th>
                  <th className="text-right">Went up</th>
                  <th className="text-right">Brier shadow / base</th>
                  <th className="text-right">Top vs bottom buckets</th>
                </tr>
              </thead>
              <tbody className="num">
                {d.live.map((l: any) => (
                  <tr key={l.horizon} className="border-t border-line/60">
                    <td className="py-1">{l.horizon}d</td>
                    <td className="text-right">{l.resolved}</td>
                    <td className="text-right">{p(l.upRate, 0)}</td>
                    <td className="text-right">{`${r4(l.shadowBrier)} / ${r4(l.baseBrier)}`}</td>
                    <td className="text-right">{`${p(l.topBucketsAvgReturn, 2)} vs ${p(l.bottomBucketsAvgReturn, 2)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-info">How each recommendation label has done (5-day outcomes)</summary>
            <table className="mt-1 w-full text-[11px]">
              <tbody className="num">
                {d.live.find((l: any) => l.horizon === 5)?.byClass.map((c: any) => (
                  <tr key={c.classification} className="border-t border-line/60">
                    <td className="py-1">{c.classification}</td>
                    <td className="text-right">{c.n} resolved</td>
                    <td className="text-right">{p(c.upRate, 0)} up</td>
                    <td className="text-right">avg {p(c.avgReturn, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </Card>
      )}
      {d && (
        <Card title="Winning and losing calls (BUY labels, 5 days later)">
          {d.winners.length + d.losers.length === 0 && <p className="text-sm text-dim">No BUY-labelled prediction has reached its 5-day outcome yet.</p>}
          {[...d.winners, ...d.losers].map((x: any) => (
            <div key={`${x.symbol}${x.asof_date}`} className="flex justify-between border-b border-line/60 py-1 text-xs last:border-0">
              <span>{x.symbol} · {x.asof_date} → {x.outcome_date}</span>
              <span className={x.actual_return > 0 ? 'text-up' : 'text-down'}>{pct(x.actual_return)}</span>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
