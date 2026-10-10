import { open, alloc } from 'sysrt:ffi';

// No other fixture-library handle can mask an early unload in this process.
let library = open(fixtureLibrary);
let fill = library.bind('sr_delay_fill', { result: 'i32', parameters: ['pointer', 'size', 'u8', 'i32'] });
let data = alloc(8);
const pending = fill.callAsync(data, 8, 17, 30);
fill.close(); library.close(); data.close();
fill = library = data = null;
collect();
if ((await pending).value !== 8) throw new Error('Accepted native work lost its only library or allocation owner');
