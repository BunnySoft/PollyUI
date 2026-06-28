// naive8.mjs — Wave 2: InputNumber, Rate, DynamicTags, DynamicInput,
// AvatarGroup, Time, Ellipsis, Thing, Image.

import { h } from './js/vue.mjs';
import { render } from './js/reconciler.mjs';
import {
  NInputNumber, NRate, NDynamicTags, NDynamicInput, NAvatarGroup, NAvatar,
  NTime, NEllipsis, NThing, NImage,
} from './js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const box = () => { const c = document.createElement('view'); c.style.padding = '12'; document.body.appendChild(c); return c; };

// InputNumber
const c1 = box(); let num = 5;
const rnum = () => render(NInputNumber({ id: 'inum', value: num, min: 0, max: 10, onUpdate: v => { num = v; rnum(); host.render(); } }), c1);
rnum(); host.render();
let inum = document.getElementById('inum');
host.click(inum.lastChild.offsetLeft + 15, inum.lastChild.offsetTop + 15);
check('input-number increments', num === 6);
inum = document.getElementById('inum');
host.click(inum.firstChild.offsetLeft + 15, inum.firstChild.offsetTop + 15);
host.click(document.getElementById('inum').firstChild.offsetLeft + 15, inum.firstChild.offsetTop + 15);
check('input-number decrements', num === 4);

// Rate
const c2 = box(); let rate = 0;
const rrate = () => render(NRate({ id: 'rate', value: rate, count: 5, onUpdate: v => { rate = v; rrate(); host.render(); } }), c2);
rrate(); host.render();
const rt = document.getElementById('rate');
host.click(rt.childNodes[2].offsetLeft + 10, rt.childNodes[2].offsetTop + 10);
check('rate sets value on click', rate === 3);
check('rate fills stars', document.getElementById('rate').textContent.indexOf('★') >= 0);

// DynamicTags
const c3 = box(); let tags = ['red', 'green'];
const rtags = () => render(NDynamicTags({ id: 'tags', value: tags, onChange: v => { tags = v; rtags(); host.render(); }, onAdd: () => { tags = tags.concat('new'); rtags(); host.render(); } }), c3);
rtags(); host.render();
check('dynamic tags render', document.getElementById('tags').textContent.indexOf('red') >= 0);
let tg = document.getElementById('tags');
host.click(tg.lastChild.offsetLeft + 20, tg.lastChild.offsetTop + 12);
check('dynamic tags add', tags.length === 3 && tags[2] === 'new');
tg = document.getElementById('tags');
host.click(tg.firstChild.lastChild.offsetLeft + 4, tg.firstChild.lastChild.offsetTop + 6);
check('dynamic tags remove', tags.indexOf('red') < 0);

// DynamicInput
const c4 = box(); let dinp = ['a'];
const rdin = () => render(NDynamicInput({ id: 'din', value: dinp, onChange: v => { dinp = v; rdin(); host.render(); } }), c4);
rdin(); host.render();
let din = document.getElementById('din');
host.click(din.lastChild.offsetLeft + 30, din.lastChild.offsetTop + 16);
check('dynamic input adds a row', dinp.length === 2);
din = document.getElementById('din');
const input0 = din.firstChild.firstChild;
host.click(input0.offsetLeft + 20, input0.offsetTop + 16);
host.key('X');
check('dynamic input edits a row', dinp[0] === 'aX');

// AvatarGroup
const c5 = box();
render(NAvatarGroup({ size: 32, max: 2 }, NAvatar({ color: '#ff0000' }, 'A'), NAvatar({ color: '#00ff00' }, 'B'), NAvatar({ color: '#0000ff' }, 'C')), c5);
host.render();
check('avatar group shows +N overflow', c5.textContent.indexOf('+1') >= 0);

// Time
const c6 = box();
render(NTime({ id: 'tm', time: new Date(2024, 1, 5, 14, 30), type: 'date' }), c6);
host.render();
check('time formats a date', document.getElementById('tm').textContent === '2024-02-05');

// Ellipsis
const c7 = box();
render(NEllipsis({ id: 'ell', width: 80 }, 'This is a very long piece of text that should truncate'), c7);
host.render();
const ell = document.getElementById('ell');
check('ellipsis truncates with an ellipsis', ell.textContent.indexOf('…') >= 0 && ell.textContent.length < 50);

// Thing
const c8 = box();
render(NThing({ id: 'thing', title: 'Card title', description: 'A description' }), c8);
host.render();
check('thing renders title + description', document.getElementById('thing').textContent.indexOf('Card title') >= 0 && document.getElementById('thing').textContent.indexOf('A description') >= 0);

// Image
const c9 = box();
render(NImage({ id: 'img', width: 100, height: 80 }), c9);
host.render();
check('image renders at its size', document.getElementById('img').offsetWidth === 100 && document.getElementById('img').offsetHeight === 80);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
