window.close();
const outputs = window.displays();
if (outputs.length !== 2) throw new Error('Expected two native displays');
let closed = 0;
for (const output of outputs) {
    const background = window.create({
        title: 'Native background ' + output.id, output: output.id,
        layer: 'background', width: 0, height: 0, exclusiveZone: -1,
        anchors: ['top', 'bottom', 'left', 'right'],
    });
    background.document.body.style.backgroundColor = '#123456';
    const panel = window.create({
        title: 'Native panel ' + output.id, output: output.id,
        layer: 'top', width: 0, height: 28, exclusiveZone: 28,
        anchors: ['top', 'left', 'right'], keyboard: 'on-demand',
    });
    panel.document.body.style.backgroundColor = '#789abc';
    panel.document.body.tabIndex = 0;
    panel.document.body.addEventListener('mousedown', () => {
        panel.document.body.style.backgroundColor = '#c04020';
        console.log('PASS: native layer pointer input');
    });
    panel.document.body.addEventListener('keydown', event => {
        if (event.code === 'KeyA') {
            panel.document.body.style.backgroundColor = '#20c040';
            console.log('PASS: native layer keyboard input');
        }
    });
    background.onclose = panel.onclose = () => {
        if (++closed === 4) console.log('PASS: all output-specific native layer windows closed');
    };
}
const ordinary = window.create({ title: 'Fullscreen occlusion fixture', width: 420, height: 300 });
ordinary.document.body.style.backgroundColor = '#334455';
setInterval(() => {}, 20); // Shared UI work must continue while another surface is occluded.
