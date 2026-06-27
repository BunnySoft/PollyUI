// css.mjs — a small CSS stylesheet + selector engine over the DOM.
//
//   import { css } from './js/css.mjs';
//   css(`
//     .card { background-color: #1e293b; border-radius: 12px; padding: 16px; }
//     .card .title { color: #22d3ee; font-size: 18px; font-weight: bold; }
//     #hero { background-color: #6366f1; }
//   `);
//
// Supports: tag / .class / #id / * , compound (`div.card#x`), descendant
// combinator (`.a .b`), selector groups (`a, b`), and specificity-ordered
// cascade. CSS kebab-case props are mapped to the renderer's camelCase keys.

const kebabToCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function parseCompound(s) {
  const comp = { tag: null, id: null, classes: [] };
  const re = /([.#]?)([a-zA-Z0-9_-]+|\*)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] === '.') comp.classes.push(m[2]);
    else if (m[1] === '#') comp.id = m[2];
    else comp.tag = (m[2] === '*') ? null : m[2];
  }
  return comp;
}

function parseSelector(sel) {
  const compounds = sel.trim().split(/\s+/).filter(Boolean).map(parseCompound);
  let id = 0, cls = 0, tag = 0;
  for (const c of compounds) { if (c.id) id++; cls += c.classes.length; if (c.tag) tag++; }
  return { compounds, specificity: id * 10000 + cls * 100 + tag };
}

function matchCompound(el, comp) {
  if (!el || el.nodeType !== 1) return false;
  if (comp.tag && el.tagName !== comp.tag) return false;
  if (comp.id && el.id !== comp.id) return false;
  for (const c of comp.classes) if (!el.classList.contains(c)) return false;
  return true;
}

// Rightmost compound matches `el`; preceding compounds match ancestors (in
// order, but not necessarily adjacent — the descendant combinator).
function matchSelector(el, compounds) {
  let i = compounds.length - 1;
  if (!matchCompound(el, compounds[i])) return false;
  i--;
  let anc = el.parentNode;
  while (i >= 0 && anc) {
    if (matchCompound(anc, compounds[i])) i--;
    anc = anc.parentNode;
  }
  return i < 0;
}

export function parseCSS(text) {
  const rules = [];
  text = text.replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m, order = 0;
  while ((m = re.exec(text))) {
    const decls = {};
    for (const d of m[2].split(';')) {
      const idx = d.indexOf(':');
      if (idx < 0) continue;
      const prop = d.slice(0, idx).trim();
      const val = d.slice(idx + 1).trim();
      if (prop) decls[kebabToCamel(prop)] = val;
    }
    for (const sel of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
      const p = parseSelector(sel);
      rules.push({ compounds: p.compounds, specificity: p.specificity, declarations: decls, order: order++ });
    }
  }
  return rules;
}

function collectElements(el, out) {
  if (el.nodeType === 1) out.push(el);
  for (let c = el.firstChild; c; c = c.nextSibling) collectElements(c, out);
}

// Apply a stylesheet to `root` and its descendants. Returns the rule count.
export function applyStylesheet(root, cssText) {
  const rules = parseCSS(cssText);
  const els = [];
  collectElements(root, els);
  for (const el of els) {
    const matched = rules.filter(r => matchSelector(el, r.compounds));
    matched.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
    for (const rule of matched)
      for (const prop in rule.declarations)
        el.style[prop] = rule.declarations[prop];
  }
  return rules.length;
}

// Apply to the whole document.
export const css = (text) => applyStylesheet(document.body, text);
