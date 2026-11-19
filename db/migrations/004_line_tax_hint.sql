-- What the document itself said about a line's tax ("Free", "10%"), passed to the AI coder.
alter table invoice_lines add column tax_hint text;
