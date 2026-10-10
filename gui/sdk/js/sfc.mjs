// sfc.mjs — a minimal Vue Single-File-Component compiler for PollyUI.
//
//   import { compileSFC } from './gui/sdk/js/sfc.mjs';
//   const Counter = compileSFC(`
//     <template>
//       <view class="box">
//         <text>Count: {{ count }}</text>
//         <button type="primary" @click="inc">+1</button>
//         <view v-if="count > 4"><text>high!</text></view>
//         <view v-for="(n, i) in items"><text>{{ i }}: {{ n }}</text></view>
//       </view>
//     </template>
//     <script>
//       export default {
//         props: ['start'],
//         setup(props) {
//           const count = ref(props.start || 0);
//           const items = ['a', 'b', 'c'];
//           const inc = () => count.value++;
//           return { count, items, inc };
//         }
//       }
//     </script>
//   `);
//   createApp(Counter).mount(document.body);
//
// Supports: element tags (resolved via the tag registry, so <button>, <card>… map
// to components), text interpolation `{{ }}`, `:prop` / `v-bind`, `@evt` / `v-on`,
// `v-if`, and `v-for="(item, i) in list"`. Refs returned from setup auto-unwrap in
// the template. <style> is parsed but applied verbatim (scoping is future work).

import * as Vue from './gui/sdk/js/vue.mjs';
import { h } from './gui/sdk/js/reconciler.mjs';

// ---- block extraction -------------------------------------------------------
function section(src, tag) {
  const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(src);
  return m ? m[1] : null;
}

// ---- tiny template parser ---------------------------------------------------
function parseTemplate(html) {
  let i = 0;
  // find the closing '>' of a tag starting at `from`, skipping quoted attr values
  // (so a '>' inside an expression like v-if="a > b" doesn't end the tag early).
  function tagEnd(from) {
    let j = from, q = 0;
    while (j < html.length) {
      const ch = html[j];
      if (q) { if (ch === q) q = 0; }
      else if (ch === '"' || ch === "'") q = ch;
      else if (ch === '>') return j;
      j++;
    }
    return html.length;
  }
  function nodes() {
    const out = [];
    while (i < html.length) {
      if (html[i] === '<') {
        if (html.slice(i, i + 2) === '</') { i = html.indexOf('>', i) + 1; return out; }
        if (html.slice(i, i + 4) === '<!--') { i = html.indexOf('-->', i) + 3; continue; }
        const end = tagEnd(i + 1);
        let raw = html.slice(i + 1, end);
        i = end + 1;
        const selfClose = raw.endsWith('/');
        if (selfClose) raw = raw.slice(0, -1);
        const sp = raw.search(/\s/);
        const tag = sp < 0 ? raw : raw.slice(0, sp);
        const node = { tag, attrs: parseAttrs(sp < 0 ? '' : raw.slice(sp)), children: [] };
        if (!selfClose) node.children = nodes();
        out.push(node);
      } else {
        let j = html.indexOf('<', i); if (j < 0) j = html.length;
        const text = html.slice(i, j);
        if (text.trim()) out.push({ text });
        i = j;
      }
    }
    return out;
  }
  return nodes();
}

function parseAttrs(str) {
  const attrs = [];
  const re = /([@:#.\w-]+)(?:\s*=\s*"([^"]*)")?/g;
  let m;
  while ((m = re.exec(str))) if (m[1].trim()) attrs.push({ name: m[1], value: m[2] });
  return attrs;
}

// ---- codegen ----------------------------------------------------------------
const isRef = (e) => /^[A-Za-z_$][\w$.]*$/.test(e.trim()); // bare identifier/member ref

function genText(text) {
  const parts = [];
  const re = /\{\{([\s\S]+?)\}\}/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(JSON.stringify(text.slice(last, m.index)));
    parts.push('(' + m[1].trim() + ')');
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(JSON.stringify(text.slice(last)));
  // concatenate static + interpolated runs into a single text node (Vue-style),
  // so `Hello {{ name }}` is one child, not two.
  return parts.length ? '(' + parts.join(' + ') + ')' : '""';
}

function genElement(node) {
  let vif = null, vfor = null;
  const styleEntries = [], props = [];
  for (const a of node.attrs) {
    const n = a.name, v = a.value == null ? '' : a.value;
    if (n === 'v-if') vif = v;
    else if (n === 'v-for') vfor = v;
    else if (n === 'class') props.push('"class": ' + JSON.stringify(v));
    else if (n.startsWith(':') || n.startsWith('v-bind:')) {
      const key = n.replace(/^:|^v-bind:/, '');
      if (key === 'style') props.push('style: (' + v + ')');
      else props.push(JSON.stringify(key) + ': (' + v + ')');
    } else if (n.startsWith('@') || n.startsWith('v-on:')) {
      const ev = n.replace(/^@|^v-on:/, '');
      const on = 'on' + ev[0].toUpperCase() + ev.slice(1);
      const handler = isRef(v) ? v : '($event) => { ' + v + ' }';
      props.push(JSON.stringify(on) + ': (' + handler + ')');
    } else {
      props.push(JSON.stringify(n) + ': ' + JSON.stringify(a.value == null ? true : v));
    }
  }
  const propStr = '{' + props.join(', ') + '}';
  const kids = node.children.map(gen).filter(Boolean);
  let expr = 'h(' + JSON.stringify(node.tag) + ', ' + propStr + (kids.length ? ', ' + kids.join(', ') : '') + ')';
  if (vif) expr = '((' + vif + ') ? ' + expr + ' : null)';
  if (vfor) {
    const fm = /^\s*\(?\s*([\w$]+)(?:\s*,\s*([\w$]+))?\s*\)?\s+(?:in|of)\s+([\s\S]+)$/.exec(vfor);
    const item = fm[1], idx = fm[2] || '$i', list = fm[3];
    expr = '(' + list + ').map((' + item + ', ' + idx + ') => ' + expr + ')';
  }
  return expr;
}

function gen(node) {
  if (node.text !== undefined) return genText(node.text);
  if (node.tag === 'slot') return '($slots || [])'; // <slot/> -> the passed children
  return genElement(node);
}

function compileTemplate(tpl) {
  const roots = parseTemplate(tpl).filter((n) => n.tag || (n.text && n.text.trim()));
  if (roots.length === 1) return gen(roots[0]);
  return "h('view', {}, " + roots.map(gen).join(', ') + ')'; // implicit fragment wrapper
}

// ---- assemble ---------------------------------------------------------------
function compile(src) {
  const tpl = section(src, 'template') || '';
  const scriptSrc = (section(src, 'script') || 'export default {}').replace(/export\s+default/, 'return');
  const rootExpr = compileTemplate(tpl);
  const depNames = Object.keys(Vue);
  const opts = new Function(...depNames, scriptSrc)(...depNames.map((k) => Vue[k])) || {};
  const renderFn = new Function('h', 'ctx', 'with (ctx) { return ' + rootExpr + '; }');
  return { opts, renderFn };
}

function makeScope(props, bindings, children) {
  const scope = {};
  const merge = (obj) => { for (const k in obj) {
    const v = obj[k];
    if (v && v.__v_isRef) Object.defineProperty(scope, k, { get: () => v.value, set: (x) => { v.value = x; }, enumerable: true });
    else scope[k] = v;
  } };
  merge(props || {}); merge(bindings);
  scope.$slots = children || [];
  return scope;
}

// Stateful component (setup runs once) — for createApp roots / app-level views.
export function compileSFC(src) {
  const { opts, renderFn } = compile(src);
  return {
    props: opts.props,
    setup(props) {
      const bindings = opts.setup ? (opts.setup(props) || {}) : {};
      return () => renderFn(h, makeScope(props, bindings));
    },
  };
}

// Stateless tag component (props in, vnode out; <slot/> = passed children) — for
// reusable controls registered via defineTag. State lifts to the app, matching
// PollyUI's call-time tag resolution.
export function compileSFCTag(src) {
  const { opts, renderFn } = compile(src);
  const fn = (props, ...children) => {
    const bindings = opts.setup ? (opts.setup(props || {}) || {}) : {};
    const vnode = renderFn(h, makeScope(props || {}, bindings, children));
    // attribute fallthrough: id/class on the tag apply to the root element (Vue-style)
    if (vnode && vnode.props && props) {
      if (props.id != null && vnode.props.id == null) vnode.props.id = props.id;
      if (props.class != null && vnode.props.class == null) vnode.props.class = props.class;
    }
    return vnode;
  };
  fn.props = opts.props;
  return fn;
}
