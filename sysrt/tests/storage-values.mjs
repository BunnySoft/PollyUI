function check(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  console.log('PASS: ' + name);
}
localStorage.clear();
const key = 'key\u0000part';
const value = '\u4e2d\u6587\u0000\ud83d\ude00';
localStorage.setItem(key, value);
check('storage preserves NUL and Unicode', localStorage.getItem(key) === value);
check('storage enumerates complete keys', localStorage.key(0) === key);
check('NUL keys do not alias prefixes', localStorage.getItem('key') === null);
localStorage.setItem(key, 'replacement');
check('overwrite keeps key count', localStorage.length === 1 && localStorage.getItem(key) === 'replacement');
let rejected = false;
try { localStorage.setItem('bad', { toString() { throw new Error('conversion'); } }); }
catch (error) { rejected = error.message === 'conversion'; }
check('conversion error preserves prior state', rejected && localStorage.length === 1);
localStorage.removeItem(key);
check('remove deletes the complete key', localStorage.length === 0);
localStorage.setItem('', '');
check('empty keys and values round-trip', localStorage.getItem('') === '');
localStorage.clear();
check('clear persists an empty store', localStorage.length === 0);
