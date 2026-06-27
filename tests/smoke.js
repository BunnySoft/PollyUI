// smoke.js — a headless test using the in-process `host` API (no window, no OS
// input). Run:  pollyui.exe --test tests/smoke.js
//
// host.render()        lay out + paint the offscreen surface
// host.click(x, y)     hit-test + dispatch a click, then re-render; returns hit
// host.pixel(x, y)     read a pixel as "#RRGGBB"
// host.save(path)      write the surface to a PNG

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('PASS: ' + name); }
    else      { fail++; console.log('FAIL: ' + name); }
}

const box = document.createElement('view');
box.style.width = 200;
box.style.height = 100;
box.style.margin = 50;            // -> box occupies (50,50)..(250,150)
box.style.backgroundColor = '#3b82f6';
document.body.appendChild(box);

let clicks = 0;
box.addEventListener('click', () => {
    clicks++;
    box.style.backgroundColor = '#ef4444';
});

host.render();
check('box paints blue', host.pixel(150, 100) === '#3B82F6');
check('outside is white', host.pixel(400, 400) === '#FFFFFF');

const hit = host.click(150, 100);          // inside the box
check('click hit the box', hit === true);
check('handler ran once', clicks === 1);
check('box turned red', host.pixel(150, 100) === '#EF4444');

host.click(5, 5);                          // outside the box (body, no listener)
check('handler not re-run', clicks === 1);

const saved = host.save('build/smoke.png');
check('snapshot saved', saved === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
