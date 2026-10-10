// formtabledialog.mjs — NForm/createForm validation, NTable, dialog API.

import { ref, createApp, h } from './gui/sdk/js/vue.mjs';
import { render } from './gui/sdk/js/reconciler.mjs';
import { NForm, NFormItem, createForm, NInput, NTable, NButton, NOverlayHost, dialog } from './gui/sdk/js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
function findText(node, str) {
  if (!node) return false;
  if (node.nodeType === 3 && node.textContent === str) return true;
  for (const c of node.childNodes || []) if (findText(c, str)) return true;
  return false;
}
const full = () => { const c = document.createElement('view'); c.style.position = 'absolute'; c.style.top = '0'; c.style.left = '0'; c.style.width = '100%'; c.style.height = '100%'; document.body.appendChild(c); return c; };

// ---------- createForm validation ----------
const model = { name: '', age: '', email: 'bad' };
const form = createForm(model, {
  name: { required: true, message: 'Name required' },
  age: { validator: (v) => (Number(v) >= 18 ? true : 'Must be 18+') },
  email: { pattern: /^[^@]+@[^@]+$/, message: 'Bad email' },
});
check('validate() fails when fields are invalid', form.validate() === false);
check('required error is set', form.errors.name === 'Name required');
check('validator error is set', form.errors.age === 'Must be 18+');
check('pattern error is set', form.errors.email === 'Bad email');

model.name = 'Ada'; model.age = '30'; model.email = 'ada@x.io';
check('validate() passes once fields are valid', form.validate() === true);
check('errors cleared after passing', !form.errors.name && !form.errors.age && !form.errors.email);

// ---------- NForm + NFormItem render the error ----------
const model2 = { user: '' };
const form2 = createForm(model2, { user: { required: true, message: 'User is required' } });
let host2;
createApp({ setup() { return () => h('view', { style: { width: '100%', height: '100%' } },
  NForm({}, NFormItem({ label: 'User', form: form2, path: 'user' }, NInput({ value: model2.user, width: 200 })))); } }).mount(full());
host.render();
check('no error text before validation', !findText(document.body, 'User is required'));
form2.validate();
host.flush(); host.render();
check('NFormItem shows the form error after validate()', findText(document.body, 'User is required'));

// ---------- NTable ----------
render(NTable({ columns: [{ title: 'City', key: 'city' }, { title: 'Pop', key: 'pop', align: 'right' }],
  data: [{ city: 'Oslo', pop: '700k' }, { city: 'Lima', pop: '10M' }], striped: true }), full());
host.render();
check('NTable renders a header', findText(document.body, 'City'));
check('NTable renders row 1', findText(document.body, 'Oslo'));
check('NTable renders row 2 with rendered cell', findText(document.body, '10M'));

// ---------- dialog ----------
let posClicked = false;
const c = full();
createApp({ setup() { return () => NOverlayHost(); } }).mount(c);
host.render();
const handle = dialog.warning({ title: 'Delete file?', content: 'This cannot be undone.', positiveText: 'Delete', negativeText: 'Cancel', positiveId: 'dlgOk', onPositiveClick: () => { posClicked = true; } });
host.flush(); host.render();
check('dialog shows its title', findText(document.body, 'Delete file?'));
check('dialog shows its content', findText(document.body, 'This cannot be undone.'));
const ok = document.getElementById('dlgOk');
check('dialog positive button exists', !!ok);
host.click(ok.offsetLeft + Math.floor(ok.offsetWidth / 2), ok.offsetTop + Math.floor(ok.offsetHeight / 2));
host.render();
check('positive handler fired', posClicked === true);
check('dialog closed after positive click', !findText(document.body, 'Delete file?'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
