// m5.js — interactivity. A button toggles its color on click via
// addEventListener; the window re-lays-out and repaints in response.

const btn = document.createElement('view');
btn.style.width = 200;
btn.style.height = 80;
btn.style.margin = 40;
btn.style.backgroundColor = '#3b82f6'; // blue

document.body.appendChild(btn);

let on = false;
btn.addEventListener('click', (e) => {
    on = !on;
    btn.style.backgroundColor = on ? '#ef4444' : '#3b82f6'; // red <-> blue
    console.log('clicked: ' + e.type + ' -> ' + btn.style.backgroundColor);
});

console.log('m5.js: click the box to toggle its color');
