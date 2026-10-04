import { createCandidateView } from './desktop/input-method/view.mjs';

let popup;
const view = createCandidateView({ host: {
  create(options) { popup = window.create(options); return popup; },
} });
inputMethod.onchange = () => {
  const state = inputMethod.state();
  if (state.preedit === 'quit') { view.close(); window.quit(); return; }
  view.update();
  if (popup && !popup.closed && state.preedit === 'nihao')
    popup.document.body.style.backgroundColor = '#20cc40';
};
inputMethod.start(application.arguments[0], application.dataDir, application.arguments[1]);
window.close();
