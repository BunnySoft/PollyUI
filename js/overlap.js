// overlap.js — position: absolute lets views overlap (and paint on top in tree
// order). A red box is absolutely positioned over a blue base box.

const base = document.createElement('view');
base.style.width = 300;
base.style.height = 300;
base.style.margin = 40;
base.style.backgroundColor = '#3b82f6'; // blue base, at (40,40)
document.body.appendChild(base);

const over = document.createElement('view');
over.style.position = 'absolute';      // out of flow -> overlaps siblings
over.style.top = 80;
over.style.left = 80;
over.style.width = 150;
over.style.height = 150;
over.style.backgroundColor = '#ef4444'; // red overlay, at (120,120) absolute
base.appendChild(over);

console.log('overlap.js: red box absolutely positioned over blue base');
