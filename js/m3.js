// m3.js — a deterministic layout to verify Yoga + Skia painting.
//
// body (column)
//   row  400x200, bg #222222, flexDirection: row, at (0,0)
//     a  100x100, bg #ff0000  -> absolute (0,0)
//     b  100x100, bg #00ff00  -> absolute (100,0)
//
// Expected pixels: (50,50)=red, (150,50)=green, (50,150)=row gray,
//                  (300,50)=row gray (past the boxes), (600,400)=white.

const row = document.createElement('view');
row.style.width = 400;
row.style.height = 200;
row.style.flexDirection = 'row';
row.style.backgroundColor = '#222222';
document.body.appendChild(row);

const a = document.createElement('view');
a.style.width = 100;
a.style.height = 100;
a.style.backgroundColor = '#ff0000';
row.appendChild(a);

const b = document.createElement('view');
b.style.width = 100;
b.style.height = 100;
b.style.backgroundColor = '#00ff00';
row.appendChild(b);

console.log('m3.js built the tree');
