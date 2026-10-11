function check(value, message) {
    if (!value) throw new Error(message);
    console.log('PASS: ' + message);
}
function rejects(fn, type, message) {
    let error;
    try { fn(); } catch (caught) { error = caught; }
    check(error instanceof type, message);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
    for (let i = 0; i < 600; i++) {
        if (predicate()) return;
        await delay(10);
    }
    throw new Error('Native window contract fixture timed out');
}

async function run() {
    const caps = window.capabilities();
    if (application.arguments[1] === 'unsupported') {
        check(caps.owned && caps.popup && !caps.modal && !caps.popupGrab,
            'missing compositor modality is advertised honestly');
        const owner = window.create({ title: 'Contract.unsupported', width: 200, height: 140 });
        rejects(() => window.create({ parent: owner, modal: true }), InternalError,
            'SDL success without xdg-dialog cannot masquerade as a modal');
        await until(() => owner.document.body.offsetWidth > 0);
        check(!owner.closed && owner.state.width > 0, 'unsupported creation preserves existing native windows');
        window.quit();
        console.log('PASS: native unsupported feature errors complete');
        return;
    }
    check(caps.owned && caps.popup && caps.modal && caps.sizeConstraints && !caps.popupGrab,
        'native capabilities are explicit, including unavailable grabs');
    for (const options of [
        { parent: {} }, { parent: document }, { parent: null },
        { popup: 'menu' }, { popup: true }, { modal: true }, { modal: 1 },
        { popupX: 1 }, { minWidth: -1 }, { minHeight: NaN }, { maxWidth: 2.5 },
        { minWidth: 300, maxWidth: 200 }, { minHeight: 300, maxHeight: 200 },
        { popupGrab: true }, { layer: 'top', minWidth: 100 },
    ]) rejects(() => window.create(options), TypeError, 'invalid native contract is rejected');

    const owner = window.create({ title: 'Contract.owner', width: 300, height: 220 });
    const sized = window.create({ title: 'Contract.sized', width: 80, height: 80,
        minWidth: 200, minHeight: 140, maxWidth: 420, maxHeight: 300 });
    check(owner.parent === null, 'omitting parent preserves independent ordinary windows');
    for (const options of [
        { parent: owner, popup: 'menu', modal: true },
        { parent: owner, popup: 'menu', minWidth: 100 },
        { parent: owner, inputPopup: true }, { parent: owner, layer: 'top' },
    ]) rejects(() => window.create(options), TypeError, 'incompatible native roles are rejected');
    const owned = window.create({ title: 'Contract.owned', width: 160, height: 120, parent: owner });
    check(owned.parent === owner, 'owned relation is a read-only native projection');
    rejects(() => { owned.parent = sized; }, TypeError, 'runtime reparenting is not exposed');
    const modal = window.create({ title: 'Contract.modal', width: 260, height: 180,
        parent: owner, modal: true });
    let modalKeys = 0, ownerKeys = 0, closeRequests = 0, modalClosed = 0, stateChanges = 0;
    owner.document.body.tabIndex = modal.document.body.tabIndex = 0;
    owner.document.body.focus(); modal.document.body.focus();
    owner.document.body.addEventListener('keydown', () => ownerKeys++);
    modal.document.body.addEventListener('keydown', event => {
        if (event.code === 'KeyA') {
            modalKeys++;
            modal.document.body.style.backgroundColor = '#20c040';
        }
    });
    modal.oncloserequest = () => {
        if (++closeRequests === 1) {
            modal.document.body.style.backgroundColor = '#c04020';
            console.log('PASS: modal native close request was vetoed');
            return false;
        }
        return true;
    };
    modal.onclose = () => modalClosed++;
    sized.onstatechange = state => {
        stateChanges++;
        const actual = sized.state;
        check(state.width === actual.width && state.height === actual.height &&
            state.pixelWidth === actual.pixelWidth && state.scale === actual.scale,
            'state notification matches actual native geometry');
        if (!state.minimized) check(state.width >= 200 && state.width <= 420 &&
            state.height >= 140 && state.height <= 300, 'native constraints bound actual client geometry');
    };
    await until(() => sized.document.body.offsetWidth >= 200);
    check(sized.state.width === sized.document.body.offsetWidth &&
        sized.state.height === sized.document.body.offsetHeight,
        'native state and rendered document viewport agree');
    if (application.arguments[0]) sized.capture(application.arguments[0] + '-constraints.png');
    if (application.arguments[1] === 'standalone') {
        owned.close(); modal.close();
    } else {
        await until(() => modal.closed);
        check(closeRequests === 2 && modalKeys === 1 && ownerKeys === 0,
            'native modal input and close veto stay window-scoped');
    }
    await until(() => modalClosed === 1);
    check(!owner.closed && !sized.closed, 'closing a modal preserves ordinary windows');
    owned.close();
    await until(() => owned.closed);
    rejects(() => window.create({ parent: owned }), TypeError, 'closed parents are rejected');
    const popup = window.create({ title: 'Contract.popup', width: 120, height: 70,
        parent: owner, popup: application.arguments[1] === 'tooltip' ? 'tooltip' : 'menu',
        popupX: 30, popupY: 40 });
    check(popup.parent === owner && popup.document !== owner.document, 'native popup owns an independent document');
    rejects(() => popup.maximize(), TypeError, 'toplevel controls cannot change popup role');
    rejects(() => window.create({ parent: popup }), TypeError, 'popup cannot own a toplevel');
    let popupClosed = 0, popupRequests = 0;
    let nestedClosed = 0;
    let popupState;
    popup.onstatechange = state => { popupState = state; };
    await until(() => popup.document.body.offsetWidth > 0);
    const nested = window.create({ title: 'Contract.nested-popup', width: 60, height: 30,
        parent: popup, popup: 'tooltip', popupX: 10, popupY: 10 });
    nested.onclose = () => { nestedClosed++; check(!popup.closed || !owner.closed, 'nested popup closes without destroying ordinary owner'); };
    popup.onclose = () => {
        popupClosed++;
        check(nestedClosed === 1, 'nested native popup notification precedes terminal parent-popup notification');
    };
    popup.oncloserequest = () => { popupRequests++; return false; };
    if (application.arguments[1] === 'standalone') {
        await until(() => popup.document.body.offsetWidth > 0);
        popup.close();
    } else await until(() => popup.closed);
    await until(() => popupClosed === 1);
    check(popupState && popupState.width === popup.document.body.offsetWidth &&
        popupState.height === popup.document.body.offsetHeight && popupState.width === 120 &&
        popupState.height === 70, 'mapped popup geometry, notification and rendered viewport agree');
    check(popupRequests === 0 && !owner.closed, 'native popup dismissal is terminal and does not veto or close its owner');
    check(stateChanges > 0, 'actual size/state changes are delivered');
    owner.close(); sized.close(); window.quit();
    console.log('PASS: native window JS contract complete');
}
run().catch(error => {
    console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
    window.quit();
    throw error;
});
