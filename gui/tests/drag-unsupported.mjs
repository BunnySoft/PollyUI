if (window.capabilities().dragCopy) throw new Error('unsupported host advertised COPY');
let rejected = false;
try { window.startDrag({input: {}, items:[{type:'text/plain',data:'copy'}]}); } catch { rejected = true; }
if (!rejected) throw new Error('unsupported host accepted fabricated native input');
console.log('PASS: unsupported native COPY capability and credential exception');
window.quit();
