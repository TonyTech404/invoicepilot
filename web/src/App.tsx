import { useState } from 'react';
import { NavLink, Outlet, Link, useNavigate } from 'react-router';
import { SessionProvider, useSession } from './session';

export const REPO_URL = 'https://github.com/TonyTech404/invoicepilot';

const MODE_LABEL = { healthy: 'Healthy', flaky: 'Flaky', lost_responses: 'Dropping responses' } as const;

function Header() {
  const { session } = useSession();
  const nav = [
    { to: '/', label: 'Invoices', end: true },
    { to: '/sync', label: 'MYOB sync' },
    { to: '/reconcile', label: 'Reconcile' },
    { to: '/how-it-works', label: 'How it works' },
  ];
  return (
    <header className="border-b border-rule bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80 sticky top-0 z-20">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-8 gap-y-2 px-4 py-3 sm:px-6">
        <Link to="/" className="flex items-baseline gap-2.5">
          <span className="text-[19px] font-bold tracking-[-0.02em] text-bottle">InvoicePilot</span>
          <span className="hidden text-[13px] text-ink-faint md:inline">for Northbank Coffee Roasters, a sample company</span>
        </Link>
        <nav className="order-3 -mx-1 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto" aria-label="Main">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 text-[15px] whitespace-nowrap ${isActive ? 'bg-bottle-wash font-medium text-bottle' : 'text-ink-soft hover:text-ink'}`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        {session && (
          <Link
            to="/sync#failure-lab"
            className="ml-auto flex items-center gap-2 rounded-md border border-rule px-2.5 py-1 text-[13px] text-ink-soft hover:border-ink-faint"
            title="Change how the simulated MYOB behaves"
          >
            <span
              className={`size-2 rounded-full ${session.myob_mode === 'healthy' ? 'bg-bottle' : session.myob_mode === 'flaky' ? 'bg-amber' : 'bg-red-ink'}`}
              aria-hidden
            />
            MYOB: {MODE_LABEL[session.myob_mode]}
          </Link>
        )}
      </div>
    </header>
  );
}

function Footer() {
  const { reset } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <footer className="mt-20 border-t border-rule">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-4 py-6 text-[13px] text-ink-faint sm:flex-row sm:items-center sm:px-6">
        <p className="max-w-[70ch]">
          A working demo by Anthony Hernandez. Document reading and account coding run on real Azure AI services. MYOB is
          simulated, and every supplier is made up.{' '}
          <a className="underline hover:text-ink" href={REPO_URL}>
            Source on GitHub
          </a>
          .
        </p>
        <button
          className="btn btn-quiet h-8 px-3 text-[13px] sm:ml-auto"
          disabled={busy}
          onClick={async () => {
            if (!confirm('Start over with fresh sample data? Your uploads in this session will be removed.')) return;
            setBusy(true);
            await reset();
            setBusy(false);
            navigate('/');
          }}
        >
          {busy ? 'Resetting…' : 'Reset demo'}
        </button>
      </div>
    </footer>
  );
}

/** Pages wait for the session so a first visit creates exactly one workspace. */
function Pages() {
  const { session, version } = useSession();
  if (!session) {
    return (
      <div className="py-24 text-center text-ink-soft" role="status">
        Setting up your copy of the sample company…
      </div>
    );
  }
  return <Outlet key={version} />;
}

export function Layout() {
  return (
    <SessionProvider>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-30 focus:rounded focus:bg-sheet focus:px-3 focus:py-2">
        Skip to content
      </a>
      <Header />
      <main id="main" className="mx-auto max-w-[1400px] px-4 pt-8 sm:px-6">
        <Pages />
      </main>
      <Footer />
    </SessionProvider>
  );
}
