import { createCandidateView } from './desktop/input-method/view.mjs';

const [sharedData = '/usr/share/rime-data', schema = 'luna_pinyin_simp'] = application.arguments;
const view = createCandidateView();
inputMethod.onchange = view.update;
inputMethod.start(sharedData, application.dataDir, schema);
window.close();
view.update();
