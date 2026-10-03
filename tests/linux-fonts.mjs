// Requires Fontconfig, a Latin font, Noto CJK and Noto Emoji in the Linux test image.
let passed = 0;
function check(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  console.log('PASS: ' + name);
  passed++;
}
const label = document.createElement('view');
Object.assign(label.style, { fontSize: 36, color: '#000000', alignSelf: 'flex-start' });
document.body.appendChild(label);
function sample(value, family = 'sans-serif') {
  label.style.fontFamily = family;
  label.textContent = value;
  host.render();
  let pixels = '', ink = 0;
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 80; x++) {
      const pixel = host.pixel(x, y);
      pixels += pixel;
      if (pixel !== '#FFFFFF') ink++;
    }
  }
  return { pixels, ink, width: label.offsetWidth };
}
const latin = sample('Ab');
check('Latin system text renders', latin.ink > 50 && latin.width > 0);
const narrow = sample('i', 'monospace');
const wide = sample('W', 'monospace');
check('Fontconfig generic monospace has equal advances', Math.abs(narrow.width - wide.width) < 0.01);
const sans = sample('Ab', 'sans-serif');
const serif = sample('Ab', 'serif');
check('Fontconfig resolves distinct serif and sans-serif faces', serif.ink > 50 && sans.pixels !== serif.pixels);
const chinese1 = sample('\u4e2d');
const chinese2 = sample('\u6587');
check('CJK font fallback draws ink', chinese1.ink > 50 && chinese2.ink > 50);
check('CJK glyphs are distinct, not repeated missing-glyph boxes', chinese1.pixels !== chinese2.pixels);
const emoji1 = sample('\ud83d\ude00');
const emoji2 = sample('\ud83d\ude42');
check('Emoji fallback draws distinct glyphs', emoji1.ink > 50 && emoji2.ink > 50 && emoji1.pixels !== emoji2.pixels);
label.textContent = 'PollyUI / Linux\n\u4e2d\u6587\u5b57\u4f53 / \ud83d\ude00';
host.render();
check('Font snapshot saved', host.save('build/linux-fonts.png'));
console.log(passed + ' Linux font assertions passed');
