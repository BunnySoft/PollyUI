import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(path.join(repo, 'docs/SKU-MATRIX.md'), 'utf8');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const inline = value => escape(value)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\(([A-Za-z0-9_.-]+\.(?:md|html))\)/g, '<a href="$2">$1</a>');
const cells = line => line.trim().slice(1, -1).split('|').map(value => value.trim());

export function mergedRows(rows, shared = false) {
  const result = [];
  for (const input of rows) {
    const row = input.map(value => shared && value === 'Same implementation' ? input[1] : value);
    const output = [];
    for (let column = 0; column < row.length;) {
      const value = row[column];
      let colspan = 1;
      if (column > 0) while (column + colspan < row.length && row[column + colspan] === value) colspan++;
      output.push({ value, column, colspan });
      column += colspan;
    }
    result.push(output);
  }
  return result;
}

function renderTable(header, rows) {
  if (rows.some(row => row.length !== header.length)) throw new Error('Invalid SKU matrix column count');
  const skuMatrix = ['Feature', 'Component'].includes(header[0]) &&
    header.slice(1).every(value => ['Mini', 'Compact', 'Standard'].includes(value));
  const merged = skuMatrix ? mergedRows(rows, header[0] === 'Component') :
    rows.map(row => row.map((value, column) => ({ value, column, colspan: 1 })));
  const body = merged.map(row => '<tr>' + row.map(cell => {
    const tag = cell.column === 0 ? 'th' : 'td';
    const style = cell.value === '✅' ? 'yes' : cell.value.startsWith('❌') ? 'no' :
      cell.value === '❔' || cell.value.includes('TBD') ? 'tbd' : '';
    return `<${tag}${cell.column === 0 ? ' scope="row"' : ''} class="${style}"` +
      (cell.colspan > 1 ? ` colspan="${cell.colspan}"` : '') +
      `>${inline(cell.value)}</${tag}>`;
  }).join('') + '</tr>').join('\n');
  return '<div class="table-scroll"><table><thead><tr>' +
    header.map(value => '<th scope="col">' + inline(value) + '</th>').join('') +
    '</tr></thead><tbody>' + body + '</tbody></table></div>';
}

export function renderMatrix(markdown) {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n'), blocks = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index].trim();
    if (!line) { index++; continue; }
    const heading = /^(#{1,2}) (.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length, id = heading[2].replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      blocks.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`);
      index++; continue;
    }
    if (line.startsWith('|')) {
      const header = cells(lines[index++]);
      if (!/^\|(?:\s*:?-+:?\s*\|)+$/.test(lines[index++].trim()))
        throw new Error('Missing SKU table separator');
      const rows = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) rows.push(cells(lines[index++]));
      blocks.push(renderTable(header, rows)); continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^(?:#|\|)/.test(lines[index]))
      paragraph.push(lines[index++].trim());
    blocks.push('<p>' + inline(paragraph.join(' ')) + '</p>');
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PollyOS SKU / Feature / Component Matrix</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; color: #23354e; background: #f4f7fb; font: 15px/1.6 system-ui, sans-serif; }
nav { position: sticky; top: 0; z-index: 2; padding: 12px 28px; background: #fff; border-bottom: 1px solid #dbe4ef; }
nav strong { margin-right: 24px; } nav a { margin-right: 18px; }
main { max-width: 1500px; margin: auto; padding: 24px 28px 60px; }
h1 { font-size: 30px; margin: 0 0 14px; } h2 { margin-top: 36px; scroll-margin-top: 90px; }
p { max-width: 1100px; } a { color: #2467a5; } code { overflow-wrap: anywhere; font-size: 0.9em; }
.table-scroll { overflow-x: auto; margin: 20px 0; border: 1px solid #dbe4ef; border-radius: 10px; }
table { border-collapse: collapse; width: 100%; min-width: 850px; background: white; font-size: 14px; }
th, td { padding: 12px 16px; border: 1px solid #dbe4ef; vertical-align: middle; }
thead th { color: #fff; background: #243c5a; text-align: left; }
tbody th { text-align: left; min-width: 180px; background: #f2f6fc; font-weight: 600; }
td { text-align: center; min-width: 135px; }
td[colspan] { background: #edf3fb; }
.yes { background: #ebf7ef !important; font-size: 19px; }
.no { background: #fff1f0 !important; } .tbd { background: #fff8e7 !important; }
@media print { nav { display: none; } main { padding: 0; } .table-scroll { overflow: visible; } table { min-width: 0; } }
</style>
</head>
<body>
<nav><strong>PollyOS SKU Matrix</strong><a href="#1-feature-targets">Features</a><a href="#2-component-selection">Components</a><a href="#3-current-mini-delivery-status">Delivery</a><a href="SKU-MATRIX.md">Markdown source</a></nav>
<main>
<!-- Generated from SKU-MATRIX.md. Edit the Markdown source and run node desktop/tools/render-sku-matrix.mjs. -->
${blocks.join('\n')}
</main>
</body>
</html>
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  writeFileSync(path.join(repo, 'docs/SKU-MATRIX.html'), renderMatrix(source));
