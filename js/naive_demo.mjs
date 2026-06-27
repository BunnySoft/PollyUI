// naive_demo.mjs — a Vue app built from Naive UI-style components, with a
// working dark-mode toggle, tabs, and a modal.
//   Windowed:  pollyui js/naive_demo.mjs
//   Snapshot:  pollyui --test js/naive_demo.mjs  (build/win-clang/naive.png)

import { ref, createApp, h } from './js/vue.mjs';
import {
  NCard, NButton, NSwitch, NTag, NInput, NSpace, NTabs, NCheckbox,
  NRadioGroup, NSlider, NProgress, NAlert, NModal, theme, useTheme,
} from './js/naive.mjs';

const label = (t) => h('view', { style: { color: theme.text, fontSize: '14', fontWeight: '500' } }, t);

const App = {
  setup() {
    const dark = ref(false);
    const tab = ref('profile');
    const name = ref('PollyUI');
    const role = ref('admin');
    const notify = ref(true);
    const brightness = ref(70);
    const showModal = ref(false);

    return () => {
      useTheme(dark.value ? 'dark' : 'light');
      document.body.style.backgroundColor = theme.body;

      const profile = () => NSpace({ vertical: true, size: 'large' },
        NSpace({ vertical: true, size: 'small' }, label('Project name'),
          NInput({ value: name.value, onInput: v => name.value = v, width: 380 })),
        NSpace({ vertical: true, size: 'small' }, label('Role'),
          NRadioGroup({
            value: role.value, onUpdate: v => role.value = v,
            options: [{ value: 'admin', label: 'Admin' }, { value: 'editor', label: 'Editor' }, { value: 'viewer', label: 'Viewer' }],
          })),
        NCheckbox({ checked: notify.value, onChange: v => notify.value = v }, 'Email notifications'));

      const display = () => NSpace({ vertical: true, size: 'large' },
        NSpace({ vertical: true, size: 'small' }, label('Brightness'),
          NSlider({ value: brightness.value, onUpdate: v => brightness.value = v, width: 380 }),
          NProgress({ percentage: brightness.value, width: 380 })),
        NAlert({ type: 'info', title: 'Tip' }, 'Drag the slider or click the track to adjust.'));

      return h('view', {},
        NCard({ title: 'Settings', width: 460 },
          NSpace({ justify: 'space-between', align: 'center' },
            NSpace({ size: 'small' }, NTag({ type: 'success' }, 'stable'), NTag({ type: 'info', round: true }, 'v1')),
            NSpace({ size: 'small', align: 'center' }, label('Dark'), NSwitch({ id: 'darkSwitch', value: dark.value, onUpdate: v => dark.value = v }))),

          NTabs({
            value: tab.value, onUpdate: v => tab.value = v,
            panes: [{ name: 'profile', label: 'Profile', content: profile },
                    { name: 'display', label: 'Display', content: display }],
          }),

          NSpace({ justify: 'flex-end' },
            NButton({ onClick: () => showModal.value = true }, 'About'),
            NButton({ type: 'primary', onClick: () => name.value = 'Saved!' }, 'Save'))),

        NModal({ show: showModal.value, title: 'About PollyUI', width: 360, onClose: () => showModal.value = false },
          h('view', { style: { color: theme.textSecondary, fontSize: '14' } },
            'A cross-platform UI framework: JS + Flexbox + Skia, with a Vue-style reactivity layer and Naive UI-flavored components.'),
          NSpace({ justify: 'flex-end' }, NButton({ type: 'primary', onClick: () => showModal.value = false }, 'Got it'))));
    };
  },
};

createApp(App).mount(document.body);

if (typeof host !== 'undefined') {
  // body must be sized so the absolute modal can cover it
  document.body.style.width = '100%';
  document.body.style.height = '100%';
  host.render();
  host.save('build/win-clang/naive.png');               // light
  const sw = document.getElementById('darkSwitch');
  host.click(sw.offsetLeft + 20, sw.offsetTop + 11);     // toggle dark mode
  host.render();
  host.save('build/win-clang/naive-dark.png');           // dark
  console.log('wrote build/win-clang/naive.png + naive-dark.png');
}
