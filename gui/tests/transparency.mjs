function check(value, message) {
    if (!value) throw new Error(message);
    console.log('PASS: ' + message);
}
function rejects(options, type) {
    let error;
    try { window.create(options); } catch (caught) { error = caught; }
    check(error instanceof type, 'invalid/unsupported transparency is an explicit error');
}
window.close();
for (const value of [1, 'true', null, {}, NaN])
    rejects({ transparent: value }, TypeError);
if (!window.capabilities().transparent) {
    rejects({ transparent: true }, InternalError);
    window.quit();
} else {
    const marker = window.create({ title: 'Alpha.marker', width: 900, height: 600 });
    function tile(doc, x, y, width, height, backgroundColor) {
        const node = doc.createElement('view');
        Object.assign(node.style, { position: 'absolute', left: x, top: y,
            width, height, backgroundColor });
        doc.body.appendChild(node);
        return node;
    }
    marker.document.body.style.backgroundColor = '#204080';
    tile(marker.document, 450, 0, 450, 600, '#802040');
    const opaque = window.create({ title: 'Alpha.opaque', width: 220, height: 160 });
    rejects({ parent: marker, popup: 'menu', transparent: true }, TypeError);
    rejects({ layer: 'top', parent: marker, transparent: true }, TypeError);
    const framed = window.create({ title: 'Alpha.framed', width: 240, height: 160,
        transparent: true, parent: marker, minWidth: 200, minHeight: 140,
        maxWidth: 360, maxHeight: 240 });
    const frameless = window.create({ title: 'Alpha.frameless', width: 240, height: 160,
        transparent: true });
    frameless.setFrameless(true);
    for (const handle of [framed, frameless]) {
        tile(handle.document, 60, 20, 40, 40, '#c8502880');
        tile(handle.document, 120, 20, 40, 40, '#20e080');
        const text = handle.document.createElement('text');
        Object.assign(text.style, { position: 'absolute', left: 20, top: 80,
            fontSize: 28, color: '#ffffff' });
        text.textContent = 'ALPHA';
        handle.document.body.appendChild(text);
    }
    let captured = false, released = false;
    framed.document.body.addEventListener('mousedown', event => {
        event.currentTarget.setMouseCapture();
        captured = event.currentTarget.hasMouseCapture();
        tile(framed.document, 180, 20, 20, 20, '#e02080');
    });
    framed.document.body.addEventListener('mouseup', () => {
        released = true;
        tile(framed.document, 180, 20, 20, 20, '#2080e0');
    });
    let modalClosed = 0;
    const modal = window.create({ title: 'Alpha.modal', width: 200, height: 140,
        parent: opaque, modal: true, transparent: true });
    tile(modal.document, 120, 20, 40, 40, '#20e080');
    modal.onclose = () => modalClosed++;
    framed.oncloserequest = () => {
        check(captured && released && !framed.document.body.hasMouseCapture(),
            'transparent pixels remain interactive and native capture releases');
        check(framed.state.width === framed.document.body.offsetWidth &&
            framed.state.pixelWidth === Math.round(framed.state.width * framed.state.scale),
            'transparent viewport follows actual native resize and DPI');
        check(framed.document !== marker.document && marker.document !== opaque.document,
            'transparent and opaque windows retain independent documents');
        return true;
    };
    framed.onclose = () => {
        check(!marker.closed, 'transparent owned leaf retires before owner notification');
        marker.close();
        opaque.close();
    };
    opaque.onclose = () => {
        check(modalClosed === 1 && modal.closed, 'transparent modal retires once with its opaque owner');
        frameless.close();
        window.quit();
    };
    setTimeout(() => { throw new Error('Native transparency fixture timed out'); }, 12000);
}
