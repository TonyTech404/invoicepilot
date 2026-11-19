// Runs the past invoices in web/public/samples/history through the real pipeline
// (Document Intelligence + Azure OpenAI) once, and saves the results as seed fixtures.
// Seeded workspaces then show genuine model output, not hand-written numbers.
//
//   npm run seed:build -w api
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeInvoice, mapInvoice } from '../src/docintel.js';
import { codeLines } from '../src/coding.js';
import { listAccounts } from '../src/invoices.js';
import { db } from '../src/db.js';

const DIR = path.resolve('../web/public/samples/history');
const IDS = ['hgc-24690', 'rbd-00905', 'pw-50177', 'ct-3302', 'rbd-00911'];

const accounts = await listAccounts();
const out: Record<string, unknown> = {};

for (const id of IDS) {
  const bytes = await readFile(path.join(DIR, `${id}.pdf`));
  const t0 = Date.now();
  const result = await analyzeInvoice(bytes);
  const extract_ms = Date.now() - t0;
  const x = mapInvoice(result);
  const coded = await codeLines({
    supplier_name: x.values.supplier_name as string,
    raw_vendor: x.raw_vendor,
    invoice_total: x.values.total as number,
    invoice_tax: x.values.tax as number,
    accounts,
    history: [],
    lines: x.lines.map((l, i) => ({ position: i + 1, ...l })),
  });
  out[id] = { file: `/samples/history/${id}.pdf`, size: bytes.byteLength, extract_ms, extracted: x, coded };
  console.log(id, x.values.invoice_number, x.values.total, coded.lines.map((l) => `${l.account_code}/${l.tax_code}@${l.confidence}`).join(' '));
}

await writeFile('src/seed/history.json', JSON.stringify(out, null, 1) + '\n');
await db().end();
