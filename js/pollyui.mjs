// pollyui.mjs — the canonical PollyUI entry point.
//
// Re-exports the framework (reactivity + reconciler) and every Naive UI-style
// component, AND registers each component as a custom element *tag* so you can
// author with element names instead of function calls:
//
//   import { createApp, h } from './js/pollyui.mjs';
//   createApp({ setup: () => () =>
//     h('view', { style: { gap: '12', padding: '20' } },
//       h('button', { type: 'primary', onClick: save }, 'Save'),
//       h('badge', { value: 8 }, h('button', {}, 'Inbox')),
//       h('dropdown', { options, onSelect }, h('button', {}, 'Menu')))
//   }).mount(document.body);
//
// Tag names are the component names minus the `N` prefix, kebab-cased:
//   NButton -> 'button'   NButtonGroup -> 'button-group'   NDatePicker -> 'date-picker'
// Components are still exported by their function names too (NButton, ...), so
// the two styles interoperate freely.

import { defineTags } from './js/reconciler.mjs';
import * as N from './js/naive.mjs';

// framework: reactivity + h/render (vue re-exports the reconciler's h)
export * from './js/vue.mjs';
export { render, mount, defineTag, defineTags, tagNames } from './js/reconciler.mjs';
// every component + the message/notification/dialog/loadingBar/theme APIs
export * from './js/naive.mjs';

// NButtonGroup -> button-group, NDatePicker -> date-picker, NInputNumber -> input-number
const kebab = (s) => s.replace(/^N/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

const tags = {};
for (const name in N) {
  if (/^N[A-Z]/.test(name) && typeof N[name] === 'function') tags[kebab(name)] = N[name];
}
defineTags(tags);

// the registered tag names, e.g. ['alert','auto-complete','avatar','badge','button',...]
export const componentTags = Object.keys(tags).sort();
