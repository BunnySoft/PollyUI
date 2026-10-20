// Run with PU_RENDERER=gl; native window refusal also sets process exit status 1.
let rejected = false;
try {
  window.create({ title: 'Raster-only explicit GL refusal', width: 64, height: 64 });
} catch (error) {
  rejected = /window|creation|host/i.test(String(error));
}
if (!rejected) throw new Error('An explicit GL window request must fail in a raster-only build');
console.log('RASTER_ONLY_GL_REFUSED');
