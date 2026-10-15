import './desktop/examples/material.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const status = document.getElementById('material-status');
check(status?.textContent.startsWith('Cached: '), 'Opt-in example publishes its real native client material');
const stats = JSON.parse(status.textContent.slice(8));
check(stats.ready && stats.blurs === 1 && stats.width > 0 && stats.height > 0,
  'Native example initializes the actual cached blur exactly once');
const toggle = document.getElementById('material-toggle');
check(toggle?.getAttribute('role') === 'button' && toggle.tabIndex === 0 &&
  toggle.textContent === 'Restore solid client base', 'Explicit solid recovery remains a focusable user command');
const material = document.body.firstChild;
check(material.tagName === 'CANVAS' && material.getAttribute('aria-hidden') === 'true',
  'Only the decorative base is the canvas; foreground remains separate');
window.onclose();
check(material.width === 0 && material.height === 0 && !material.parentNode,
  'Example close handler removes the owner observer and disposes the base');
console.log('PASS: opt-in native-window example startup and explicit cleanup (SDL dummy, software raster)');
window.close();
