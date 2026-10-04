import { h, render } from './js/reconciler.mjs';

export const CANDIDATE_LAYOUT = Object.freeze({ width: 360, height: 272, padding: 8, header: 20, preedit: 28, row: 32 });

export function createCandidateView({ host = window, engine = inputMethod } = {}) {
  let popup = null;
  function update() {
    const state = engine.state();
    if (!state.active || (!state.preedit && !state.candidates.length)) {
      if (popup && !popup.closed) popup.close();
      popup = null;
      return;
    }
    if (!popup || popup.closed) {
      popup = host.create({ title: 'PollyIME candidates', inputPopup: true,
        width: CANDIDATE_LAYOUT.width, height: CANDIDATE_LAYOUT.height });
    }
    const body = popup.document.body;
    Object.assign(body.style, { backgroundColor: '#f4f5f7', color: '#202735',
      padding: CANDIDATE_LAYOUT.padding, overflow: 'hidden' });
    render(h('view', { id: 'ime-panel', style: { flex: 1, overflow: 'hidden' } },
      h('view', { style: { height: CANDIDATE_LAYOUT.header, fontSize: 12, color: '#526076' } }, 'PollyIME'),
      h('view', { id: 'ime-preedit', style: { height: CANDIDATE_LAYOUT.preedit, fontSize: 16 } }, state.preedit),
      h('view', { style: { flex: 1, overflow: 'scroll' } }, ...state.candidates.map((candidate, index) =>
        h('view', { id: 'ime-candidate-' + index, role: 'button',
          style: { height: CANDIDATE_LAYOUT.row, flexShrink: 0, paddingLeft: 8, paddingRight: 8,
            flexDirection: 'row', alignItems: 'center', gap: 10,
            backgroundColor: index === state.selected ? '#245ac7' : '#f4f5f7',
            color: index === state.selected ? '#ffffff' : '#202735', fontSize: 16 },
          onClick() {
            if (engine.state().revision !== state.revision) { update(); return; }
            engine.choose(state.revision, index);
            update();
          },
        }, h('view', {}, candidate.text),
        candidate.comment ? h('view', { style: { fontSize: 12 } }, candidate.comment) : null)))),
    body);
  }
  return { update, close() { if (popup && !popup.closed) popup.close(); popup = null; } };
}
