// input_demo.mjs — text inputs with caret + selection.
//   Windowed:  pollyui js/input_demo.mjs
//   Snapshot:  pollyui --test js/input_demo.mjs  (build/win-clang/input.png)

import { createTextInput } from './js/textinput.mjs';

const make = (s, p) => {
  const n = document.createElement('view');
  if (s) for (const k in s) n.style[k] = s[k];
  if (p) p.appendChild(n);
  return n;
};
const text = (str, s, p) => { const n = make(s, p); n.appendChild(document.createTextNode(str)); return n; };

document.body.style.backgroundColor = '#f1f5f9';
document.body.style.padding = '40';
document.body.style.gap = '18';
text('Text input — caret, click-to-position, drag-to-select', { color: '#0f172a', fontSize: '20', fontWeight: 'bold' }, document.body);

const a = createTextInput({ value: 'Click to place the caret', width: 360, fontSize: 18 });
document.body.appendChild(a.root);

const b = createTextInput({ value: 'Drag to select this text', width: 360, fontSize: 18 });
document.body.appendChild(b.root);

// Show a live selection in the second field for the snapshot.
b.selectAll();

if (typeof host !== 'undefined') {
  host.render();
  host.save('build/win-clang/input.png');
  console.log('wrote build/win-clang/input.png');
}
