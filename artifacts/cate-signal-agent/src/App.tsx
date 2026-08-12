import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { Activity, ArrowUpRight, Check, ChevronDown, CircleHelp, Clock3, Copy, Database, ExternalLink, FileText, LockKeyhole, Menu, Radio, RefreshCw, ShieldCheck, X } from 'lucide-react';

const queryClient = new QueryClient();

const signalSteps = [
  { label: 'Pair identity', value: 'CATE / SOL', detail: 'Monitored market' },
  { label: 'Cadence', value: 'Every 3 hours', detail: 'Scheduled checker' },
  { label: 'Persistence', value: 'signals.db', detail: 'Local signal log' },
];

function BrandMark({ small = false }: { small?: boolean }) {
  return <div className={`relative flex items-center justify-center ${small ? 'h-8 w-8 rounded-lg' : 'h-11 w-11 rounded-[11px]'} bg-[#d9f26a] text-[#1a292c] shadow-[0_0_0_1px_rgba(217,242,106,.4)]`}><Radio size={small ? 16 : 21} strokeWidth={2.5} /><span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[#c36d42]" /></div>;
}

function AppShell() {
  const [location] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const isDocs = location === '/documentation';
  const copyPair = () => {
    void navigator.clipboard?.writeText('CATE / SOL');
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  return <div className="noise min-h-[100dvh] bg-background text-foreground">
    <header className="relative z-20 border-b border-border/80 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-[72px] max-w-[1240px] items-center justify-between px-5 sm:px-8">
        <a href="/" className="flex items-center gap-3" data-testid="link-brand">
          <BrandMark small />
          <div><div className="font-display text-[15px] font-bold tracking-[-.02em]">CATE Signal Agent</div><div className="font-mono text-[9px] uppercase tracking-[.18em] text-muted-foreground">Solana monitor / v1</div></div>
        </a>
        <nav className="hidden items-center gap-7 md:flex" aria-label="Primary navigation">
          <a href="/" className={`font-mono text-[11px] uppercase tracking-[.16em] transition-colors hover:text-accent-foreground ${!isDocs ? 'text-foreground' : 'text-muted-foreground'}`} data-testid="link-overview">Overview</a>
          <a href="/documentation" className={`font-mono text-[11px] uppercase tracking-[.16em] transition-colors hover:text-accent-foreground ${isDocs ? 'text-foreground' : 'text-muted-foreground'}`} data-testid="link-documentation">Documentation</a>
        </nav>
        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-2 rounded-full border border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.14em] text-muted-foreground sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-[#9ab73e] animate-pulse-signal" />Scheduled</span>
          <button onClick={() => setMenuOpen(!menuOpen)} className="rounded-md p-2 hover:bg-muted md:hidden" aria-label="Open navigation" data-testid="button-mobile-menu"><Menu size={18} /></button>
        </div>
      </div>
      {menuOpen && <div className="border-t border-border bg-background px-5 py-4 md:hidden"><div className="flex flex-col gap-4 font-mono text-[11px] uppercase tracking-[.15em]"><a href="/" onClick={() => setMenuOpen(false)} data-testid="link-mobile-overview">Overview</a><a href="/documentation" onClick={() => setMenuOpen(false)} data-testid="link-mobile-documentation">Documentation</a></div></div>}
    </header>
    <main className="mx-auto max-w-[1240px] px-5 pb-16 pt-10 sm:px-8 sm:pt-16">
      {isDocs ? <Documentation /> : <Overview copied={copied} onCopy={copyPair} />}
    </main>
    <footer className="mx-auto flex max-w-[1240px] flex-col gap-3 border-t border-border px-5 py-6 font-mono text-[10px] uppercase tracking-[.13em] text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8"><span>Built for signal clarity, not signal noise.</span><span className="flex items-center gap-2"><LockKeyhole size={12} /> No wallet connection required</span></footer>
  </div>;
}

function Overview({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  const [showContext, setShowContext] = useState(true);
  return <div className="animate-rise-in">
    <section className="signal-grid relative overflow-hidden rounded-2xl border border-border bg-[#ece9dd] px-6 py-12 dark:bg-[#172629] sm:px-12 sm:py-16">
      <div className="absolute -right-20 -top-28 h-72 w-72 rounded-full border border-[#c7c6a9]/60 sm:h-96 sm:w-96" /><div className="absolute -right-8 -top-16 h-56 w-56 rounded-full border border-[#c7c6a9]/40 sm:h-72 sm:w-72" />
      <div className="relative max-w-[760px]">
        <div className="mb-7 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[.2em] text-[#61706a] dark:text-[#b7c2ab]"><span className="h-px w-7 bg-[#c36d42]" /> Signal surface / 001</div>
        <h1 className="max-w-3xl font-display text-[clamp(2.8rem,7vw,6.5rem)] font-bold leading-[.94] tracking-[-.075em] text-[#1a292c] dark:text-[#eae9d9]">A quiet eye on<br /><span className="text-[#788e32]">CATE / SOL.</span></h1>
        <p className="mt-7 max-w-[530px] text-base leading-7 text-[#50605c] dark:text-[#b7c2ab] sm:text-lg">A scheduled Solana signal checker that watches one configured pair, verifies its context, and leaves an honest trail behind.</p>
        <div className="mt-10 flex flex-wrap items-center gap-3"><a href="#latest-signal" className="group flex items-center gap-3 rounded-md bg-[#1a292c] px-4 py-3 font-mono text-[11px] uppercase tracking-[.14em] text-[#ece9dd] transition-transform hover:-translate-y-0.5 dark:bg-[#d9f26a] dark:text-[#1a292c]" data-testid="link-latest-signal">View latest signal <ArrowUpRight size={15} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" /></a><a href="/documentation" className="flex items-center gap-2 rounded-md border border-[#b7b9a3] px-4 py-3 font-mono text-[11px] uppercase tracking-[.14em] text-[#50605c] transition-colors hover:bg-[#dfe0cf] dark:text-[#d8ddc7]" data-testid="link-read-documentation">How it runs <FileText size={14} /></a></div>
      </div>
      <div className="relative mt-12 flex max-w-[560px] items-center gap-2 sm:absolute sm:bottom-9 sm:right-10 sm:mt-0"><div className="h-px w-full bg-[#b7b9a3]" /><span className="font-mono text-[9px] uppercase tracking-[.18em] text-[#74817a]">Observed / verified / logged</span></div>
    </section>

    <section className="grid gap-6 py-10 md:grid-cols-[1.18fr_.82fr] md:py-14">
      <div id="latest-signal" className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-sm)] sm:p-8">
        <div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.17em] text-muted-foreground"><span className="h-2 w-2 rounded-full bg-[#9ab73e]" /> Latest verified context</div><h2 className="mt-3 font-display text-2xl font-bold tracking-[-.04em]">No signal asserted.</h2></div><span className="rounded-sm bg-muted px-2 py-1 font-mono text-[9px] uppercase tracking-[.14em] text-muted-foreground">Awaiting run</span></div>
        <div className="mt-8 grid gap-5 border-y border-border py-5 sm:grid-cols-2"><div><p className="font-mono text-[10px] uppercase tracking-[.15em] text-muted-foreground">Last verified run</p><p className="mt-2 font-display text-xl font-semibold text-foreground">Not available</p></div><div><p className="font-mono text-[10px] uppercase tracking-[.15em] text-muted-foreground">Signal record</p><p className="mt-2 font-mono text-sm text-foreground">No published event</p></div></div>
        <div className="mt-6 rounded-lg bg-muted/70 p-4"><div className="flex gap-3"><ShieldCheck className="mt-0.5 shrink-0 text-[#788e32]" size={17} /><p className="text-sm leading-6 text-muted-foreground">The checker is configured and ready. This surface will only show verified output after a scheduled run writes it to the local signal log.</p></div></div>
        <button onClick={() => setShowContext(!showContext)} className="mt-5 flex w-full items-center justify-between border-t border-border pt-4 text-left font-mono text-[10px] uppercase tracking-[.15em] text-muted-foreground hover:text-foreground" data-testid="button-toggle-context"><span>What counts as verified?</span><ChevronDown size={15} className={`transition-transform ${showContext ? 'rotate-180' : ''}`} /></button>
        {showContext && <p className="mt-3 max-w-xl text-xs leading-5 text-muted-foreground">A run must resolve the configured pair, complete its check, and append a record to <span className="font-mono text-foreground">signals.db</span>. Until then, there is intentionally no price, direction, or trading claim to display.</p>}
      </div>
      <div className="flex flex-col gap-6">
        <div className="rounded-xl border border-border bg-[#1a292c] p-6 text-[#ece9dd] shadow-[var(--shadow-md)] sm:p-8"><div className="flex items-center justify-between"><div className="font-mono text-[10px] uppercase tracking-[.17em] text-[#b7c2ab]">Configured pair</div><button onClick={onCopy} className="rounded p-1.5 text-[#b7c2ab] transition-colors hover:bg-[#294045] hover:text-[#d9f26a]" aria-label="Copy configured pair" data-testid="button-copy-pair">{copied ? <Check size={15} /> : <Copy size={15} />}</button></div><button onClick={onCopy} className="mt-4 text-left font-display text-4xl font-bold tracking-[-.06em] text-[#d9f26a] hover:text-[#efffaa]" data-testid="button-pair-value">CATE <span className="text-[#71817e]">/</span> SOL</button><div className="mt-5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.14em] text-[#b7c2ab]"><span className="h-1.5 w-1.5 rounded-full bg-[#d9f26a] animate-pulse-signal" /> Pair identity confirmed</div></div>
        <div className="grid grid-cols-2 gap-6 rounded-xl border border-border bg-card p-6"><div><Clock3 size={18} className="text-[#c36d42]" /><p className="mt-4 font-display text-xl font-bold tracking-[-.04em]">03:00</p><p className="mt-1 font-mono text-[9px] uppercase tracking-[.14em] text-muted-foreground">Run interval</p></div><div><Database size={18} className="text-[#c36d42]" /><p className="mt-4 font-display text-xl font-bold tracking-[-.04em]">SQLite</p><p className="mt-1 font-mono text-[9px] uppercase tracking-[.14em] text-muted-foreground">Signal storage</p></div></div>
      </div>
    </section>
    <section className="border-t border-border py-10 sm:py-14"><div className="mb-8 flex items-end justify-between gap-4"><div><div className="font-mono text-[10px] uppercase tracking-[.17em] text-muted-foreground">System contract</div><h2 className="mt-2 font-display text-2xl font-bold tracking-[-.04em]">Small surface. Clear promises.</h2></div><span className="hidden font-mono text-[10px] uppercase tracking-[.14em] text-muted-foreground sm:block">01 — 03</span></div><div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-3">{signalSteps.map((step, index) => <div key={step.label} className="bg-card p-6 transition-colors hover:bg-muted/60 sm:p-7" data-testid={`card-contract-${index}`}><div className="flex items-center justify-between"><span className="font-mono text-[10px] text-muted-foreground">0{index + 1}</span><Check size={16} className="text-[#788e32]" /></div><p className="mt-9 font-mono text-[10px] uppercase tracking-[.15em] text-muted-foreground">{step.label}</p><p className="mt-2 font-display text-xl font-bold tracking-[-.04em]">{step.value}</p><p className="mt-1 text-xs text-muted-foreground">{step.detail}</p></div>)}</div></section>
    <section className="rounded-xl border border-[#d8b38d]/60 bg-[#f0dfc7] p-6 dark:bg-[#342d26] sm:flex sm:items-center sm:justify-between sm:p-8"><div className="flex gap-4"><CircleHelp className="mt-0.5 shrink-0 text-[#b65e38]" size={20} /><div><h3 className="font-display text-lg font-bold tracking-[-.03em]">Designed to be honest.</h3><p className="mt-1 max-w-2xl text-sm leading-6 text-[#705849] dark:text-[#dbc6af]">This companion surface presents configuration and verified context. It does not predict markets, connect wallets, or turn an absent run into a made-up signal.</p></div></div><a href="/documentation" className="mt-5 inline-flex shrink-0 items-center gap-2 font-mono text-[10px] uppercase tracking-[.15em] text-[#9b4e30] hover:underline sm:mt-0" data-testid="link-scope-documentation">Read the scope <ArrowUpRight size={14} /></a></section>
  </div>;
}

function Documentation() {
  return <div className="animate-rise-in">
    <div className="mb-10 max-w-2xl"><div className="mb-5 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[.2em] text-muted-foreground"><span className="h-px w-7 bg-[#c36d42]" /> Documentation / 002</div><h1 className="font-display text-[clamp(2.7rem,6vw,5.5rem)] font-bold leading-[.95] tracking-[-.07em]">How the signal<br /><span className="text-[#788e32]">stays grounded.</span></h1><p className="mt-6 max-w-lg text-base leading-7 text-muted-foreground">The companion surface is intentionally narrow: it makes the scheduled job legible without pretending to be a trading terminal.</p></div>
    <div className="grid gap-6 md:grid-cols-[1fr_1fr]">
      <article className="rounded-xl border border-border bg-card p-6 sm:p-8"><div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-[#788e32]"><Activity size={19} /></div><h2 className="mt-6 font-display text-xl font-bold tracking-[-.04em]">The scheduled loop</h2><ol className="mt-6 space-y-5">{['A scheduled run starts every three hours.', 'The checker resolves the configured CATE / SOL pair.', 'Verified context is appended to signals.db.', 'This surface reflects only records that exist.'].map((item, i) => <li key={item} className="flex gap-4"><span className="font-mono text-[10px] text-[#c36d42]">0{i + 1}</span><span className="text-sm leading-6 text-muted-foreground">{item}</span></li>)}</ol></article>
      <article className="rounded-xl border border-border bg-card p-6 sm:p-8"><div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-[#c36d42]"><ShieldCheck size={19} /></div><h2 className="mt-6 font-display text-xl font-bold tracking-[-.04em]">What this surface does not do</h2><ul className="mt-6 space-y-4 text-sm leading-6 text-muted-foreground"><li className="flex gap-3"><X size={16} className="mt-1 shrink-0 text-[#c36d42]" />It does not present live market data.</li><li className="flex gap-3"><X size={16} className="mt-1 shrink-0 text-[#c36d42]" />It does not provide trade execution or wallet actions.</li><li className="flex gap-3"><X size={16} className="mt-1 shrink-0 text-[#c36d42]" />It does not infer a signal when the log is empty.</li></ul></article>
    </div>
    <div className="mt-6 rounded-xl border border-border bg-[#1a292c] p-6 text-[#ece9dd] sm:p-8"><div className="flex flex-wrap items-center justify-between gap-4"><div><p className="font-mono text-[10px] uppercase tracking-[.17em] text-[#b7c2ab]">Operational reference</p><p className="mt-2 font-display text-2xl font-bold tracking-[-.04em] text-[#d9f26a]">CATE / SOL <span className="text-[#71817e]">·</span> signals.db</p></div><span className="rounded-full border border-[#48605c] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.14em] text-[#b7c2ab]">Every 3 hours</span></div><div className="mt-8 h-px bg-[#334b4b]" /><div className="mt-5 flex flex-wrap gap-x-8 gap-y-3 font-mono text-[10px] uppercase tracking-[.14em] text-[#b7c2ab]"><span className="flex items-center gap-2"><LockKeyhole size={13} /> Read-only companion</span><span className="flex items-center gap-2"><Database size={13} /> Local persistence</span><span className="flex items-center gap-2"><RefreshCw size={13} /> Scheduled refresh</span></div></div>
    <div className="mt-8 flex flex-wrap gap-4"><a href="/" className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-3 font-mono text-[10px] uppercase tracking-[.15em] hover:bg-muted" data-testid="link-back-overview">Back to overview <ArrowUpRight size={14} /></a><a href="https://solana.com" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-4 py-3 font-mono text-[10px] uppercase tracking-[.15em] text-muted-foreground hover:text-foreground" data-testid="link-solana-reference">Solana reference <ExternalLink size={13} /></a></div>
  </div>;
}

function Router() {
  return <ErrorBoundary><Switch><Route path="/" component={AppShell} /><Route path="/documentation" component={AppShell} /><Route component={NotFound} /></Switch></ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;