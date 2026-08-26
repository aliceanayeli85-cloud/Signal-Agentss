import { useEffect, useState } from 'react';
import type {
  AnalysisReport,
  AssetClass,
  FomoAssessment,
  LimitState,
  PositionSizingResult,
  Timeframe,
  TokenReport,
} from '../../shared/types.js';
import { RISK_PRESETS } from '../../engine/position-size.js';
import { ApiError, api } from '../lib/api.js';
import { fmtNum, fmtPrice, fmtUsd } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';
import { Badge, Button, DataUnavailable, Field, Select, StatRow, TextInput, WarningList } from './primitives.js';

interface LimitsResponse extends LimitState {
  message: string | null;
  settings: { accountSize: number; defaultRiskPct: number; maxRiskPctPerTrade: number };
}

interface PreflightResponse {
  fomo: FomoAssessment;
  limits: LimitState & { message: string | null };
  requiresConfirmation: boolean;
  blocked: boolean;
}

/**
 * The paper-trade entry ticket.
 *
 * Order of operations is deliberate and enforced: size the position, run the
 * discipline preflight, acknowledge any FOMO flag, and only then can the trade be
 * recorded. A daily-limit lock cannot be acknowledged away here at all - it is
 * lifted only in Settings, and doing so is recorded on every trade taken after.
 */
export function TradeTicket({
  report,
  tokenReport = null,
  assetId,
  symbol,
  assetClass,
  timeframe,
  onRecorded,
}: {
  report: AnalysisReport | null;
  /** Supplied by the token detail page; carries the chasing warning and scores. */
  tokenReport?: TokenReport | null;
  assetId: string;
  symbol: string;
  assetClass: AssetClass;
  timeframe: Timeframe;
  onRecorded: (tradeId: number) => void;
}) {
  const limits = useApi<LimitsResponse>('/api/trading/limits');
  // Both report shapes carry plan, detections, setupScore and risk; the token
  // report additionally carries the chasing warning.
  const source = report ?? tokenReport;
  const chasing = tokenReport?.chasing ?? null;
  const [chaseAcknowledged, setChaseAcknowledged] = useState(false);
  const [riskPct, setRiskPct] = useState<number>(1);
  const [accountSize, setAccountSize] = useState<string>('');
  const [entry, setEntry] = useState('');
  const [stop, setStop] = useState('');
  const [target, setTarget] = useState('');
  const [sizing, setSizing] = useState<PositionSizingResult | null>(null);
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (limits.data) {
      setAccountSize(String(limits.data.settings.accountSize));
      setRiskPct(limits.data.settings.defaultRiskPct);
    }
  }, [limits.data]);

  // Prefill from the computed plan so the ticket matches what the analysis says.
  useEffect(() => {
    if (source?.plan.available) {
      setEntry(String(source.plan.entry));
      setStop(String(source.plan.stop));
      setTarget(String(source.plan.targets.tp2));
    } else {
      setEntry('');
      setStop('');
      setTarget('');
    }
    setSizing(null);
    setPreflight(null);
    setAcknowledged(false);
    setChaseAcknowledged(false);
    setMessage(null);
    setError(null);
  }, [source?.plan, assetId, timeframe]);

  const highVolatility = assetClass === 'meme' || (source?.risk?.score ?? 0) >= 50;

  const runSizing = async () => {
    setError(null);
    try {
      const result = await api.post<PositionSizingResult>('/api/trading/position-size', {
        accountSize: Number(accountSize),
        riskPct,
        entry: Number(entry),
        stop: Number(stop),
        target: target ? Number(target) : null,
        direction: source?.plan.available ? source.plan.direction : undefined,
        highVolatility,
      });
      setSizing(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const runPreflight = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await api.post<PreflightResponse>('/api/trading/preflight', {
        assetId,
        timeframe,
        riskPct,
      });
      setPreflight(result);
      setAcknowledged(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const record = async () => {
    if (!sizing?.available) return;
    setError(null);
    setBusy(true);
    try {
      const trade = await api.post<{ id: number }>('/api/trading/paper-trades', {
        assetId,
        symbol,
        assetClass,
        timeframe,
        strategy: source?.detections[0]?.strategy ?? null,
        direction: source?.plan.available ? source.plan.direction : 'long',
        entry: Number(entry),
        stop: Number(stop),
        tp1: source?.plan.available ? source.plan.targets.tp1 : null,
        tp2: source?.plan.available ? source.plan.targets.tp2 : null,
        tp3: source?.plan.available ? source.plan.targets.tp3 : null,
        positionSize: sizing.positionSize,
        accountSize: Number(accountSize),
        riskPct,
        riskAmount: sizing.maxDollarRisk,
        setupScore: source?.setupScore?.score ?? null,
        riskScore: source?.risk?.score ?? null,
        marketConditions: buildConditions(),
        fomoAcknowledged: acknowledged || chaseAcknowledged,
      });
      setMessage(`Paper trade #${trade.id} recorded. Complete the pre-trade journal next.`);
      onRecorded(trade.id);
      limits.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** Everything true at the moment of entry, recorded with the trade. */
  const buildConditions = (): string | null => {
    if (!source) return null;
    const parts = [
      `structure ${source.structure?.label ?? 'unavailable'}`,
      `alignment ${source.alignment.alignment}`,
      `${source.detections.length} setup(s) detected`,
    ];
    if (tokenReport) {
      parts.push(
        `status ${tokenReport.tradeStatus.status}`,
        `volume ${tokenReport.volume.flag}`,
        `liquidity ${tokenReport.liquidity.label}`,
      );
      if (tokenReport.chasing.triggered) parts.push('chasing warning acknowledged');
    }
    return parts.join('; ');
  };

  const locked = limits.data?.locked === true;
  const needsAck = preflight?.requiresConfirmation === true && !acknowledged;
  // The chasing warning does NOT block the trade - it requires acknowledgement.
  const needsChaseAck = chasing?.triggered === true && !chaseAcknowledged;
  const canRecord =
    sizing?.available === true && preflight !== null && !needsAck && !needsChaseAck && !locked && !busy;

  return (
    <div className="space-y-3">
      {locked && limits.data ? (
        <div className="rounded border border-term-down bg-term-down/10 p-3">
          <div className="mb-1 text-xs font-bold uppercase tracking-widest text-term-down">
            {limits.data.message}
          </div>
          <ul className="space-y-0.5">
            {limits.data.reasons.map((reason) => (
              <li key={reason} className="text-[11px] text-term-down">· {reason}</li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] leading-relaxed text-term-muted">
            New paper entries are blocked. This can be overridden only from Settings, in simulation
            mode, and every trade taken while the override is on is recorded as such.
          </p>
        </div>
      ) : null}

      {chasing?.triggered ? (
        <div className="rounded border border-term-warn bg-term-warn/10 p-3">
          <div className="mb-1.5 text-xs font-bold uppercase tracking-widest text-term-warn">
            {chasing.headline}
          </div>
          <p className="mb-2 text-[11px] leading-relaxed text-term-warn">{chasing.message}</p>
          <label className="flex cursor-pointer items-start gap-2 text-[11px] text-term-text">
            <input
              type="checkbox"
              checked={chaseAcknowledged}
              onChange={(event) => setChaseAcknowledged(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              I have seen how far this has already moved and am proceeding anyway. Record the trade as
              flagged.
            </span>
          </label>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Account size">
          <TextInput type="number" value={accountSize} onChange={setAccountSize} />
        </Field>
        <Field label="Risk %">
          <Select
            value={String(riskPct)}
            onChange={(value) => setRiskPct(Number(value))}
            options={RISK_PRESETS.map((preset) => ({ value: String(preset), label: `${preset}%` }))}
          />
        </Field>
        <Field label="Entry">
          <TextInput type="number" value={entry} onChange={setEntry} />
        </Field>
        <Field label="Stop">
          <TextInput type="number" value={stop} onChange={setStop} />
        </Field>
        <Field label="Target (for R:R)">
          <TextInput type="number" value={target} onChange={setTarget} />
        </Field>
        <div className="flex items-end">
          <Button onClick={runSizing} className="w-full">Calculate size</Button>
        </div>
      </div>

      {riskPct > 2 ? (
        <WarningList
          warnings={[
            `Risking ${riskPct}% per trade is above the 2% ceiling. Three losses in a row costs ${(riskPct * 3).toFixed(1)}% of the account.`,
          ]}
        />
      ) : null}
      {highVolatility && riskPct > 0.5 ? (
        <WarningList
          warnings={[
            'This market is flagged high volatility. On markets like this the correct response is a smaller position, not a wider stop.',
          ]}
        />
      ) : null}

      {sizing ? (
        sizing.available ? (
          <div className="rounded border border-term-border bg-term-panel-2 p-2.5">
            <StatRow
              label="Sized as"
              value={`${sizing.direction.toUpperCase()}${sizing.directionInferred ? ' (inferred from the stop)' : ''}`}
              tone={sizing.direction === 'long' ? 'text-term-up' : 'text-term-down'}
            />
            <StatRow label="Max dollar risk" value={fmtUsd(sizing.maxDollarRisk)} tone="text-term-down" />
            <StatRow label="Position size (units)" value={fmtPrice(sizing.positionSize)} />
            <StatRow label="Position value" value={fmtUsd(sizing.positionValue)} />
            <StatRow label="Potential loss" value={fmtUsd(-sizing.potentialLoss)} tone="text-term-down" />
            <StatRow
              label="Potential profit"
              value={sizing.potentialProfit === null ? '—' : fmtUsd(sizing.potentialProfit)}
              tone="text-term-up"
            />
            <StatRow
              label="Risk / reward"
              value={sizing.rr === null ? '—' : `${fmtNum(sizing.rr)}R`}
              explainKey="r-multiple"
            />
            <div className="mt-2">
              <WarningList warnings={sizing.warnings} />
            </div>
          </div>
        ) : (
          <DataUnavailable reason={sizing.reason} />
        )
      ) : null}

      <div className="flex gap-2">
        <Button onClick={runPreflight} disabled={busy || !sizing?.available} variant="primary">
          Run discipline check
        </Button>
        <Button onClick={record} disabled={!canRecord} variant={canRecord ? 'primary' : 'default'}>
          Record paper trade
        </Button>
      </div>

      {preflight ? (
        preflight.fomo.triggered ? (
          <div className="rounded border border-term-warn bg-term-warn/10 p-3">
            <div className="mb-1.5 text-xs font-bold uppercase tracking-widest text-term-warn">
              FOMO warning
            </div>
            <p className="mb-2 text-[11px] text-term-warn">{preflight.fomo.message}</p>
            <ul className="mb-2 space-y-1.5">
              {preflight.fomo.flags.map((flag) => (
                <li key={flag.key} className="text-[11px] leading-relaxed">
                  <span className="font-semibold text-term-text">{flag.label}</span>
                  <span className="block text-term-muted">{flag.detail}</span>
                </li>
              ))}
            </ul>
            <label className="flex cursor-pointer items-start gap-2 text-[11px] text-term-text">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                I have read these flags and am taking this trade anyway. Record it as flagged so it
                shows up in my journal and performance breakdown.
              </span>
            </label>
          </div>
        ) : (
          <div className="rounded border border-term-up/40 bg-term-up/5 p-2.5 text-[11px] text-term-up">
            No FOMO flags raised. This entry matches your predefined rules.
          </div>
        )
      ) : (
        <p className="text-[10px] leading-relaxed text-term-dim">
          The discipline check must run before a trade can be recorded. It looks for entering after a
          vertical move, re-entering something you just exited, trading through a losing streak,
          increasing size above your baseline, and entering with no defined setup.
        </p>
      )}

      {message ? (
        <div className="rounded border border-term-up/40 bg-term-up/5 p-2.5 text-[11px] text-term-up">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="rounded border border-term-down/40 bg-term-down/5 p-2.5 text-[11px] text-term-down">
          {error}
        </div>
      ) : null}

      <p className="text-[10px] leading-relaxed text-term-dim">
        <Badge tone="up">PAPER ONLY</Badge> Recording a trade writes a row to your local database.
        Nothing is sent to an exchange, no wallet is touched and no order is placed.
      </p>
    </div>
  );
}
