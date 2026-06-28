// shell_demo.mjs — an app shell: sidebar Menu + Steps + Collapse + Spin + Drawer.
//   Snapshot:  pollyui --test js/shell_demo.mjs  (build/win-clang/shell*.png)

import { ref, createApp, h } from './js/vue.mjs';
import {
  NMenu, NSteps, NCollapse, NSpin, NDrawer, NCard, NButton, NSpace, NTag, theme,
} from './js/naive.mjs';

const App = {
  setup() {
    const nav = ref('setup');
    const step = ref(1);
    const faq = ref(['a']);
    const drawer = ref(false);

    return () => h('view', { style: { width: '100%', height: '100%', flexDirection: 'row', backgroundColor: theme.body } },
      // sidebar
      h('view', { style: { width: '200', backgroundColor: theme.card, borderRightWidth: '0', padding: '12', gap: '14' } },
        h('view', { style: { flexDirection: 'row', alignItems: 'center', gap: '8', paddingLeft: '8', paddingTop: '6' } },
          h('view', { style: { width: '24', height: '24', borderRadius: '6', backgroundColor: theme.primary } }),
          h('view', { style: { color: theme.text, fontSize: '17', fontWeight: 'bold' } }, 'PollyUI')),
        NMenu({ value: nav.value, onUpdate: v => nav.value = v, items: [
          { key: 'setup', label: 'Getting started', icon: '◆' },
          { key: 'guide', label: 'Guide', icon: '▤' },
          { key: 'api', label: 'API', icon: '⌘' },
          { key: 'about', label: 'About', icon: '☰' },
        ] })),

      // main
      h('view', { style: { flexGrow: '1', padding: '32', gap: '24' } },
        h('view', { style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' } },
          h('view', { style: { color: theme.text, fontSize: '24', fontWeight: 'bold' } }, 'Getting started'),
          NButton({ type: 'primary', onClick: () => drawer.value = true }, 'Quick help')),

        NCard({ title: 'Install', width: 560 },
          NSteps({ current: step.value, steps: [{ title: 'Fetch deps' }, { title: 'Build' }, { title: 'Run' }] }),
          NSpace({ justify: 'flex-end' },
            NButton({ size: 'small', onClick: () => step.value = Math.max(0, step.value - 1) }, 'Back'),
            NButton({ size: 'small', type: 'primary', onClick: () => step.value = Math.min(2, step.value + 1) }, 'Next'))),

        NCard({ title: 'FAQ', width: 560 },
          NCollapse({ value: faq.value, onUpdate: v => faq.value = v, items: [
            { name: 'a', title: 'What is PollyUI?', content: 'A cross-platform UI framework: JS + Flexbox + Skia.' },
            { name: 'b', title: 'Which platforms?', content: 'Windows today; macOS and Linux are planned.' },
            { name: 'c', title: 'Is it reactive?', content: 'Yes — a Vue-style reactivity layer drives the reconciler.' },
          ] })),

        h('view', { style: { flexDirection: 'row', alignItems: 'center', gap: '12' } },
          NSpin({ size: 28 }),
          h('view', { style: { color: theme.textSecondary, fontSize: '14' } }, 'Checking for updates…'),
          NTag({ type: 'success' }, 'v1'))),

      NDrawer({ show: drawer.value, title: 'Quick help', width: 320, onClose: () => drawer.value = false },
        h('view', { style: { color: theme.textSecondary, fontSize: '14' } }, 'Run `tools\\build.ps1` then `pollyui js\\shell_demo.mjs`.'),
        NButton({ type: 'primary', onClick: () => drawer.value = false }, 'Got it')));
  },
};

createApp(App).mount(document.body);

if (typeof host !== 'undefined') {
  document.body.style.width = '100%'; document.body.style.height = '100%';
  host.render();
  host.save('build/win-clang/shell.png');
  host.click(520, 92);   // "Quick help" button -> open the drawer
  host.save('build/win-clang/shell-drawer.png');
  console.log('wrote shell.png + shell-drawer.png');
}
