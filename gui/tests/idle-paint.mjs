const surface = window.create({ title: 'Idle IPC paint regression', width: 96, height: 96 });
window.close();
const body = surface.document.body;
body.style.backgroundColor = '#102030';
const label = surface.document.createElement('view');
label.textContent = 'initial';
label.tabIndex = 0;
label.style['focus:backgroundColor'] = '#00ff00';
body.appendChild(label);
let polls = 0;
const timer = setInterval(() => { polls++; }, 5);
setTimeout(() => paintProbe('idle-start'), 150);
setTimeout(() => {
  paintProbe('idle-end');
  if (polls < 20) throw new Error('Idle timer did not continue pumping');
  body.style.backgroundColor = '#304050';
  Promise.resolve().then(() => { label.textContent = 'changed'; });
}, 500);
setTimeout(() => {
  paintProbe('mutated');
  label.focus();
}, 650);
setTimeout(() => {
  paintProbe('focused');
  clearInterval(timer);
  window.quit();
}, 800);
