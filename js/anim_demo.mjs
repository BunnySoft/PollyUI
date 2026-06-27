// anim_demo.mjs — staggered animations.
//   Windowed:  pollyui js/anim_demo.mjs
//   Snapshot:  pollyui --test js/anim_demo.mjs   (build/win-clang/anim.png, mid-flight)

import { animate, easings } from './js/anim.mjs';

const make = (s, p) => {
  const n = document.createElement('view');
  if (s) for (const k in s) n.style[k] = s[k];
  if (p) p.appendChild(n);
  return n;
};
const text = (str, s, p) => { const n = make(s, p); n.appendChild(document.createTextNode(str)); return n; };

document.body.style.backgroundColor = '#0b1020';
document.body.style.padding = '28';
document.body.style.gap = '14';
text('requestAnimationFrame-driven tweens', { color: '#e5e7eb', fontSize: '22', fontWeight: 'bold' }, document.body);

// A column of bars that grow from 0 to a target width with eased timing.
const colors = ['#22d3ee', '#34d399', '#f59e0b', '#ef4444', '#a78bfa', '#ec4899'];
const targets = [680, 520, 600, 440, 560, 500];
const bars = colors.map((c, i) => make({
  height: '40', width: '0', backgroundColor: c, borderRadius: '8', opacity: '0',
}, document.body));

bars.forEach((bar, i) =>
  animate(bar, { width: [0, targets[i]], opacity: [0, 1] },
          { duration: 900, delay: i * 120, easing: 'easeOutCubic' }));

// A spinning, pulsing badge.
const badge = make({
  position: 'absolute', top: '24', right: '28', width: '70', height: '70',
  backgroundColor: '#6366f1', borderRadius: '35', rotate: '0', scale: '1',
}, document.body);
function spin() {
  animate(badge, { rotate: [0, 360] }, { duration: 2000, easing: 'linear', onComplete: spin });
  animate(badge, { scale: [1, 1.25] }, { duration: 1000, easing: 'easeInOutCubic',
    onComplete: () => animate(badge, { scale: [1.25, 1] }, { duration: 1000, easing: 'easeInOutCubic' }) });
}
spin();

// Headless: drive a few frames and snapshot mid-flight (badge rotated, bars partway).
if (typeof host !== 'undefined') {
  host.render(0);
  host.render(500);   // 500ms in: easeOut bars ~70% grown, badge spun 90deg, scaled up
  host.save('build/win-clang/anim.png');
  console.log('wrote build/win-clang/anim.png');
}
