// naive3.mjs — Select dropdown, Tooltip (portal layer), and form validation.

import { ref, createApp, h } from './gui/sdk/js/vue.mjs';
import { render } from './gui/sdk/js/reconciler.mjs';
import {
  NSelect, NTooltip, NOverlayHost, NFormItem, NInput,
  validateField, validateForm, theme,
} from './gui/sdk/js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }

// --- form validation (pure) ---
check('required catches an empty value', validateField('', [{ required: true }]) !== null);
check('required passes a non-empty value', validateField('x', [{ required: true }]) === null);
check('min length rule', validateField('ab', [{ min: 3, message: 'too short' }]) === 'too short');
check('pattern rule', validateField('nope', [{ pattern: /^\d+$/, message: 'digits only' }]) === 'digits only');
check('custom validator rule', validateField('5', [{ validator: v => (+v > 3 ? null : 'too small') }]) === null);
const errs = validateForm({ name: '', age: '200' }, { name: [{ required: true }], age: [{ pattern: /^\d{1,2}$/, message: 'bad age' }] });
check('validateForm collects field errors', errs.name && errs.age === 'bad age');
check('validateForm is empty when valid', Object.keys(validateForm({ name: 'ok' }, { name: [{ required: true }] })).length === 0);

// --- NSelect dropdown via the portal layer ---
// (Mount first so the app root — and thus the overlay origin — is at (0,0).)
const App = {
  setup() {
    const val = ref(null);
    return () => h('view', { style: { width: '100%', height: '100%' } },
      h('view', { style: { padding: '20' } },
        NSelect({ id: 'sel', value: val.value, onUpdate: v => val.value = v, width: 200,
          options: [{ value: 'a', label: 'Apple' }, { value: 'b', label: 'Banana' }] })),
      NOverlayHost());   // direct child of the unpadded root -> origin (0,0)
  },
};
createApp(App).mount(document.body);
document.body.style.width = '100%'; document.body.style.height = '100%';
host.render();
const sel = document.getElementById('sel');
check('select shows the placeholder', sel.textContent.indexOf('Select') >= 0);

host.click(sel.offsetLeft + 20, sel.offsetTop + 17);   // open the dropdown
check('dropdown opens with options', document.body.textContent.indexOf('Apple') >= 0 && document.body.textContent.indexOf('Banana') >= 0);

// click the first option (Apple): popup at (sel.left, sel.bottom+4), 4px pad, 32px rows
const L = sel.offsetLeft, B = sel.offsetTop + sel.offsetHeight;
host.click(L + 100, B + 4 + 4 + 16);
check('selecting an option updates the value', document.getElementById('sel').textContent.indexOf('Apple') >= 0);
check('dropdown closes after selection', document.body.textContent.indexOf('Banana') < 0);

// --- NTooltip shows on hover via the portal layer ---
const App2 = {
  setup() {
    return () => h('view', { style: { width: '100%', height: '100%' } },
      h('view', { style: { padding: '60' } },
        NTooltip({ content: 'Helpful hint', placement: 'bottom' },
          h('view', { id: 'trig', style: { width: '120', height: '32', backgroundColor: '#eeeeee' } }, 'hover me'))),
      NOverlayHost());
  },
};
const c2 = document.createElement('view'); c2.style.position = 'absolute'; c2.style.width = '100%'; c2.style.height = '100%';
document.body.appendChild(c2);
createApp(App2).mount(c2);
host.render();
check('tooltip is hidden initially', document.body.textContent.indexOf('Helpful hint') < 0);
const trig = document.getElementById('trig');
host.mouse('mousemove', trig.offsetLeft + 20, trig.offsetTop + 16);   // hover -> mouseenter
check('tooltip appears on hover', document.body.textContent.indexOf('Helpful hint') >= 0);
host.mouse('mousemove', 5, 5);                                        // leave
check('tooltip disappears on mouse leave', document.body.textContent.indexOf('Helpful hint') < 0);

// --- NFormItem renders an error (no overlay; safe to append now) ---
const fc = document.createElement('view'); fc.style.padding = '10';
document.body.appendChild(fc);
render(NFormItem({ label: 'Name', error: 'This field is required', required: true, errorId: 'err' },
  NInput({ value: '', placeholder: 'name' })), fc);
host.render();
check('NFormItem shows the error message', document.getElementById('err').textContent === 'This field is required');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
