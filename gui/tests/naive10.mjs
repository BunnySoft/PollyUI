// naive10.mjs — Wave 4: Countdown, NumberAnimation, Skeleton, Carousel,
// Watermark, Layout family, ConfigProvider, Icon.

import { h } from './gui/sdk/js/vue.mjs';
import { render } from './gui/sdk/js/reconciler.mjs';
import {
  NCountdown, NNumberAnimation, NSkeleton, NCarousel, NWatermark,
  NLayout, NLayoutHeader, NLayoutSider, NLayoutContent, NLayoutFooter,
  NConfigProvider, NIcon, NButton, useTheme,
} from './gui/sdk/js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const box = () => { const c = document.createElement('view'); c.style.padding = '12'; document.body.appendChild(c); return c; };
const T = (id) => document.getElementById(id).textContent;
const clickCenter = (el) => host.click(el.offsetLeft + el.offsetWidth / 2, el.offsetTop + el.offsetHeight / 2);

useTheme('light');

render(NCountdown({ id: 'cd', value: 125000 }), box());        // 2m 5s
host.render();
check('countdown formats MM:SS', T('cd') === '02:05');

render(NNumberAnimation({ id: 'na', value: 1234567 }), box());
host.render();
check('number animation groups thousands', T('na') === '1,234,567');

render(NSkeleton({ id: 'sk', rows: 3 }), box());
host.render();
check('skeleton renders the rows', document.getElementById('sk').childNodes.length === 3);

// Carousel: active slide + dots; click a dot
let carIdx = 0;
const carBox = box();
const rcar = () => render(NCarousel({ id: 'car', index: carIdx, height: 120, onUpdate: i => { carIdx = i; rcar(); host.render(); },
  slides: [h('view', { style: { width: '100%', height: '100%', backgroundColor: '#ff0000' } }), h('view', { style: { width: '100%', height: '100%', backgroundColor: '#0000ff' } })] }), carBox);
rcar(); host.render();
const car = document.getElementById('car');
check('carousel shows the active (red) slide', host.pixel(car.offsetLeft + 20, car.offsetTop + 20) === '#FF0000');
// dots container is the last child; its 2nd dot
const dots = car.lastChild;
clickCenter(dots.childNodes[1]);
check('clicking a dot switches the slide', carIdx === 1 && host.pixel(document.getElementById('car').offsetLeft + 20, document.getElementById('car').offsetTop + 20) === '#0000FF');

render(NWatermark({ id: 'wm', content: 'SECRET', rows: 3, cols: 3 }, h('view', { style: { width: '200', height: '120', backgroundColor: '#ffffff' } }, 'protected')), box());
host.render();
check('watermark overlays repeated text', T('wm').indexOf('SECRET') >= 0 && T('wm').indexOf('protected') >= 0);

render(NLayout({ id: 'lay', hasSider: true },
  NLayoutSider({}, h('view', {}, 'nav')),
  NLayout({}, NLayoutHeader({}, h('view', {}, 'top')), NLayoutContent({}, h('view', {}, 'main')), NLayoutFooter({}, h('view', {}, 'foot')))), box());
host.render();
check('layout renders sider/header/content/footer', ['nav', 'top', 'main', 'foot'].every(s => T('lay').indexOf(s) >= 0));

// ConfigProvider(dark): a primary button inside uses the dark green
const cpBox = document.createElement('view'); cpBox.style.position = 'absolute'; cpBox.style.top = '0'; cpBox.style.left = '0'; cpBox.style.padding = '12'; document.body.appendChild(cpBox);
render(NConfigProvider({ theme: 'dark' }, () => NButton({ type: 'primary', id: 'cpbtn' }, 'Dark')), cpBox);
host.render();
const cpbtn = document.getElementById('cpbtn');
check('config provider applies a theme', host.pixel(cpbtn.offsetLeft + 3, cpbtn.offsetTop + 17) === '#63E2B7');
useTheme('light');

render(NIcon({ id: 'ic', size: 20, color: '#d03050' }, '★'), box());
host.render();
check('icon renders a glyph', T('ic') === '★');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
