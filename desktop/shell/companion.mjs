import { h, render } from './gui/sdk/js/reconciler.mjs';
import { createBoundedAnimation } from './desktop/shared/ui/animation.mjs';
import { companionPreferences, companionPosition, companionInput } from './desktop/shared/ui/companion.mjs';
import { companionAtlas, companionMasks } from './desktop/resources/companions/polly-rabbit.mjs';
import { bodyFont } from './desktop/shared/ui/body-font.mjs';
import { button } from './desktop/shared/ui/button.mjs';

const tips = ['Hello! I am Polly. Drag me to move; click me to wave.',
  'Alt+Tab switches windows. Hold Shift to switch in reverse.',
  'Desktop effects can be changed in Appearance Settings.'];

export function createDesktopCompanion({ host, native, theme, preferences, hide, report }) {
  let current = null, generation = 0, stopped = false, failure = '', tip = 0;
  function available() {
    return typeof native?.overlayActivityCapability === 'function' &&
      native.overlayActivityCapability() === true && typeof native.setOverlayInput === 'function';
  }
  function close(owner = current) {
    if (!owner) return;
    if (current === owner) current = null;
    generation++;
    owner.animation?.dispose();
    owner.removeState?.();
    if (!owner.window.closed) {
      owner.drag = null;
      if (owner.window.document.body.hasMouseCapture()) owner.window.document.body.releaseMouseCapture();
    }
    if (owner.watch !== null) {
      try { native.releaseBackground(owner.watch); }
      catch (error) { report('[shell] Cannot retire desktop companion activity: ' + String(error)); }
      owner.watch = null;
    }
    owner.image?.removeAttribute('src');
    if (owner.canvas) owner.canvas.width = owner.canvas.height = 0;
    if (!owner.window.closed) owner.window.close();
  }
  function fail(error) {
    close();
    failure = 'Desktop companion stopped: ' + String(error);
    report('[shell] ' + failure);
  }
  function live(owner) { return !stopped && current === owner && !owner.window.closed; }
  function input(owner) {
    if (!live(owner)) return;
    const rectangles = companionInput(companionMasks[owner.frame], owner.position, owner.bubble);
    const key = JSON.stringify(rectangles);
    if (key === owner.inputKey) return;
    native.setOverlayInput(owner.window, rectangles);
    owner.inputKey = key;
  }
  function frame(owner, index) {
    if (!live(owner) || !owner.ready) return;
    if (owner.frame === index && owner.paints > 0) return;
    owner.context.clearRect(0, 0, 96, 96);
    owner.context.imageSmoothingEnabled = false;
    owner.context.drawImage(owner.image, index * 96, 0, 96, 96, 0, 0, 96, 96);
    owner.frame = index;
    input(owner);
    owner.paints++;
  }
  function paint(owner) {
    if (!live(owner)) return;
    const state = owner.window.state;
    if (state.pixelWidth * state.pixelHeight > 16 * 1024 * 1024)
      throw new Error('Companion overlay exceeds the 16-megapixel backing limit');
    const currentTheme = theme();
    owner.position = companionPosition(owner.position.x, owner.position.y,
      state.width, state.height, currentTheme.panel.height + 20);
    const { x, y } = owner.position;
    const bubbleWidth = Math.min(240, state.width), bubbleHeight = 120;
    owner.bubble = owner.talking ? { x: Math.max(0, Math.min(state.width - bubbleWidth, x - bubbleWidth + 96)),
      y: Math.max(0, y - bubbleHeight - 8), width: bubbleWidth, height: bubbleHeight } : null;
    const bubble = owner.bubble;
    render(h('view', { id: 'shell-companion', style: { position: 'absolute', left: 0, top: 0,
      width: '100%', height: '100%', backgroundColor: 'transparent', pointerEvents: 'none' } },
    h('view', { id: 'shell-companion-sprite', role: 'button', 'aria-label': 'Polly rabbit. Drag to move, click to wave.',
      style: { position: 'absolute', left: x, top: y, width: 96, height: 96, pointerEvents: 'auto' } }),
    bubble ? h('view', { id: 'shell-companion-bubble', role: 'status', style: {
      position: 'absolute', left: bubble.x, top: bubble.y, width: bubble.width, height: bubble.height,
      backgroundColor: currentTheme.colors.body, borderWidth: 1, borderColor: currentTheme.colors.border,
      borderRadius: 8, padding: 10, gap: 8, pointerEvents: 'auto' } },
      h('view', { style: { ...bodyFont(currentTheme), fontSize: currentTheme.layout.fontSize,
        color: currentTheme.colors.text, flexShrink: 1 } }, tips[tip % tips.length]),
      h('view', { style: { flexDirection: 'row', gap: 8 } },
        button('shell-companion-next', 'Next tip', currentTheme, () => { tip++; paint(owner); }),
        button('shell-companion-hide', 'Hide', currentTheme, hide))) : null),
    owner.window.document.body);
    const mount = owner.window.document.getElementById('shell-companion-sprite');
    if (owner.canvas && owner.canvas.parentNode !== mount) mount.appendChild(owner.canvas);
    if (owner.ready) input(owner);
  }
  function cancelDrag(owner, restore = true) {
    if (!owner.drag) return;
    const drag = owner.drag;
    owner.drag = null;
    if (restore) owner.position = { x: drag.x, y: drag.y };
    const body = owner.window.document.body;
    if (body.hasMouseCapture()) body.releaseMouseCapture();
    paint(owner);
  }
  function wave(owner) {
    if (!owner.ready || !owner.active) return;
    owner.talking = !owner.talking;
    paint(owner);
    if (preferences().reducedMotion) { frame(owner, 0); return; }
    owner.actionStart = null;
    owner.action = 'wave';
    owner.animation.setState(true);
    owner.animation.invalidate();
  }
  function bind(owner) {
    const body = owner.window.document.body;
    const on = (name, callback) => body.addEventListener(name, event => {
      try { callback(event); } catch (error) { if (live(owner)) fail(error); }
    });
    function sprite(event) {
      for (let node = event.target; node && node !== body; node = node.parentNode)
        if (node.id === 'shell-companion-sprite') return true;
      return false;
    }
    on('mousedown', event => {
      if (!live(owner) || !owner.active || event.button !== 0 || !sprite(event)) return;
      event.preventDefault();
      owner.animation.setState(false);
      owner.drag = { x: owner.position.x, y: owner.position.y, px: event.clientX, py: event.clientY, moved: false };
      body.setMouseCapture();
    });
    on('mousemove', event => {
      if (!live(owner) || !owner.drag) return;
      const drag = owner.drag;
      drag.moved ||= Math.hypot(event.clientX - drag.px, event.clientY - drag.py) >= 4;
      if (!drag.moved) return;
      owner.position = companionPosition(drag.x + event.clientX - drag.px, drag.y + event.clientY - drag.py,
        owner.window.state.width, owner.window.state.height, theme().panel.height + 20);
      paint(owner);
    });
    on('mouseup', event => {
      if (!live(owner) || !owner.drag || event.button !== 0) return;
      const state = native.overlayActivity(owner.watch);
      if (state.retired || !state.active) { cancelDrag(owner); return; }
      const moved = owner.drag.moved;
      cancelDrag(owner, false);
      if (!moved) wave(owner);
    });
    for (const name of ['lostmousecapture', 'mousecancel'])
      on(name, () => { if (live(owner)) cancelDrag(owner); });
    on('contextmenu', event => {
      if (!live(owner) || !owner.active || !sprite(event)) return;
      event.preventDefault();
      owner.talking = !owner.talking;
      paint(owner);
    });
  }
  function activity() {
    const owner = current;
    if (!owner || owner.watch === null || !live(owner)) return;
    try {
      const state = native.backgroundActivity(owner.watch);
      if (state.retired) { close(owner); return; }
      owner.active = state.active;
      if (!state.active) {
        cancelDrag(owner);
        owner.animation?.setState(false);
        owner.action = 'idle';
      }
    } catch (error) { fail(error); }
  }
  function create(output) {
    const owner = { output: output.id, window: null, watch: null, image: null, canvas: null, frame: 0,
      position: { x: output.width - 120, y: output.height - 180 }, ready: false, active: false,
      talking: false, bubble: null, drag: null, action: 'idle', paints: 0, animation: null, removeState: null };
    owner.window = host.create({ title: 'PollyShell.companion.' + output.id, output: output.id,
      layer: 'overlay', width: 0, height: 0, anchors: ['top', 'bottom', 'left', 'right'],
      exclusiveZone: -1, keyboard: 'none', transparent: true });
    current = owner;
    owner.window.document.body.style.backgroundColor = 'transparent';
    native.setOverlayInput(owner.window, []);
    owner.window.onclose = () => { if (current === owner) close(owner); };
    const document = owner.window.document;
    owner.canvas = document.createElement('canvas');
    owner.canvas.width = owner.canvas.height = 96;
    Object.assign(owner.canvas.style, { width: '96', height: '96', pointerEvents: 'none' });
    owner.context = owner.canvas.getContext('2d');
    if (!owner.context) throw new Error('Companion requires Canvas 2D');
    owner.animation = createBoundedAnimation({ onError: fail, paint(time) {
      if (!live(owner) || !owner.ready || !owner.active) return;
      if (owner.actionStart === null) owner.actionStart = time;
      const elapsed = time - owner.actionStart;
      if (elapsed >= 1200) {
        owner.animation.setState(false);
        owner.action = 'idle';
        frame(owner, 0);
        return;
      }
      const next = 1 + Math.floor(elapsed / 120) % 3;
      if (next !== owner.frame) frame(owner, next);
    } });
    bind(owner);
    paint(owner);
    if (typeof owner.window.observeState === 'function')
      owner.removeState = owner.window.observeState(() => {
        if (!live(owner)) return;
        try { cancelDrag(owner); paint(owner); } catch (error) { fail(error); }
      });
    owner.image = document.createElement('img');
    owner.image.src = companionAtlas;
    const scope = generation;
    owner.image.decode().then(() => {
      if (!live(owner) || scope !== generation) return;
      if (owner.image.naturalWidth !== 768 || owner.image.naturalHeight !== 96)
        throw new Error('Original companion atlas dimensions do not match the input masks');
      owner.ready = true;
      frame(owner, 0);
      owner.watch = native.watchDesktopOverlay(owner.window);
      activity();
    }).catch(error => { if (live(owner) && scope === generation) fail(error); });
  }
  return Object.freeze({
    refresh() {
      if (stopped) return;
      const policy = companionPreferences(preferences());
      if (!policy.enabled) { close(); failure = ''; return; }
      if (failure) return;
      try {
        if (!available()) throw new Error('Owned overlay visibility/input capability is unavailable');
        const output = host.displays()[0];
        if (!output) { close(); return; }
        if (output.width < 240 || output.height < 240) throw new Error('Companion needs at least a 240x240 logical output');
        if (output.width * output.height * (output.scale ?? 1) ** 2 > 16 * 1024 * 1024)
          throw new Error('Companion overlay exceeds the 16-megapixel backing limit');
        if (current && (current.output !== output.id || current.window.closed)) close();
        if (!current) create(output);
        else {
          if (policy.reducedMotion) { current.animation.setState(false); current.action = 'idle'; frame(current, 0); }
          paint(current);
        }
      } catch (error) { fail(error); }
    },
    activity,
    reset() { close(); failure = ''; },
    stop() { stopped = true; close(); },
    snapshot() {
      return { ...companionPreferences(preferences()), available: available(),
        reason: available() ? '' : 'Desktop companions require owned overlay input and activity (session status v4).',
        error: failure };
    },
    getSurface: () => current,
  });
}
