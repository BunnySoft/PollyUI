// hello.js — the target app for milestone M3/M5.
// This is the API we are designing toward (see DESIGN.md §4).

const root = document.body;

const card = document.createElement('view');
card.style.width = 240;
card.style.height = 140;
card.style.padding = 16;
card.style.flexDirection = 'column';
card.style.backgroundColor = '#3b82f6';
root.appendChild(card);

const label = document.createElement('text');
label.textContent = 'Hello, PollyUI';
label.style.color = 'white';
card.appendChild(label);

let toggled = false;
card.addEventListener('click', () => {
  toggled = !toggled;
  card.style.backgroundColor = toggled ? '#ef4444' : '#3b82f6';
});

console.log('hello.js loaded');
