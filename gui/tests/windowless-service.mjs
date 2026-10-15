if (typeof window !== 'undefined' || typeof host !== 'undefined' || document.defaultView !== null)
  throw new Error('Windowless service acquired a Window or test host');
const canvas = document.createElement('canvas');
canvas.width = 4; canvas.height = 3;
const context = canvas.getContext('2d');
context.fillStyle = '#123456';
context.fillRect(0, 0, 4, 3);
const pixel = context.getImageData(1, 1, 1, 1).data;
if (pixel[0] !== 0x12 || pixel[1] !== 0x34 || pixel[2] !== 0x56 || pixel[3] !== 255)
  throw new Error('Windowless detached Canvas did not paint real pixels');
await new Promise(resolve => setTimeout(resolve, 20));
await new Promise(resolve => computeAsync(250000, count => {
  if (count < 20000) throw new Error('Dispatcher task did not complete');
  resolve();
}));
finishService();
