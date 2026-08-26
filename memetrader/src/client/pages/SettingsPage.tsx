import { useEffect, useState } from 'react';
import type { AlertRule, Settings } from '../../shared/types.js';
import { EXPLANATIONS } from '../../shared/education.js';
import { ApiError, api } from '../lib/api.js';
import { fmtDateTime } from '../lib/format.js';
import { useApi } from '../lib/useApi.js';
import { Badge, Button, DataUnavailable, Field, Loading, Panel, TextInput, WarningList } from '../components/primitives.js';

interface SettingsResponse {
  settings: Settings;
  defaults: Settings;
}

interface HealthResponse {
  providers: {
    id: string;
    displayName: string;
    assetClasses: string[];
    docsUrl: string;
    configured: boolean;
    reason: string;
    timeframes: string[];
  }[];
  execution: { liveTradingEnabled: boolean; note: string };
  ai: { configured: boolean; model: string };
}

export function SettingsPage() {
  const current = useApi<SettingsResponse>('/api/desk/settings');
  const health = useApi<HealthResponse>('/api/health');
  const alerts = useApi<{ alerts: AlertRule[]; note: string }>('/api/alerts');

  const [draft, setDraft] = useState<Settings | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (current.data) setDraft(current.data.settings);
  }, [current.data]);

  const update = (patch: Partial<Settings>) => {
    setDraft((existing) => (existing ? { ...existing, ...patch } : existing));
  };

  const save = async () => {
    if (!draft) return;
    setError(null);
    setStatus(null);
    try {
      const response = await api.put<{ settings: Settings; warnings: string[] }>('/api/desk/settings', draft);
      setDraft(response.settings);
      setWarnings(response.warnings);
      setStatus('Settings saved.');
      current.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-2 gap-2 overflow-auto p-2">
      <div className="flex min-h-0 flex-col gap-2">
        <Panel title="Risk limits" subtitle="These limits lock new paper entries when they are reached">
          {current.loading && !draft ? (
            <Loading />
          ) : current.error ? (
            <DataUnavailable reason={current.error.message} />
          ) : draft ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Account size">
                  <TextInput type="number" value={draft.accountSize} onChange={(v) => update({ accountSize: Number(v) })} />
                </Field>
                <Field label="Default risk % per trade">
                  <TextInput type="number" step="0.25" value={draft.defaultRiskPct} onChange={(v) => update({ defaultRiskPct: Number(v) })} />
                </Field>
                <Field label="Maximum risk % per trade">
                  <TextInput type="number" step="0.25" value={draft.maxRiskPctPerTrade} onChange={(v) => update({ maxRiskPctPerTrade: Number(v) })} />
                </Field>
                <Field label="Maximum trades per day">
                  <TextInput type="number" value={draft.maxTradesPerDay} onChange={(v) => update({ maxTradesPerDay: Number(v) })} />
                </Field>
                <Field label="Daily loss limit %">
                  <TextInput type="number" step="0.5" value={draft.maxDailyLossPct} onChange={(v) => update({ maxDailyLossPct: Number(v) })} />
                </Field>
                <Field label="Maximum consecutive losses">
                  <TextInput type="number" value={draft.maxConsecutiveLosses} onChange={(v) => update({ maxConsecutiveLosses: Number(v) })} />
                </Field>
              </div>

              <label className="flex cursor-pointer items-start gap-2 rounded border border-term-warn/40 bg-term-warn/5 p-2.5 text-[11px] text-term-warn">
                <input
                  type="checkbox"
                  checked={draft.simulationOverride === 1}
                  onChange={(event) => update({ simulationOverride: event.target.checked ? 1 : 0 })}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-semibold">Simulation override.</span> Lifts the daily-limit
                  lock so you can keep paper trading past your own limits. This exists to let you
                  study what happens when limits are ignored — it applies to simulation only, and
                  every trade taken while it is on is recorded as flagged.
                </span>
              </label>

              <div className="flex items-center gap-2">
                <Button onClick={save} variant="primary">Save settings</Button>
                {status ? <span className="text-[11px] text-term-up">{status}</span> : null}
                {error ? <span className="text-[11px] text-term-down">{error}</span> : null}
              </div>

              <WarningList warnings={warnings} />
            </div>
          ) : null}
        </Panel>

        <Panel title="Alerts" subtitle={alerts.data?.note}>
          {alerts.loading && !alerts.data ? (
            <Loading />
          ) : alerts.error ? (
            <DataUnavailable reason={alerts.error.message} />
          ) : !alerts.data || alerts.data.alerts.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-term-dim">
              No alerts configured. Alerts are local notifications evaluated when the app polls —
              they never place, modify or cancel an order.
            </p>
          ) : (
            <div className="space-y-1">
              {alerts.data.alerts.map((alert) => (
                <div key={alert.id} className="flex items-center justify-between gap-2 rounded border border-term-border bg-term-panel-2 px-2 py-1.5">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-term-text">{alert.symbol}</span>
                      <Badge tone="info">{alert.kind}</Badge>
                      <span className="num text-[10px] text-term-dim">{alert.timeframe}</span>
                    </div>
                    {alert.lastMessage ? (
                      <div className="mt-0.5 text-[10px] text-term-muted">
                        Last fired {fmtDateTime(alert.lastFiredAt)}: {alert.lastMessage}
                      </div>
                    ) : null}
                  </div>
                  <Button
                    variant="danger"
                    onClick={async () => {
                      await api.del(`/api/alerts/${alert.id}`);
                      alerts.reload();
                    }}
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="flex min-h-0 flex-col gap-2">
        <Panel title="Data sources" subtitle="What this build is actually connected to">
          {health.data ? (
            <div className="space-y-2">
              {health.data.providers.map((provider) => (
                <div key={provider.id} className="rounded border border-term-border bg-term-panel-2 p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-semibold text-term-text">{provider.displayName}</span>
                    <Badge tone={provider.configured ? 'up' : 'warn'}>
                      {provider.configured ? 'Connected' : 'Needs API key'}
                    </Badge>
                    {provider.assetClasses.map((assetClass) => (
                      <Badge key={assetClass}>{assetClass}</Badge>
                    ))}
                  </div>
                  {provider.timeframes.length > 0 ? (
                    <div className="num mt-1 text-[10px] text-term-dim">
                      Timeframes: {provider.timeframes.join(', ')}
                    </div>
                  ) : provider.configured ? (
                    <div className="mt-1 text-[10px] text-term-dim">
                      No OHLCV from this source; it supplies market metadata only.
                    </div>
                  ) : null}
                  {provider.reason ? (
                    <p className="mt-1 text-[10px] leading-relaxed text-term-warn">{provider.reason}</p>
                  ) : null}
                  <a
                    href={provider.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block text-[10px] text-term-info hover:underline"
                  >
                    Provider documentation ↗
                  </a>
                </div>
              ))}

              <div className="rounded border border-term-border bg-term-panel-2 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-term-text">AI analysis</span>
                  <Badge tone={health.data.ai.configured ? 'up' : 'warn'}>
                    {health.data.ai.configured ? `Enabled (${health.data.ai.model})` : 'Needs ANTHROPIC_API_KEY'}
                  </Badge>
                </div>
                <p className="mt-1 text-[10px] leading-relaxed text-term-dim">
                  Optional. Every other feature works without it.
                </p>
              </div>

              <div className="rounded border border-term-up/40 bg-term-up/5 p-2.5">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-term-up">
                  Execution
                </div>
                <p className="text-[11px] leading-relaxed text-term-muted">{health.data.execution.note}</p>
              </div>
            </div>
          ) : (
            <Loading />
          )}
        </Panel>

        <Panel title="Glossary" subtitle="Every term the app uses, explained">
          <div className="space-y-1.5">
            {Object.entries(EXPLANATIONS).map(([key, entry]) => (
              <details key={key} className="rounded border border-term-border bg-term-panel-2">
                <summary className="px-2.5 py-1.5 text-[11px] font-medium text-term-text hover:text-term-info">
                  {entry.term} — <span className="text-term-dim">{entry.short}</span>
                </summary>
                <p className="border-t border-term-border px-2.5 py-2 text-[11px] leading-relaxed text-term-muted">
                  {entry.long}
                </p>
              </details>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
