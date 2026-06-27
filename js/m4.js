// m4.js — text rendering. Text is measured into the Flexbox layout and painted
// by Skia, inheriting fontSize + color from its parent element.

const box = document.createElement('view');
box.style.backgroundColor = '#ffffff';
box.style.padding = 30;
box.style.alignItems = 'flex-start';
document.body.appendChild(box);

const title = document.createElement('view');
title.style.fontSize = 48;
title.style.color = '#1e293b';
title.textContent = 'Hello PollyUI';
box.appendChild(title);

const sub = document.createElement('view');
sub.style.fontSize = 22;
sub.style.color = '#3b82f6';
sub.textContent = 'Text rendering works.';
box.appendChild(sub);

console.log('m4.js built');
