import { h, render } from './js/reconciler.mjs';

const prefix = application.arguments[0];
function check(value, message) {
    if (!value) throw new Error(message);
    console.log('PASS: ' + message);
}
function rejects(fn, message) {
    let rejected = false;
    try { fn(); } catch { rejected = true; }
    check(rejected, message);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
    for (let i = 0; i < 500; i++) {
        if (predicate()) return;
        await delay(10);
    }
    throw new Error('Native window did not reach the expected frame state');
}
const primary = window;
let first, second;

async function run() {
    for (const options of [null, [], 4, { width: 0 }, { height: NaN },
        { width: 1.5 }, { width: Infinity }, { title: 7 }, { title: 'bad\0title' }, { unknown: true }]) {
        rejects(() => window.create(options), 'invalid window options are rejected');
    }
    first = window.create({ title: 'PollyUI first', width: 480, height: 320 });
    second = first.create({ title: 'PollyUI second', width: 480, height: 320 });
    check(first.document !== second.document && first.document !== document, 'independent documents share one realm');
    check(window.document === document, 'primary document is backward compatible');
    first.document.body.style.backgroundColor = '#d04030';
    second.document.body.style.backgroundColor = '#3060c0';
    const left = first.document.createElement('view');
    const right = second.document.createElement('view');
    left.id = right.id = 'same-id';
    left.style.width = '50%';
    right.style.width = '25%';
    left.style.height = right.style.height = 20;
    left.tabIndex = right.tabIndex = 0;
    first.document.body.appendChild(left);
    second.document.body.appendChild(right);
    check(first.document.getElementById('same-id') === left &&
        second.document.querySelector('#same-id') === right &&
        document.getElementById('same-id') === null, 'selectors stay within their own document');
    left.focus();
    right.focus();
    check(first.document.activeElement === left && second.document.activeElement === right &&
        document.activeElement === null, 'DOM focus is independent per window');
    second.document.body.appendChild(left);
    check(first.document.activeElement === null && second.document.activeElement === right,
        'moving a focused node does not move keyboard focus across windows');
    first.document.body.appendChild(left);
    rejects(() => first.document.body.appendChild(second.document.body), 'document roots cannot be merged');
    await until(() => first.document.body.offsetWidth > 0 && second.document.body.offsetWidth > 0);
    check(left.offsetWidth === first.document.body.offsetWidth / 2 &&
        right.offsetWidth === second.document.body.offsetWidth / 4,
        'equal-sized windows retain distinct layout caches');
    first.capture(prefix + '-first.png');
    second.capture(prefix + '-second.png');
    left.style.width = '75%';
    right.style.width = '50%';
    first.document.body.style.backgroundColor = '#20a050';
    await until(() => left.offsetWidth === first.document.body.offsetWidth * 0.75 &&
        right.offsetWidth === second.document.body.offsetWidth / 2);
    check(left.offsetWidth === first.document.body.offsetWidth * 0.75 &&
        right.offsetWidth === second.document.body.offsetWidth / 2,
        'one shared callback updates both documents');
    first.capture(prefix + '-updated.png');
    let primaryClosed = 0;
    primary.onclose = () => primaryClosed++;
    primary.close();
    await delay(80);
    check(primary.closed && primaryClosed === 1 && !first.closed && !second.closed,
        'closing primary preserves secondary windows and timers');
    const mountRoot = second.document.createElement('view');
    second.document.body.appendChild(mountRoot);
    render(h('view', { style: { width: 100, height: 30 } }, 'Shared reconciler'), mountRoot);
    await delay(60);
    check(mountRoot.firstChild.offsetWidth === 100,
        'the reconciler works in a secondary document after primary closes');
    let firstClosed = 0;
    first.onclose = () => { firstClosed++; second.document.body.style.backgroundColor = '#9050b0'; };
    first.close();
    first.close();
    await delay(80);
    check(first.closed && firstClosed === 1 && !second.closed, 'close notification is one-shot and window-scoped');
    check(first.document.body && first.document.activeElement === null, 'retained closed documents remain readable');
    rejects(() => first.maximize(), 'closed window controls fail explicitly');
    second.capture(prefix + '-survivor.png');
    for (let i = 0; i < 12; i++) {
        const temporary = window.create({ title: 'PollyUI transient', width: 400, height: 300 });
        temporary.document.body.style.backgroundColor = '#203040';
        temporary.document.body.addEventListener('click', () => temporary.close());
        temporary.close();
        await delay(12);
        check(temporary.closed && !second.closed, 'repeated create/close preserves the shared host');
    }
    let replacement;
    second.onclose = () => {
        replacement = window.create({ title: 'PollyUI replacement', width: 400, height: 300 });
        replacement.document.body.style.backgroundColor = '#e09020';
    };
    second.close();
    await until(() => replacement && replacement.document.body.offsetWidth > 0);
    check(second.closed && replacement && !replacement.closed, 'last-window close callback can create a replacement');
    replacement.capture(prefix + '-replacement.png');
    window.quit();
    check(replacement.closed, 'quit closes every remaining window');
    rejects(() => window.create({}), 'quit prevents reopening the session');
    console.log('PASS: shared-runtime multi-window suite complete');
}

run().catch(error => {
    console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
    window.quit();
});
