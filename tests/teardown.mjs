// Native focus/hover and detached listener cycles must be released before the VM.
function detachedTree(index) {
  const parent = document.createElement('view');
  Object.assign(parent.style, { width: 80, height: 40 });
  const child = document.createElement('view');
  Object.assign(child.style, { width: 80, height: 40 });
  child.tabIndex = 0;
  child.textContent = 'Node ' + index;
  const style = child.style;
  child.addEventListener('click', () => { style.opacity = '0.5'; parent.appendChild(child); });
  parent.appendChild(child);
  document.body.appendChild(parent);
  host.render();
  host.mouse('mousemove', child.offsetLeft + 4, child.offsetTop + 4);
  child.focus();
  document.body.removeChild(parent);
}
for (let i = 0; i < 20; i++) detachedTree(i);
console.log('PASS: detached listener/focus/hover trees created; process teardown must exit cleanly');
