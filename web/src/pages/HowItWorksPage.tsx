import { Link } from 'react-router';
import { REPO_URL } from '../App';

const FLOW = [
  { title: 'Upload', body: 'A PDF or a phone photo. Stored with its SHA-256 hash.' },
  { title: 'Read', body: 'Azure AI Document Intelligence, prebuilt invoice model: fields, line items, and where each one sits on the page.' },
  { title: 'Code', body: 'Azure OpenAI picks an account and GST code per line, with a confidence and a reason, using the supplier’s past codings.' },
  { title: 'Check', body: 'Plain code checks the sums, GST, ABN checksum, due dates and duplicates.' },
  { title: 'Review', body: 'A person fixes what is flagged and approves. Corrections become history for the next invoice.' },
  { title: 'Post', body: 'An outbox posts the bill to MYOB, retrying safely when MYOB is slow, limited or silent.' },
  { title: 'Reconcile', body: 'Compares what was posted with what MYOB holds now, and lists the differences.' },
];

const DECISIONS = [
  {
    title: 'Reading and judging are separate steps',
    body: 'Document Intelligence is built for layout and numbers; a language model is better at “is this a repair or an asset?”. Splitting them keeps each replaceable. Swapping the coder for Claude is one file.',
  },
  {
    title: 'The AI suggests, a person approves',
    body: 'Every suggestion shows its confidence and a one-line reason. Unsure lines are flagged. When a reviewer changes an account, that coding is fed back as an example for the same supplier next time, so the system learns the business without retraining.',
  },
  {
    title: 'Arithmetic is never left to the model',
    body: 'Totals, GST at 10%, the ABN checksum and duplicate detection run in ordinary, unit-tested code. The model only does the part that needs judgement.',
  },
  {
    title: 'Retries assume the worst',
    body: 'MYOB has no idempotency keys. If a post times out, the bill may already exist, so the next attempt searches MYOB by supplier invoice number before posting again. Rate limits arrive as 403 “Developer Over Qps”, not 429, and are retried with backoff; validation errors are not retried at all.',
  },
  {
    title: 'Reconciliation, because sync drifts anyway',
    body: 'People edit bills in MYOB, enter some by hand, and old scripts double-post. A reconcile screen finds those before the payment run does.',
  },
  {
    title: 'Built to run for cents',
    body: 'Document Intelligence runs on the free tier (500 pages a month), and results are cached by file hash so a re-upload costs nothing. Coding an invoice takes about 1,500 tokens. Uploads are rate limited per visitor and per day, and a budget alert watches the subscription.',
  },
];

const STACK = [
  ['Web app', 'React 19, TypeScript, Tailwind CSS, pdf.js'],
  ['API', 'Hono on Azure Functions (Node), served by Azure Static Web Apps'],
  ['Database', 'Neon Postgres: invoices, an outbox of sync jobs, an audit trail'],
  ['AI', 'Azure AI Document Intelligence (prebuilt invoice) and Azure OpenAI (gpt-5.4-mini, structured outputs)'],
  ['Accounting', 'A simulated MYOB AccountRight API with real request shapes, behind a swappable transport'],
  ['Infrastructure', 'Bicep for every Azure resource, GitHub Actions with OIDC (no stored Azure secrets)'],
  ['Operations', 'CI on every pull request, a scheduled retry worker, Application Insights, a budget alert'],
];

const NEXT = [
  'Real MYOB: OAuth with refresh-token rotation, company file selection, and a sandbox file for tests.',
  'Microsoft Entra ID sign-in and roles, so approvers and preparers are different people.',
  'Files in Blob Storage, and the outbox on a Storage Queue so retries do not depend on a schedule.',
  'Supplier invoices arriving by email (Microsoft 365) instead of upload.',
  'The same posting layer pointed at Business Central.',
];

export function HowItWorksPage() {
  return (
    <article className="max-w-[1100px] space-y-14">
      <header>
        <h1 className="text-[30px] leading-tight font-semibold tracking-[-0.02em]">How it works</h1>
        <p className="mt-3 max-w-[68ch] text-[17px] leading-relaxed text-ink-soft">
          InvoicePilot reads supplier invoices with Azure AI, suggests how to code them, puts them in front of a person, and posts approved bills to
          MYOB. Reading and coding run on real Azure services. MYOB is simulated so you can make it fail on purpose.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link to="/" className="btn btn-primary">
            Try a sample invoice
          </Link>
          <a href={REPO_URL} className="btn btn-quiet">
            Read the code on GitHub
          </a>
        </div>
      </header>

      <section aria-labelledby="flow-h">
        <h2 id="flow-h" className="text-[20px] font-semibold tracking-[-0.01em]">
          From paper to MYOB
        </h2>
        <ol className="mt-5 grid gap-x-6 gap-y-6 border-t-[1.5px] border-ink pt-5 sm:grid-cols-2 lg:grid-cols-4">
          {FLOW.map((s, i) => (
            <li key={s.title} className="grid grid-cols-[1.75rem_1fr]">
              <span className="num pt-px font-semibold text-bottle">{i + 1}</span>
              <div>
                <p className="font-semibold">{s.title}</p>
                <p className="mt-1 text-[14px] leading-snug text-ink-soft">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="decisions-h">
        <h2 id="decisions-h" className="text-[20px] font-semibold tracking-[-0.01em]">
          Decisions worth explaining
        </h2>
        <dl className="mt-5 grid gap-x-10 gap-y-7 md:grid-cols-2">
          {DECISIONS.map((d) => (
            <div key={d.title} className="border-t border-rule pt-4">
              <dt className="font-semibold">{d.title}</dt>
              <dd className="mt-1.5 max-w-[62ch] leading-relaxed text-ink-soft">{d.body}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 max-w-[70ch] text-ink-soft">
          See the retry logic misbehave and recover in the <Link to="/sync#failure-lab" className="underline">failure lab</Link>.
        </p>
      </section>

      <section aria-labelledby="stack-h">
        <h2 id="stack-h" className="text-[20px] font-semibold tracking-[-0.01em]">
          What it runs on
        </h2>
        <table className="ledger mt-4">
          <tbody>
            {STACK.map(([k, v]) => (
              <tr key={k}>
                <th scope="row" className="w-40 border-b! border-rule! align-top font-medium! text-ink!">
                  {k}
                </th>
                <td className="text-ink-soft">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="next-h">
        <h2 id="next-h" className="text-[20px] font-semibold tracking-[-0.01em]">
          What production would add
        </h2>
        <ul className="mt-4 max-w-[70ch] list-disc space-y-2 pl-5 text-ink-soft marker:text-bottle">
          {NEXT.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>
    </article>
  );
}
