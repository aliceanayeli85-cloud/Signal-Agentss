import { useEffect, useState } from 'react';
import { useApi } from './lib/useApi.js';
import { Badge } from './components/primitives.js';
import { MemeDesk } from './pages/MemeDesk.js';
import { DayTradeDesk } from './pages/DayTradeDesk.js';
import { SwingDesk } from './pages/SwingDesk.js';
import { BacktestPage } from './pages/BacktestPage.js';
import { PaperTradePage } from './pages/PaperTradePage.js';
import { JournalPage } from './pages/JournalPage.js';
import { PerformancePage } from './pages/PerformancePage.js';
import { SettingsPage } from './pages/SettingsPage.js';

const TABS = [
  { id: 'meme', label: 'Meme' },
  { id: 'day', label: 'Day Trade' },
  { id: 'swing', label: 'Swing' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'paper', label: 'Paper Trade' },
  { id: 'journal', label: 'Journal' },
  { id: 'performance', label: 'Performance' },
  { id: 'settings', label: 'Settings' },
] as const;

type TabId = (typeof TABS)[number]['id'];

interface HealthResponse {
  status: string;
  execution: { liveTradingEnabled: boolean; note: string };
  ai: { configured: boolean; model: string };
}

function currentTab(): TabId {
  const hash = window.location.hash.replace('#/', '');
  return (TABS.find((tab) => tab.id === hash)?.id ?? 'meme') as TabId;
}

export function App() {
  const [tab, setTab] = useState<TabId>(currentTab);
  const health = useApi<HealthResponse>('/api/health', 60_000);

  useEffect(() => {
    const onHashChange = () => setTab(currentTab());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const go = (next: TabId) => {
    window.location.hash = `#/${next}`;
    setTab(next);
  };

  return (
    <div className="flex h-full flex-col bg-term-bg">
      <header className="flex shrink-0 items-center gap-4 border-b border-term-border bg-term-panel px-4 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-bold tracking-tight text-term-text">MemeTrader</span>
          <span className="text-sm font-bold tracking-tight text-term-accent">OS</span>
        </div>

        <nav className="flex flex-1 items-center gap-1">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => go(entry.id)}
              className={`rounded px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider transition ${
                tab === entry.id
                  ? 'bg-term-accent/15 text-term-accent'
                  : 'text-term-muted hover:bg-term-panel-2 hover:text-term-text'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {/*
            The single most important status in the app: this build has no
            execution path at all. It is displayed on every screen.
          */}
          <Badge tone={health.data?.execution.liveTradingEnabled ? 'down' : 'up'} title={health.data?.execution.note}>
            {health.data?.execution.liveTradingEnabled ? 'LIVE TRADING FLAG SET' : 'PAPER ONLY'}
          </Badge>
          <Badge tone={health.data?.ai.configured ? 'info' : 'neutral'}>
            {health.data?.ai.configured ? 'AI ON' : 'AI OFF'}
          </Badge>
          <Badge tone={health.error ? 'down' : health.data ? 'up' : 'neutral'}>
            {health.error ? 'API DOWN' : health.data ? 'API OK' : 'API…'}
          </Badge>
        </div>
      </header>

      {health.error ? (
        <div className="border-b border-term-down/40 bg-term-down/10 px-4 py-1.5 text-[11px] text-term-down">
          {health.error.message}
        </div>
      ) : null}

      <main className="min-h-0 flex-1 overflow-hidden">
        {tab === 'meme' ? <MemeDesk /> : null}
        {tab === 'day' ? <DayTradeDesk /> : null}
        {tab === 'swing' ? <SwingDesk /> : null}
        {tab === 'backtest' ? <BacktestPage /> : null}
        {tab === 'paper' ? <PaperTradePage /> : null}
        {tab === 'journal' ? <JournalPage /> : null}
        {tab === 'performance' ? <PerformancePage /> : null}
        {tab === 'settings' ? <SettingsPage /> : null}
      </main>

      <footer className="shrink-0 border-t border-term-border bg-term-panel px-4 py-1.5 text-[10px] leading-relaxed text-term-dim">
        Analysis and paper trading only. This application does not connect a wallet, sign
        transactions, move funds, or place orders. Scores measure conditions, not probabilities;
        historical statistics describe the past and do not establish future results.
      </footer>
    </div>
  );
}
