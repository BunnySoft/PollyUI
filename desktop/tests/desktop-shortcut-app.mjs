const native = window.create({ title: 'BD04.App', width: 260, height: 180 });
native.document.body.style.backgroundColor = '#c04020';
native.document.body.tabIndex = 0;
native.document.body.addEventListener('mousedown', () => console.log('PASS: shortcut fixture app received native pointer'));
native.document.body.addEventListener('keydown', event => {
  console.log('PASS: shortcut fixture app received native key ' + event.key);
});
window.close();
setTimeout(() => native.close(), 600);
