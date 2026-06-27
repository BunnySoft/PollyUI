// app_demo.mjs — a small app: reconciler + CSS stylesheet + state.
//   Windowed:  pollyui js/app_demo.mjs
//   Snapshot:  pollyui --test js/app_demo.mjs  (build/win-clang/app.png)

import { h, mount } from './js/reconciler.mjs';
import { css } from './js/css.mjs';

document.body.style.backgroundColor = '#0f172a';
document.body.style.padding = '32';
document.body.style.alignItems = 'center';

const Counter = (state, setState) =>
  h('view', { className: 'card' },
    h('view', { className: 'title' }, 'Reconciler + CSS'),
    h('view', { className: 'count' }, String(state.count)),
    h('view', { className: 'row' },
      h('view', { className: 'btn minus', onClick: () => setState({ count: state.count - 1 }) }, '−'),
      h('view', { className: 'btn plus',  onClick: () => setState({ count: state.count + 1 }) }, '+')));

const app = mount(Counter, document.body, { count: 3 });

css(`
  .card  { width: 320px; background-color: #1e293b; border-radius: 16px; padding: 24px; gap: 16px;
           align-items: center; shadow-color: #00000066; shadow-blur: 30px; shadow-y: 10px; }
  .title { color: #94a3b8; font-size: 18px; font-weight: bold; }
  .count { color: #f8fafc; font-size: 64px; font-weight: bold; height: 78px; }
  .row   { flex-direction: row; gap: 16px; }
  .btn   { width: 96px; height: 56px; border-radius: 12px; align-items: center; justify-content: center;
           color: #f8fafc; font-size: 28px; font-weight: bold; }
  .plus  { background-color: #22c55e; }
  .minus { background-color: #ef4444; }
`);

// Re-style after every state change (the reconciler rebuilds the subtree).
const restyle = () => css(`
  .card{width:320px;background-color:#1e293b;border-radius:16px;padding:24px;gap:16px;align-items:center;shadow-color:#00000066;shadow-blur:30px;shadow-y:10px;}
  .title{color:#94a3b8;font-size:18px;font-weight:bold;}
  .count{color:#f8fafc;font-size:64px;font-weight:bold;height:78px;}
  .row{flex-direction:row;gap:16px;}
  .btn{width:96px;height:56px;border-radius:12px;align-items:center;justify-content:center;color:#f8fafc;font-size:28px;font-weight:bold;}
  .plus{background-color:#22c55e;}.minus{background-color:#ef4444;}`);

if (typeof host !== 'undefined') {
  // simulate two clicks on "+" then snapshot
  host.render();
  const plus = document.querySelector('.plus');
  host.click(plus.offsetLeft + 10, plus.offsetTop + 10); restyle();
  host.click(plus.offsetLeft + 10, plus.offsetTop + 10); restyle();
  host.render();
  host.save('build/win-clang/app.png');
  console.log('count after two + clicks:', app.state.count);
}
