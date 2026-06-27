// naive_demo.mjs — a Vue app built from Naive UI-style components.
//   Windowed:  pollyui js/naive_demo.mjs
//   Snapshot:  pollyui --test js/naive_demo.mjs  (build/win-clang/naive.png)

import { ref, createApp, h } from './js/vue.mjs';
import { NCard, NButton, NSwitch, NTag, NInput, NSpace, theme } from './js/naive.mjs';

document.body.style.backgroundColor = '#f5f7fa';
document.body.style.padding = '40';
document.body.style.alignItems = 'center';

const App = {
  setup() {
    const name = ref('PollyUI');
    const dark = ref(true);
    const notify = ref(false);

    return () => NCard({ title: 'Settings', width: 420 },
      NSpace({ vertical: true, size: 'large' },

        NSpace({ vertical: true, size: 'small' },
          h('view', { style: { color: theme.text, fontSize: '14', fontWeight: '500' } }, 'Project name'),
          NInput({ value: name.value, onInput: v => name.value = v, width: 380 })),

        NSpace({ justify: 'space-between', align: 'center' },
          h('view', { style: { color: theme.text, fontSize: '14' } }, 'Dark mode'),
          NSwitch({ value: dark.value, onUpdate: v => dark.value = v })),

        NSpace({ justify: 'space-between', align: 'center' },
          h('view', { style: { color: theme.text, fontSize: '14' } }, 'Email notifications'),
          NSwitch({ value: notify.value, onUpdate: v => notify.value = v })),

        NSpace({ size: 'small' },
          NTag({ type: 'success' }, 'stable'),
          NTag({ type: 'info', round: true }, 'v1'),
          NTag({ type: 'warning' }, 'beta')),

        NSpace({ justify: 'flex-end' },
          NButton({}, 'Cancel'),
          NButton({ type: 'primary', onClick: () => name.value = 'Saved!' }, 'Save'))));
  },
};

createApp(App).mount(document.body);

if (typeof host !== 'undefined') {
  host.render();
  host.save('build/win-clang/naive.png');
  console.log('wrote build/win-clang/naive.png');
}
