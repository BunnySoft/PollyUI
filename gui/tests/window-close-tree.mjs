function check(value, message) {
    if (!value) throw new Error(message);
    console.log('PASS: ' + message);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
    for (let i = 0; i < 800; i++) { if (predicate()) return; await delay(10); }
    throw new Error('Native close-tree fixture timed out');
}
async function run() {
    const owner = window.create({ title: 'Close.owner', width: 300, height: 220 });
    const child = window.create({ title: 'Close.child', parent: owner, width: 240, height: 160 });
    const grand = window.create({ title: 'Close.grand', parent: child, modal: true, width: 200, height: 140 });
    grand.document.body.tabIndex = 0;
    grand.document.body.focus();
    grand.document.body.style.backgroundColor = '#304080';
    const peer = window.create({ title: 'Close.peer', parent: owner, width: 160, height: 120 });
    let peerClosed = 0, grandClosed = 0, childClosed = 0, ownerClosed = 0, gcClosed = 0;
    let grandRequests = 0, childRequests = 0, ownerRequests = 0, save;
    let captured = 0, lostCapture = 0;
    grand.onactivate = () => {
        if (!captured) grand.document.body.style.backgroundColor = '#406090';
    };
    grand.ondeactivate = () => {
        if (!captured) grand.document.body.style.backgroundColor = '#304080';
    };
    grand.document.body.addEventListener('mousedown', event => {
        console.log('NATIVE mousedown: ' + event.clientX + ',' + event.clientY +
            ' viewport=' + grand.document.body.offsetWidth + 'x' + grand.document.body.offsetHeight);
        grand.document.body.setMouseCapture(); captured++;
        grand.document.body.style.backgroundColor = '#20c040';
    });
    grand.document.body.addEventListener('lostmousecapture', () => lostCapture++);
    let garbage = window.create({ title: 'Close.gc', parent: owner, width: 120, height: 100 });
    garbage.onclose = () => { gcClosed++; check(!owner.closed, 'GC-dropped child closes before its live owner'); };
    garbage = null;
    fixtureGC();
    peer.oncloserequest = () => true;
    peer.onclose = () => { peerClosed++; check(!owner.closed, 'accepted peer retires while vetoed owner remains open'); };
    grand.oncloserequest = () => {
        if (++grandRequests === 1) {
            save = window.create({ title: 'Close.save', parent: grand, modal: true, width: 160, height: 100 });
            return Promise.resolve(true);
        }
        return true;
    };
    grand.onclose = () => {
        grandClosed++;
        check(!child.closed && !owner.closed, 'actual grandchild onclose precedes parent closure');
        let rejected = false;
        try { window.create({ parent: grand }); } catch (error) { rejected = error instanceof TypeError; }
        check(rejected, 'retiring native parent cannot gain a reentrant child');
        fixtureGC();
    };
    child.oncloserequest = () => {
        childRequests++;
        check(grandClosed === 1 && grand.document.activeElement === null && grand.document.body.offsetWidth > 0,
            'parent request waits for actual grandchild close and document focus reset');
        return true;
    };
    child.onclose = () => { childClosed++; check(!owner.closed, 'actual child notification precedes owner closure'); };
    owner.oncloserequest = () => {
        ownerRequests++;
        check(childClosed === 1 && peerClosed === 1 && gcClosed === 1,
            'owner external request runs only after owned native children retired');
        return true;
    };
    owner.onclose = () => { ownerClosed++; check(childClosed === 1, 'owner closes after its native dependents'); };
    await until(() => save && grandRequests === 1);
    await until(() => save.closed);
    await delay(60);
    console.log('NATIVE capture: acquired=' + captured + ' lost=' + lostCapture +
        ' retained=' + grand.document.body.hasMouseCapture());
    check(captured === 1 && lostCapture === 1 && !grand.document.body.hasMouseCapture(),
        'native modal activation cancels captured pointer input once without cross-window leakage');
    check(!owner.closed && !child.closed && !grand.closed && grandRequests === 1 &&
        childRequests === 0 && ownerRequests === 0 && peerClosed === 1 && gcClosed === 1,
        'Promise is a decline, not acceptance or automatic retry; accepted siblings need not be restored');
    const marker = window.create({ title: 'Close.retry', width: 80, height: 80 });
    await until(() => ownerClosed === 1);
    check(grandRequests === 2 && childRequests === 1 && ownerRequests === 1 &&
        grandClosed === 1 && childClosed === 1 && !window.closed,
        'one explicit native retry closes the tree once and preserves the shared realm');
    marker.close();
    const explicit = window.create({ title: 'Close.explicit', width: 240, height: 160 });
    let recreated, recreateRequests = 0, recreatedClosed = 0;
    const reentrant = window.create({ title: 'Close.reentrant', parent: explicit, width: 160, height: 120 });
    reentrant.oncloserequest = () => true;
    reentrant.onclose = () => {
        check(!explicit.closed, 'native child callback may create a new child while owner remains pinned/open');
        recreated = window.create({ title: 'Close.recreated', parent: explicit, width: 160, height: 120 });
        recreated.oncloserequest = () => { recreateRequests++; return false; };
        recreated.onclose = () => recreatedClosed++;
    };
    explicit.close();
    await until(() => recreated && recreateRequests === 1);
    await delay(40);
    check(!explicit.closed && !recreated.closed && recreateRequests === 1,
        'reentrant new child participates in pending coordination and is never blindly retried');
    recreated.oncloserequest = () => true;
    explicit.close();
    await until(() => explicit.closed);
    check(recreatedClosed === 1, 'new child actual retirement precedes its coordinated owner');
    const vetoOwner = window.create({ title: 'Close.veto-owner', width: 240, height: 160 });
    const dependent = window.create({ title: 'Close.explicit-child', parent: vetoOwner, width: 180, height: 120 });
    let dependentClosed = 0;
    vetoOwner.oncloserequest = () => { throw new Error('Explicit close must bypass its own hook'); };
    dependent.oncloserequest = () => false;
    check(vetoOwner.close() === undefined && !vetoOwner.closed && !dependent.closed,
        'explicit owned-parent close preserves return compatibility and descendant veto');
    dependent.oncloserequest = () => true;
    dependent.onclose = () => { dependentClosed++; check(!vetoOwner.closed, 'explicit owner waits for native child notification'); };
    vetoOwner.close();
    check(!vetoOwner.closed, 'pending close does not falsely report an already-closed owner');
    await until(() => vetoOwner.closed);
    check(dependentClosed === 1, 'explicit owner coordinates actual leaf retirement');
    const forced = window.create({ title: 'Close.forced', width: 240, height: 160 });
    const forcedChild = window.create({ title: 'Close.forced-child', parent: forced, width: 180, height: 120 });
    let forcedRequests = 0, forcedChildClosed = 0, forcedClosed = 0;
    forcedChild.oncloserequest = () => { forcedRequests++; return false; };
    forcedChild.onclose = () => forcedChildClosed++;
    forced.onclose = () => {
        forcedClosed++;
        check(forcedChildClosed === 1 && forcedRequests === 0 && forcedClosed === 1,
            'explicit quit preserves forced semantics but retires native resources leaf-first');
    };
    check(window.quit() === undefined && forced.closed && forcedChild.closed && forcedRequests === 0,
        'forced application quit is not a vetoable normal parent-close retry');
    console.log('PASS: native close-tree JS contract complete');
}
run().catch(error => {
    console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
    window.quit();
    throw error;
});
