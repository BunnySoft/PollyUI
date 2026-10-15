const child = window.create({ title: 'Owner.throw', width: 220, height: 160 });
child.observeState(() => { throw new Error('EXPECTED observer exception'); });
child.observeState(state => {
  if (state.width < 1) throw new Error('Invalid isolated state after observer exception');
  child.close();
  console.log('PASS: later observer and native cleanup complete after the reported callback exception');
  window.quit();
});
setTimeout(() => ownerTest.resize('Owner.throw', 260, 180), 80);
