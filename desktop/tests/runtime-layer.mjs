const mode = application.arguments[0];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) {
    if (!value) throw new Error(message);
    console.log('PASS: ' + message);
}
function rejects(fn, message) {
    let caught = false;
    try { fn(); } catch { caught = true; }
    check(caught, message);
}
async function until(predicate) {
    for (let i = 0; i < 500; i++) {
        if (predicate()) return;
        await delay(10);
    }
    throw new Error('Layer runtime did not reach the expected frame state');
}

async function run() {
    const outputs = window.displays();
    check(outputs.length > 0 && outputs.every(o => o.id > 0 && o.width > 0 && o.height > 0 && o.scale > 0),
        'discover native output IDs and geometry');
    window.close();
    const panelOptions = { title: 'PollyUI layer panel', layer: 'top', width: 0, height: 32,
        anchors: ['top', 'left', 'right'], exclusiveZone: 32, output: outputs[0].id };
    if (mode === 'denied') {
        rejects(() => window.create(panelOptions), 'public connection cannot create privileged layer surfaces');
        const ordinary = window.create({ title: 'PollyUI ordinary survivor', width: 400, height: 300 });
        await until(() => ordinary.document.body.offsetWidth > 0);
        check(!ordinary.closed, 'a denied layer request preserves ordinary window creation');
        window.quit();
        console.log('PASS: layer authorization rejection complete');
        return;
    }
    rejects(() => window.create({ ...panelOptions, output: 4294967295 }), 'invalid output is rejected without losing shell capability');
    const background = window.create({ title: 'PollyUI layer wallpaper', layer: 'background',
        width: 0, height: 0, anchors: ['top', 'bottom', 'left', 'right'], exclusiveZone: -1,
        output: outputs[0].id });
    const panel = window.create(panelOptions);
    const dock = window.create({ title: 'PollyUI layer dock', layer: 'top', width: 160, height: 48,
        anchors: ['bottom'], exclusiveZone: 48, margins: { bottom: 8 }, output: outputs[0].id });
    background.document.body.style.backgroundColor = '#112233';
    panel.document.body.style.backgroundColor = '#557799';
    dock.document.body.style.backgroundColor = '#997744';
    rejects(() => panel.maximize(), 'layer surfaces reject toplevel-only controls');
    const ordinary = window.create({ title: 'PollyUI layer companion', width: 420, height: 300 });
    ordinary.document.body.style.backgroundColor = '#228855';
    await until(() => background.document.body.offsetWidth > 0 && panel.document.body.offsetWidth > 0 &&
        dock.document.body.offsetWidth > 0 && ordinary.document.body.offsetWidth > 0);
    check(panel.document.body.offsetHeight === 32 && dock.document.body.offsetWidth === 160 &&
        dock.document.body.offsetHeight === 48, 'native layer buffers use compositor-configured logical dimensions');
    background.capture(mode + '-wallpaper.png');
    panel.capture(mode + '-panel.png');
    dock.capture(mode + '-dock.png');
    ordinary.maximize();
    await until(() => ordinary.isMaximized());
    await delay(80);
    const reserved = ordinary.document.body.offsetHeight;
    check(reserved < background.document.body.offsetHeight - 32, 'native panels reserve space from maximized applications');
    panel.close();
    await until(() => ordinary.document.body.offsetHeight > reserved);
    const panel2 = window.create({ ...panelOptions, title: 'PollyUI replacement panel', height: 44,
        exclusiveZone: 44, margins: { top: 6 } });
    panel2.document.body.style.backgroundColor = '#7755bb';
    await until(() => panel2.document.body.offsetHeight === 44 &&
        ordinary.document.body.offsetHeight < reserved);
    panel2.capture(mode + '-replacement-panel.png');
    background.close();
    panel2.close();
    dock.close();
    await until(() => background.closed && panel2.closed && dock.closed);
    await delay(50);
    let replacement;
    ordinary.onclose = () => {
        replacement = window.create({ title: 'PollyUI final layer', layer: 'overlay',
            width: 320, height: 100, anchors: ['top', 'right'],
            margins: { top: 10, right: 10 }, output: outputs[0].id });
        replacement.document.body.style.backgroundColor = '#aa4433';
    };
    ordinary.close();
    await until(() => replacement && replacement.document.body.offsetWidth > 0);
    replacement.capture(mode + '-final-layer.png');
    check(!replacement.closed, 'last-window replacement retains the trusted Wayland connection');
    window.quit();
    console.log('PASS: native multi-layer runtime complete');
}
run().catch(error => {
    console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
    window.quit();
});
