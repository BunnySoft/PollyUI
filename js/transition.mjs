// transition.mjs — a Vue-style <Transition> for enter/leave animation of a
// conditionally-rendered element. Wraps a SINGLE element child and injects the
// reconciler's onMount / onLeave lifecycle hooks (see reconciler.mjs):
//
//   import './js/transition.mjs';        // registers the <transition> tag
//   h('transition', { duration: 200 }, show.value && h('view', { ... }, 'Panel'))
//
// On mount the child starts at the `enter` style and animates to its natural
// style; on removal it animates to the `leave` style, and the actual DOM
// detach is deferred until that finishes. Defaults: fade + 8px slide-up.
//
// NOTE: the child must be a plain element vnode (e.g. h('view', ...)), not a
// function component — lifecycle hooks attach to elements, not components.

import { animate } from './js/anim.mjs';
import { defineTag } from './js/reconciler.mjs';

const DEFAULT_ENTER = { opacity: 0, translateY: 8 };

// natural value the child declares for a prop (what enter animates *to* and what
// leave starts *from* when the live value can't be read): style[k], else a sane
// default (opacity 1, transforms 0).
function naturalOf(style, k) {
  if (style && k in style) { const n = parseFloat(style[k]); if (!isNaN(n)) return n; }
  return k === 'opacity' || k === 'scale' ? 1 : 0;
}

export function Transition(props = {}, ...kids) {
  const child = kids.flat().find(c => c && typeof c === 'object');
  if (!child) return null;                 // nothing to show (e.g. `show && h(...)` is false)
  const dur = props.duration ?? 220;
  const easing = props.easing ?? 'easeOutCubic';
  const enter = props.enter || DEFAULT_ENTER;
  const leave = props.leave || enter;
  const natural = (child.props && child.props.style) || {};

  const enriched = {
    ...child.props,
    onMount(el) {
      const spec = {};
      for (const k in enter) { el.style[k] = String(enter[k]); spec[k] = [enter[k], naturalOf(natural, k)]; }
      animate(el, spec, { duration: dur, easing });
    },
    onLeave(el, done) {
      const spec = {};
      for (const k in leave) {
        const live = parseFloat(el.style[k]);
        spec[k] = [isNaN(live) ? naturalOf(natural, k) : live, leave[k]];
      }
      animate(el, spec, { duration: dur, easing }).then(done);
    },
  };
  return { ...child, props: enriched };
}

defineTag('transition', Transition);
