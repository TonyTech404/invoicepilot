// Generates the fictional supplier invoices used by the demo.
// Every business, ABN, address and phone number here is made up. Phone numbers use the
// 02 5550 xxxx range that ACMA reserves for fiction.
//
//   node scripts/make-samples.mjs
//
// Output: web/public/samples/<id>.pdf|.jpg, <id>.thumb.jpg and samples.json
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('web/public/samples');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const BUYER = {
  name: 'Northbank Coffee Roasters Pty Ltd',
  lines: ['Unit 4, 18 Carrington Road', 'Marrickville NSW 2204'],
  abn: '83 914 571 673',
};

const money = (n) => n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round = (n) => Math.round(n * 100) / 100;

function totals(items) {
  const lines = items.map((i) => ({ ...i, amount: round(i.qty * i.price) }));
  const subtotal = round(lines.reduce((s, l) => s + l.amount, 0));
  const gst = round(lines.filter((l) => l.gst).reduce((s, l) => s + l.amount * 0.1, 0));
  return { lines, subtotal, gst, total: round(subtotal + gst) };
}

// ── The suppliers and their invoices ─────────────────────────────────────────
const samples = [
  {
    id: 'highland-green',
    label: 'Green coffee import',
    note: 'Mixed GST: beans are GST-free, freight is not',
    supplier: {
      name: 'Highland Green Coffee Traders Pty Ltd',
      abn: '58 607 182 954',
      lines: ['Level 2, 77 Bourke Street', 'Alexandria NSW 2015'],
      phone: '(02) 5550 1182',
      email: 'accounts@highlandgreen.example',
    },
    number: 'HGC-24817',
    date: '2026-11-03',
    due: '2026-12-03',
    po: 'PO-1042',
    items: [
      { desc: 'Colombia Huila Excelso EP — 70kg jute bag', qty: 6, unit: 'bag', price: 742.0, gst: false },
      { desc: 'Ethiopia Yirgacheffe Gr.1 Washed — 60kg bag', qty: 4, unit: 'bag', price: 918.5, gst: false },
      { desc: 'Brazil Cerrado Mineiro NY2 17/18 — 60kg bag', qty: 5, unit: 'bag', price: 566.0, gst: false },
      { desc: 'Port Botany warehouse release & delivery', qty: 1, unit: 'ea', price: 285.0, gst: true },
    ],
    template: 'classic',
  },
  {
    id: 'riverbend-dairy',
    label: 'Weekly milk delivery',
    note: 'All GST-free dairy',
    supplier: {
      name: 'Riverbend Dairy Co-operative',
      abn: '88 481 093 375',
      lines: ['14 Mill Road', 'Camden NSW 2570'],
      phone: '(02) 5550 4471',
      email: 'billing@riverbenddairy.example',
    },
    number: 'INV-00918',
    date: '2026-11-10',
    due: '2026-11-24',
    items: [
      { desc: 'Full Cream Milk 2L', qty: 96, unit: 'btl', price: 3.42, gst: false },
      { desc: 'Barista Lite Milk 2L', qty: 36, unit: 'btl', price: 3.38, gst: false },
      { desc: 'Lactose Free Milk 2L', qty: 18, unit: 'btl', price: 4.15, gst: false },
      { desc: 'Thickened Cream 2L', qty: 4, unit: 'btl', price: 12.6, gst: false },
    ],
    template: 'modern',
  },
  {
    id: 'packwell',
    label: 'Coffee bags and labels',
    note: 'Packaging with a setup fee',
    supplier: {
      name: 'Packwell Packaging Pty Ltd',
      abn: '92 152 774 106',
      lines: ['9 Foundry Close', 'Smithfield NSW 2164'],
      phone: '(02) 5550 7320',
      email: 'ar@packwell.example',
    },
    number: '50213',
    date: '2026-11-06',
    due: '2026-12-06',
    po: 'PO-1039',
    items: [
      { desc: '1kg kraft stand-up pouch w/ degassing valve, matte', qty: 2000, unit: 'pc', price: 0.48, gst: true },
      { desc: '250g kraft stand-up pouch w/ valve + zip', qty: 3000, unit: 'pc', price: 0.31, gst: true },
      { desc: 'Printed front labels 90x120mm (roll of 1000)', qty: 5, unit: 'roll', price: 64.0, gst: true },
      { desc: 'Plate setup — new single-origin label', qty: 1, unit: 'ea', price: 150.0, gst: true },
    ],
    template: 'dense',
  },
  {
    id: 'coastline-freight',
    label: 'Pallet freight',
    note: 'ABN on this invoice has a typo',
    supplier: {
      name: 'Coastline Freight & Logistics',
      // Deliberately invalid: fails the ABN checksum.
      abn: '51 824 753 557',
      lines: ['Bay 3, 220 Botany Road', 'Mascot NSW 2020'],
      phone: '(02) 5550 2209',
      email: 'invoices@coastlinefreight.example',
    },
    number: 'CFL-77310',
    date: '2026-11-12',
    due: '2026-11-26',
    items: [
      { desc: 'Pallet transfer Port Botany → Marrickville (2 plt)', qty: 2, unit: 'plt', price: 96.0, gst: true },
      { desc: 'Tailgate delivery surcharge', qty: 1, unit: 'ea', price: 45.0, gst: true },
      { desc: 'Fuel levy 18.5%', qty: 1, unit: 'ea', price: 43.85, gst: true },
    ],
    template: 'letter',
  },
  {
    id: 'crema-tech',
    label: 'Espresso machine repair',
    note: 'Parts and labour, one line is equipment',
    supplier: {
      name: 'Crema Tech Espresso Services',
      abn: '25 329 815 462',
      lines: ['Shop 2, 51 Parramatta Road', 'Annandale NSW 2038'],
      phone: '(02) 5550 6634',
      email: 'service@crematech.example',
    },
    number: 'CT-3391',
    date: '2026-11-14',
    due: '2026-11-28',
    items: [
      { desc: 'Call-out — Bondi café, 3-group machine', qty: 1, unit: 'ea', price: 120.0, gst: true },
      { desc: 'Labour — group head rebuild (hrs)', qty: 2.5, unit: 'hr', price: 110.0, gst: true },
      { desc: 'Group gasket 8.5mm + shower screen kit', qty: 3, unit: 'kit', price: 38.5, gst: true },
      { desc: 'Replacement flat-burr grinder (on-demand, 64mm)', qty: 1, unit: 'ea', price: 1890.0, gst: true },
    ],
    template: 'service',
  },
  {
    id: 'sparkline-receipt',
    label: 'Phone photo of a receipt',
    note: 'A crooked phone photo, not a PDF',
    supplier: {
      name: 'Sparkline Cleaning Supplies',
      abn: '78 516 408 731',
      lines: ['3/12 Euston Road', 'Alexandria NSW 2015'],
      phone: '(02) 5550 3018',
      email: '',
    },
    number: 'R-118204',
    date: '2026-11-15',
    due: '2026-11-15',
    items: [
      { desc: 'Espresso machine cleaning tablets 100pk', qty: 2, unit: '', price: 34.95, gst: true },
      { desc: 'Milk frother cleaner 1L', qty: 3, unit: '', price: 18.5, gst: true },
      { desc: 'Food-safe sanitiser 5L', qty: 1, unit: '', price: 42.0, gst: true },
      { desc: 'Microfibre cloths 10pk', qty: 2, unit: '', price: 12.9, gst: true },
    ],
    template: 'receipt',
    photo: true,
  },
];

// Past invoices, already processed, that seed each visitor's workspace.
const history = [
  { ...samples[0], id: 'hgc-24690', number: 'HGC-24690', date: '2026-10-06', due: '2026-11-05', po: 'PO-1017',
    items: [
      { desc: 'Colombia Huila Excelso EP — 70kg jute bag', qty: 4, unit: 'bag', price: 736.0, gst: false },
      { desc: 'Guatemala Huehuetenango SHB — 69kg bag', qty: 3, unit: 'bag', price: 802.0, gst: false },
      { desc: 'Port Botany warehouse release & delivery', qty: 1, unit: 'ea', price: 285.0, gst: true },
    ] },
  { ...samples[1], id: 'rbd-00905', number: 'INV-00905', date: '2026-11-03', due: '2026-11-17',
    items: [
      { desc: 'Full Cream Milk 2L', qty: 90, unit: 'btl', price: 3.42, gst: false },
      { desc: 'Barista Lite Milk 2L', qty: 30, unit: 'btl', price: 3.38, gst: false },
      { desc: 'Lactose Free Milk 2L', qty: 16, unit: 'btl', price: 4.15, gst: false },
    ] },
  { ...samples[2], id: 'pw-50177', number: '50177', date: '2026-10-09', due: '2026-11-08', po: 'PO-1021',
    items: [
      { desc: '1kg kraft stand-up pouch w/ degassing valve, matte', qty: 1500, unit: 'pc', price: 0.48, gst: true },
      { desc: 'Printed front labels 90x120mm (roll of 1000)', qty: 3, unit: 'roll', price: 64.0, gst: true },
    ] },
  { ...samples[4], id: 'ct-3302', number: 'CT-3302', date: '2026-10-20', due: '2026-11-03',
    notes: 'Boiler element replaced at the Marrickville roastery cafe. Loan grinder supplied for 5 days while the house grinder was in the workshop.',
    items: [
      { desc: 'Call-out — roastery cafe', qty: 1, unit: 'ea', price: 120.0, gst: true },
      { desc: 'Boiler element 2400W', qty: 1, unit: 'ea', price: 186.0, gst: true },
      { desc: 'Labour (hrs)', qty: 1.5, unit: 'hr', price: 110.0, gst: true },
      { desc: 'Loan grinder hire — 5 days', qty: 5, unit: 'day', price: 25.0, gst: true },
    ] },
  { ...samples[1], id: 'rbd-00911', number: 'INV-00911', date: '2026-11-06', due: '2026-11-20',
    items: [
      { desc: 'Full Cream Milk 2L', qty: 48, unit: 'btl', price: 3.42, gst: false },
      { desc: 'Barista Lite Milk 2L', qty: 18, unit: 'btl', price: 3.38, gst: false },
      { desc: 'Thickened Cream 2L', qty: 2, unit: 'btl', price: 12.6, gst: false },
    ] },
];

// ── Templates ────────────────────────────────────────────────────────────────
const fmtDate = (iso, style = 'au') => {
  const d = new Date(iso + 'T00:00:00');
  if (style === 'long') return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  if (style === 'short') return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const base = `
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #1d1d1b; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { width: 210mm; min-height: 297mm; padding: 18mm 18mm 16mm; position: relative; }
  table { border-collapse: collapse; width: 100%; }
  .r { text-align: right; } .muted { color: #6b6b66; }
`;

function classic(s, t) {
  return `<style>${base}
    body { font-family: Georgia, 'Times New Roman', serif; font-size: 10.5pt; }
    .brand { font-size: 22pt; letter-spacing: .02em; color: #2f4a33; }
    .brand small { display:block; font-size: 8.5pt; letter-spacing: .25em; text-transform: uppercase; color:#7a8a6e; font-family: Helvetica, Arial, sans-serif; }
    h1 { font-family: Helvetica, Arial, sans-serif; font-size: 13pt; letter-spacing: .3em; margin: 0; color: #2f4a33; }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 10mm; margin: 10mm 0 8mm; }
    .meta td { padding: 1.5mm 0; } .meta td:first-child { color:#6b6b66; width: 32mm; }
    .items th { text-align:left; border-bottom: 1.5px solid #2f4a33; padding: 2mm 1.5mm; font-family: Helvetica, Arial, sans-serif; font-size: 8.5pt; text-transform: uppercase; letter-spacing:.06em; }
    .items td { padding: 2.6mm 1.5mm; border-bottom: 1px solid #e3e1d8; vertical-align: top; }
    .sum { width: 75mm; margin-left: auto; margin-top: 6mm; } .sum td { padding: 1.6mm 1.5mm; }
    .sum tr.total td { border-top: 1.5px solid #2f4a33; font-weight: bold; font-size: 12pt; }
    .foot { position:absolute; bottom: 16mm; left: 18mm; right: 18mm; font-size: 8.5pt; color:#6b6b66; border-top:1px solid #e3e1d8; padding-top: 3mm; }
  </style>
  <div class="page">
    <div style="display:flex; justify-content:space-between; align-items:flex-start">
      <div class="brand">Highland Green<small>Coffee Traders</small></div>
      <div style="text-align:right"><h1>TAX INVOICE</h1><div class="muted" style="margin-top:2mm">${s.supplier.name}<br>ABN ${s.supplier.abn}</div></div>
    </div>
    <div class="grid">
      <div><div class="muted" style="font-size:8.5pt;text-transform:uppercase;letter-spacing:.1em;font-family:Helvetica">Bill to</div>
        <div style="margin-top:2mm"><b>${BUYER.name}</b><br>${BUYER.lines.join('<br>')}<br>ABN ${BUYER.abn}</div></div>
      <table class="meta"><tr><td>Invoice no.</td><td><b>${s.number}</b></td></tr>
        <tr><td>Invoice date</td><td>${fmtDate(s.date, 'long')}</td></tr>
        <tr><td>Due date</td><td>${fmtDate(s.due, 'long')}</td></tr>
        <tr><td>Your order</td><td>${s.po}</td></tr></table>
    </div>
    <table class="items"><thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">GST</th><th class="r">Amount AUD</th></tr></thead><tbody>
      ${t.lines.map((l) => `<tr><td>${l.desc}</td><td class="r">${l.qty} ${l.unit}</td><td class="r">${money(l.price)}</td><td class="r">${l.gst ? '10%' : 'Free'}</td><td class="r">${money(l.amount)}</td></tr>`).join('')}
    </tbody></table>
    <table class="sum"><tr><td>Subtotal (ex GST)</td><td class="r">${money(t.subtotal)}</td></tr>
      <tr><td>GST</td><td class="r">${money(t.gst)}</td></tr>
      <tr class="total"><td>Total AUD</td><td class="r">$${money(t.total)}</td></tr></table>
    <p class="muted" style="margin-top:10mm; font-size:9pt">Green coffee is GST-free. Title passes on payment. Please quote the invoice number with your payment.</p>
    <div class="foot">${s.supplier.lines.join(', ')} · ${s.supplier.phone} · ${s.supplier.email}<br>Payment by EFT — BSB 012-345 · Account 4471 0920 · Highland Green Coffee Traders</div>
  </div>`;
}

function modern(s, t) {
  return `<style>${base}
    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 10pt; }
    .bar { background: #0e5a8a; color: #fff; padding: 12mm 18mm 9mm; margin: -18mm -18mm 10mm; display:flex; justify-content:space-between; align-items:flex-end; }
    .bar .n { font-size: 20pt; font-weight: 300; } .bar .n b { font-weight: 700; }
    .bar .t { font-size: 26pt; font-weight: 200; letter-spacing: .04em; }
    .cols { display:flex; gap: 12mm; margin-bottom: 9mm; } .cols > div { flex:1 }
    .lbl { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .12em; color: #0e5a8a; font-weight: 700; margin-bottom: 1.5mm; }
    .items th { background:#eef4f8; text-align:left; padding: 2.5mm 2mm; font-size: 8pt; text-transform: uppercase; letter-spacing:.08em; color:#0e5a8a; }
    .items td { padding: 2.4mm 2mm; border-bottom: 1px solid #e6edf2; }
    .box { margin-left:auto; width: 80mm; margin-top: 7mm; background:#eef4f8; padding: 4mm 5mm; }
    .box div { display:flex; justify-content:space-between; padding: 1mm 0; }
    .box .big { font-size: 15pt; font-weight: 700; color:#0e5a8a; border-top: 1px solid #c9dbe7; margin-top: 2mm; padding-top: 3mm; }
  </style>
  <div class="page">
    <div class="bar"><div class="n"><b>Riverbend</b> Dairy</div><div class="t">Tax Invoice</div></div>
    <div class="cols">
      <div><div class="lbl">From</div>${s.supplier.name}<br>${s.supplier.lines.join('<br>')}<br>ABN: ${s.supplier.abn}<br>${s.supplier.phone}</div>
      <div><div class="lbl">Deliver &amp; bill to</div>${BUYER.name}<br>${BUYER.lines.join('<br>')}</div>
      <div><div class="lbl">Details</div>Invoice # ${s.number}<br>Date: ${fmtDate(s.date)}<br>Terms: 14 days<br>Due: ${fmtDate(s.due)}</div>
    </div>
    <table class="items"><thead><tr><th>Product</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Total</th></tr></thead><tbody>
      ${t.lines.map((l) => `<tr><td>${l.desc}</td><td class="r">${l.qty}</td><td class="r">$${money(l.price)}</td><td class="r">$${money(l.amount)}</td></tr>`).join('')}
    </tbody></table>
    <div class="box"><div><span>Subtotal</span><span>$${money(t.subtotal)}</span></div>
      <div><span>GST (all items GST-free)</span><span>$${money(t.gst)}</span></div>
      <div class="big"><span>Amount due</span><span>$${money(t.total)}</span></div></div>
    <p class="muted" style="margin-top:12mm">Thanks for supporting a farmer-owned co-op. Direct debit runs on the due date.</p>
  </div>`;
}

function dense(s, t) {
  return `<style>${base}
    body { font-family: Arial, Helvetica, sans-serif; font-size: 9pt; }
    .head { display:flex; justify-content:space-between; border-bottom: 3px solid #d4572a; padding-bottom: 4mm; }
    .logo { font-weight: 900; font-size: 19pt; letter-spacing: -.02em; } .logo span { color:#d4572a; }
    .kv { display:grid; grid-template-columns: 26mm 1fr; row-gap: 1mm; }
    .boxes { display:grid; grid-template-columns: 1fr 1fr; gap: 5mm; margin: 6mm 0; }
    .boxes > div { border: 1px solid #bbb; padding: 3mm; min-height: 24mm; }
    .boxes h3 { margin: 0 0 2mm; font-size: 7.5pt; text-transform: uppercase; color: #777; }
    .items th { background:#333; color:#fff; padding: 2mm; text-align:left; font-size: 8pt; }
    .items td { padding: 1.8mm 2mm; border-bottom: 1px solid #ddd; }
    .items tr:nth-child(even) td { background:#f6f6f6; }
    .sum td { padding: 1.4mm 2mm; } .sum { width: 70mm; margin: 5mm 0 0 auto; border:1px solid #bbb }
    .sum tr:last-child td { background:#333; color:#fff; font-weight:bold; }
  </style>
  <div class="page">
    <div class="head"><div><div class="logo">pack<span>well</span></div><div class="muted">${s.supplier.name} · ABN ${s.supplier.abn}<br>${s.supplier.lines.join(', ')} · ${s.supplier.phone}</div></div>
      <div style="text-align:right"><div style="font-size:15pt;font-weight:bold">TAX INVOICE</div>
      <div class="kv" style="margin-top:2mm;text-align:left"><span class="muted">Invoice</span><b>${s.number}</b><span class="muted">Date</span><span>${fmtDate(s.date, 'short')}</span><span class="muted">Cust. PO</span><span>${s.po}</span><span class="muted">Account</span><span>NORTHB01</span></div></div></div>
    <div class="boxes"><div><h3>Invoice to</h3>${BUYER.name}<br>${BUYER.lines.join('<br>')}</div><div><h3>Ship to</h3>${BUYER.name} — Roastery<br>${BUYER.lines.join('<br>')}</div></div>
    <table class="items"><thead><tr><th>Item</th><th>Description</th><th class="r">Qty</th><th class="r">Unit ex GST</th><th class="r">Ext ex GST</th></tr></thead><tbody>
      ${t.lines.map((l, i) => `<tr><td>PW-${4100 + i * 7}</td><td>${l.desc}</td><td class="r">${l.qty.toLocaleString('en-AU')}</td><td class="r">${l.price.toFixed(l.price < 1 ? 3 : 2)}</td><td class="r">${money(l.amount)}</td></tr>`).join('')}
    </tbody></table>
    <table class="sum"><tr><td>Total ex GST</td><td class="r">${money(t.subtotal)}</td></tr><tr><td>GST 10%</td><td class="r">${money(t.gst)}</td></tr><tr><td>Total inc GST</td><td class="r">${money(t.total)}</td></tr></table>
    <p class="muted" style="margin-top:8mm">Terms: 30 days from invoice date (due ${fmtDate(s.due, 'short')}). Goods remain property of Packwell until paid in full.</p>
  </div>`;
}

function letter(s, t) {
  return `<style>${base}
    body { font-family: 'Courier New', Courier, monospace; font-size: 10pt; }
    .page { padding: 22mm 22mm; }
    h1 { font-size: 15pt; margin: 0 0 1mm; letter-spacing: .05em; }
    hr { border: 0; border-top: 1px dashed #777; margin: 6mm 0; }
    .items td, .items th { padding: 1.8mm 1mm; } .items th { text-align:left; border-bottom: 1px dashed #777; }
    .stamp { position:absolute; right: 26mm; top: 70mm; transform: rotate(-12deg); border: 3px solid #b3261e; color:#b3261e; padding: 2mm 5mm; font: bold 15pt Arial, sans-serif; opacity: .75; letter-spacing:.08em }
  </style>
  <div class="page">
    <h1>COASTLINE FREIGHT &amp; LOGISTICS</h1>
    <div>${s.supplier.lines.join(' · ')}<br>Ph ${s.supplier.phone} · ${s.supplier.email}<br>A.B.N. ${s.supplier.abn}</div>
    <div class="stamp">TAX INVOICE</div>
    <hr>
    <div>Invoice No: ${s.number}<br>Date: ${fmtDate(s.date)}<br>Payment due: ${fmtDate(s.due)}<br>Consignment: CN 88-412-907</div>
    <hr>
    <div>Charge to:<br>${BUYER.name.toUpperCase()}<br>${BUYER.lines.join('<br>').toUpperCase()}</div>
    <hr>
    <table class="items"><thead><tr><th>Service</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>
      ${t.lines.map((l) => `<tr><td>${l.desc}</td><td class="r">${l.qty}</td><td class="r">${money(l.price)}</td><td class="r">${money(l.amount)}</td></tr>`).join('')}
    </tbody></table>
    <hr>
    <table style="width:80mm;margin-left:auto"><tr><td>Sub-total</td><td class="r">${money(t.subtotal)}</td></tr><tr><td>GST</td><td class="r">${money(t.gst)}</td></tr><tr><td><b>TOTAL</b></td><td class="r"><b>${money(t.total)}</b></td></tr></table>
    <hr>
    <div class="muted">All goods carried at owner's risk unless insured. 7 day account terms apply.</div>
  </div>`;
}

function service(s, t) {
  return `<style>${base}
    body { font-family: 'Avenir Next', 'Segoe UI', Helvetica, sans-serif; font-size: 10pt; }
    .top { display:grid; grid-template-columns: 1.2fr 1fr; gap: 10mm; }
    .logo { font-size: 24pt; font-weight: 800; color: #6b3e26; } .logo i { font-weight: 300; font-style: normal; color:#b98b5e }
    .card { border-radius: 3mm; background: #f7f1ea; padding: 5mm; }
    .card div { display:flex; justify-content:space-between; padding: .8mm 0; }
    .job { margin: 8mm 0 5mm; padding: 4mm 5mm; border-left: 3px solid #b98b5e; background:#fcfaf7; }
    .items th { text-align:left; font-size: 8pt; color:#6b3e26; text-transform: uppercase; letter-spacing: .1em; padding: 2mm; border-bottom: 2px solid #6b3e26; }
    .items td { padding: 2.6mm 2mm; border-bottom: 1px solid #eadfd3; }
    .sum { width: 78mm; margin: 6mm 0 0 auto; } .sum td { padding: 1.5mm 2mm; } .sum tr:last-child td { font-size: 13pt; font-weight: 800; color:#6b3e26; border-top: 2px solid #6b3e26; }
  </style>
  <div class="page">
    <div class="top"><div><div class="logo">Crema<i>Tech</i></div><div class="muted">Espresso Services<br>${s.supplier.lines.join('<br>')}<br>${s.supplier.phone} · ${s.supplier.email}<br>ABN ${s.supplier.abn}</div></div>
      <div class="card"><b style="font-size:13pt;color:#6b3e26">Tax Invoice</b>
        <div><span class="muted">Number</span><span>${s.number}</span></div>
        <div><span class="muted">Issued</span><span>${fmtDate(s.date, 'short')}</span></div>
        <div><span class="muted">Due</span><span>${fmtDate(s.due, 'short')}</span></div>
        <div><span class="muted">Customer</span><span>Northbank Coffee</span></div></div></div>
    <div class="job"><b>Job notes:</b> ${s.notes ?? 'Group 2 leaking at gasket, low flow on group 3. Rebuilt both groups, replaced screens. Grinder at Bondi site failed (motor) — supplied and installed replacement unit as approved by phone.'}</div>
    <div class="muted" style="margin-bottom:2mm">Bill to: ${BUYER.name}, ${BUYER.lines.join(', ')}</div>
    <table class="items"><thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>
      ${t.lines.map((l) => `<tr><td>${l.desc}</td><td class="r">${l.qty}</td><td class="r">${money(l.price)}</td><td class="r">${money(l.amount)}</td></tr>`).join('')}
    </tbody></table>
    <table class="sum"><tr><td>Subtotal</td><td class="r">${money(t.subtotal)}</td></tr><tr><td>GST</td><td class="r">${money(t.gst)}</td></tr><tr><td>Total</td><td class="r">$${money(t.total)}</td></tr></table>
  </div>`;
}

function receipt(s, t) {
  return `<style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Courier New', monospace; font-size: 13px; color: #222; }
    .r { text-align: right; }
    .slip { width: 330px; padding: 22px 20px 30px; background: #fbfaf6; }
    .c { text-align: center; } hr { border: 0; border-top: 1px dashed #555; margin: 10px 0; }
    td { padding: 2px 0; vertical-align: top; } table { width: 100%; border-collapse: collapse; }
  </style>
  <div class="slip">
    <div class="c"><b style="font-size:17px">SPARKLINE</b><br>CLEANING SUPPLIES<br>${s.supplier.lines.join('<br>')}<br>${s.supplier.phone}<br>ABN ${s.supplier.abn}</div>
    <hr><div class="c"><b>TAX INVOICE</b></div>
    <div>No: ${s.number}<br>${fmtDate(s.date)} 10:42 &nbsp; Reg 2</div>
    <div>Cust: NORTHBANK COFFEE</div><hr>
    <table>${t.lines.map((l) => `<tr><td colspan=2>${l.desc}</td></tr><tr><td>&nbsp; ${l.qty} @ ${money(l.price)}</td><td class="r">${money(l.amount)}</td></tr>`).join('')}</table>
    <hr><table><tr><td>SUBTOTAL</td><td class="r">${money(t.subtotal)}</td></tr><tr><td>GST INCL. ABOVE? NO</td><td></td></tr><tr><td>GST 10%</td><td class="r">${money(t.gst)}</td></tr>
    <tr><td><b>TOTAL</b></td><td class="r"><b>${money(t.total)}</b></td></tr><tr><td>EFTPOS</td><td class="r">${money(t.total)}</td></tr></table>
    <hr><div class="c">Thank you!<br>Returns within 14 days with receipt</div>
  </div>`;
}

const TEMPLATES = { classic, modern, dense, letter, service, receipt };

// ── Render ───────────────────────────────────────────────────────────────────
await mkdir(OUT, { recursive: true });
if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_PATH`);
const browser = await chromium.launch({ executablePath: CHROME });
const manifest = [];

for (const s of [...samples, ...history.map((h) => ({ ...h, history: true }))]) {
  const t = totals(s.items);
  const dir = s.history ? path.join(OUT, 'history') : OUT;
  await mkdir(dir, { recursive: true });
  const html = `<!doctype html><meta charset="utf-8">${TEMPLATES[s.template](s, t)}`;
  const page = await browser.newPage({ deviceScaleFactor: 2 });

  if (s.photo) {
    // Render the slip, then photograph it: rotated on a desk with uneven light.
    await page.setContent(html);
    const slip = await page.locator('.slip').screenshot({ type: 'png' });
    const src = `data:image/png;base64,${slip.toString('base64')}`;
    await page.setViewportSize({ width: 900, height: 1200 });
    await page.setContent(`<!doctype html><body style="margin:0;width:900px;height:1200px;overflow:hidden;
      background: radial-gradient(ellipse at 30% 20%, #8a6a4f 0%, #5e432f 55%, #3d2b1f 100%);">
      <div style="position:absolute;inset:0;background:repeating-linear-gradient(92deg, rgba(0,0,0,.05) 0 3px, transparent 3px 11px)"></div>
      <img src="${src}" style="position:absolute;left:180px;top:60px;width:560px;transform:perspective(1400px) rotateX(9deg) rotateZ(-4deg);
        box-shadow: 18px 26px 40px rgba(0,0,0,.45); filter: brightness(.97) contrast(1.04)">
      <div style="position:absolute;inset:0;background:linear-gradient(115deg, rgba(255,255,255,.18), transparent 40%, rgba(0,0,0,.18))"></div>
      </body>`);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, `${s.id}.jpg`), type: 'jpeg', quality: 82 });
    await page.setViewportSize({ width: 900, height: 1200 });
    await page.screenshot({ path: path.join(OUT, `${s.id}.thumb.jpg`), type: 'jpeg', quality: 70, scale: 'css', clip: { x: 0, y: 0, width: 900, height: 1200 } });
  } else {
    await page.setViewportSize({ width: 794, height: 1123 });
    await page.setContent(html);
    await page.pdf({ path: path.join(dir, `${s.id}.pdf`), format: 'A4', printBackground: true });
    if (!s.history) await page.screenshot({ path: path.join(OUT, `${s.id}.thumb.jpg`), type: 'jpeg', quality: 70, scale: 'css' });
  }
  await page.close();
  if (s.history) {
    console.log(`history/${s.id.padEnd(12)} total ${money(t.total)}`);
    continue;
  }

  manifest.push({
    id: s.id,
    label: s.label,
    note: s.note,
    supplier: s.supplier.name,
    file: `${s.id}.${s.photo ? 'jpg' : 'pdf'}`,
    mime: s.photo ? 'image/jpeg' : 'application/pdf',
    thumb: `${s.id}.thumb.jpg`,
    total: t.total,
  });
  console.log(`${s.id.padEnd(20)} ${t.lines.length} lines  total ${money(t.total)}`);
}

await browser.close();
await writeFile(path.join(OUT, 'samples.json'), JSON.stringify(manifest, null, 2) + '\n');
