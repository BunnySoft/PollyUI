if (application.id !== 'org.example.packaged') throw new Error('Package identity was not preserved');
if (typeof desktop !== 'object' || !desktop.fileSystem ||
  Object.keys(desktop).length !== 1 || Object.keys(desktop)[0] !== 'fileSystem')
  throw new Error('A packaged application received desktop management APIs');
const count = Number(localStorage.getItem('launches') || '0') + 1;
localStorage.setItem('launches', String(count));
console.log('PASS: packaged application launch ' + count);
window.close();
