// naive7.mjs — Wave 1: Divider, Typography, Empty, Result, Statistic, List,
// Descriptions, Breadcrumb, Timeline, Grid, Flex, ButtonGroup.

import { h } from './js/vue.mjs';
import { render } from './js/reconciler.mjs';
import {
  NDivider, NText, NTitle, NEmpty, NResult, NStatistic, NList, NListItem,
  NDescriptions, NBreadcrumb, NTimeline, NGrid, NFlex, NButtonGroup, NButton,
} from './js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const box = () => { const c = document.createElement('view'); c.style.padding = '12'; document.body.appendChild(c); return c; };
const T = (id) => document.getElementById(id).textContent;

render(NDivider({ id: 'dv' }, 'Section'), box());
host.render();
check('divider with title', T('dv') === 'Section');

render(h('view', { id: 'typo' }, NText({ strong: true }, 'Hello'), NTitle({ level: 2 }, 'Heading')), box());
host.render();
check('typography text + title', T('typo').indexOf('Hello') >= 0 && T('typo').indexOf('Heading') >= 0);

render(NEmpty({ id: 'emp', description: 'Nothing here' }), box());
host.render();
check('empty shows description', T('emp').indexOf('Nothing here') >= 0);

render(NResult({ id: 'res', status: 'success', title: 'Submitted', description: 'All good' }), box());
host.render();
check('result shows title + description + icon', T('res').indexOf('Submitted') >= 0 && T('res').indexOf('All good') >= 0 && T('res').indexOf('✓') >= 0);

render(NStatistic({ id: 'stat', label: 'Users', value: 1234, suffix: 'k' }), box());
host.render();
check('statistic shows label + value + suffix', T('stat').indexOf('Users') >= 0 && T('stat').indexOf('1234') >= 0 && T('stat').indexOf('k') >= 0);

render(NList({ id: 'list' }, NListItem({}, h('view', {}, 'Apple')), NListItem({}, h('view', {}, 'Banana'))), box());
host.render();
check('list renders items', T('list').indexOf('Apple') >= 0 && T('list').indexOf('Banana') >= 0);

render(NDescriptions({ id: 'desc', items: [{ label: 'Name', value: 'Polly' }, { label: 'Version', value: 1 }] }), box());
host.render();
check('descriptions render label/value pairs', ['Name', 'Polly', 'Version', '1'].every(s => T('desc').indexOf(s) >= 0));

render(NBreadcrumb({ id: 'bc', items: [{ label: 'Home' }, { label: 'Docs' }, { label: 'API' }] }), box());
host.render();
check('breadcrumb renders items + separators', T('bc').indexOf('Home') >= 0 && T('bc').indexOf('API') >= 0 && T('bc').indexOf('/') >= 0);

render(NTimeline({ id: 'tl', items: [{ title: 'Created' }, { title: 'Shipped' }] }), box());
host.render();
check('timeline renders item titles', T('tl').indexOf('Created') >= 0 && T('tl').indexOf('Shipped') >= 0);

// Grid: two span-12 cells each ~50% of a 240px container
render(h('view', { style: { width: '240' } }, NGrid({ cols: 24, items: [{ span: 12, content: h('view', { id: 'g1', style: { height: '10' } }) }, { span: 12, content: h('view', { id: 'g2', style: { height: '10' } }) }] })), box());
host.render();
check('grid splits into half-width cells', Math.abs(document.getElementById('g1').offsetWidth - 120) <= 2);

// Flex: gap between children
render(NFlex({ gap: 8 }, h('view', { id: 'f1', style: { width: '30', height: '10' } }), h('view', { id: 'f2', style: { width: '30', height: '10' } })), box());
host.render();
check('flex applies the gap', document.getElementById('f2').offsetLeft - document.getElementById('f1').offsetLeft === 38);

render(NButtonGroup({ id: 'bg' }, NButton({ type: 'primary' }, 'Save'), NButton({}, 'Cancel')), box());
host.render();
check('button group renders its buttons', T('bg').indexOf('Save') >= 0 && T('bg').indexOf('Cancel') >= 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
