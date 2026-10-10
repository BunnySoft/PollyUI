const first = window.create({ title: 'First paint document', width: 96, height: 96 });
const second = window.create({ title: 'Second paint document', width: 96, height: 96 });
window.close();
first.document.body.style.backgroundColor = '#102030';
second.document.body.style.backgroundColor = '#304050';
setTimeout(() => {
  first.capture(capturePrefix + '-first.png');
  second.capture(capturePrefix + '-second.png');
  paintProbe('before');
  first.document.body.style.backgroundColor = '#607080';
}, 150);
setTimeout(() => {
  paintProbe('after');
  second.document.body.textContent = 'Only the second document';
}, 300);
setTimeout(() => {
  paintProbe('second');
  window.quit();
}, 450);
