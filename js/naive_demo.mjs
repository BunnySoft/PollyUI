// naive_demo.mjs — a Vue app from Naive UI-style components: dark mode, tabs,
// select dropdown, tooltip, form validation, and a modal.
//   Windowed:  pollyui js/naive_demo.mjs
//   Snapshot:  pollyui --test js/naive_demo.mjs  (build/win-clang/naive*.png)

import { ref, createApp, h } from './js/vue.mjs';
import {
  NCard, NButton, NSwitch, NTag, NInput, NSpace, NTabs, NCheckbox, NRadioGroup,
  NSlider, NProgress, NAlert, NModal, NSelect, NTooltip, NFormItem, NOverlayHost,
  validateField, theme, useTheme,
} from './js/naive.mjs';

const label = (t) => h('view', { style: { color: theme.text, fontSize: '14', fontWeight: '500' } }, t);

const App = {
  setup() {
    const dark = ref(false);
    const tab = ref('profile');
    const name = ref('PollyUI');
    const team = ref('core');
    const role = ref('admin');
    const notify = ref(true);
    const brightness = ref(70);
    const showModal = ref(false);

    const nameError = () => validateField(name.value, [{ required: true, message: 'Name is required' }, { min: 2, message: 'At least 2 characters' }]);

    return () => {
      useTheme(dark.value ? 'dark' : 'light');
      document.body.style.backgroundColor = theme.body;

      const profile = () => NSpace({ vertical: true, size: 'large' },
        NFormItem({ label: 'Project name', required: true, error: nameError() },
          NInput({ value: name.value, onInput: v => name.value = v, width: 380 })),
        NSpace({ vertical: true, size: 'small' },
          NSpace({ size: 'small', align: 'center' }, label('Team'),
            NTooltip({ content: 'Which team owns this project', placement: 'bottom' },
              h('view', { style: { width: '16', height: '16', borderRadius: '8', backgroundColor: theme.border, alignItems: 'center', justifyContent: 'center' } },
                h('view', { style: { color: theme.textSecondary, fontSize: '11' } }, '?')))),
          NSelect({ id: 'teamSelect', value: team.value, onUpdate: v => team.value = v, width: 380,
            options: [{ value: 'core', label: 'Core' }, { value: 'design', label: 'Design' }, { value: 'platform', label: 'Platform' }] })),
        NSpace({ vertical: true, size: 'small' }, label('Role'),
          NRadioGroup({ value: role.value, onUpdate: v => role.value = v,
            options: [{ value: 'admin', label: 'Admin' }, { value: 'editor', label: 'Editor' }, { value: 'viewer', label: 'Viewer' }] })),
        NCheckbox({ checked: notify.value, onChange: v => notify.value = v }, 'Email notifications'));

      const display = () => NSpace({ vertical: true, size: 'large' },
        NSpace({ vertical: true, size: 'small' }, label('Brightness'),
          NSlider({ value: brightness.value, onUpdate: v => brightness.value = v, width: 380 }),
          NProgress({ percentage: brightness.value, width: 380 })),
        NAlert({ type: 'info', title: 'Tip' }, 'Drag the slider or click the track to adjust.'));

      return h('view', { style: { width: '100%', height: '100%' } },
        h('view', { style: { padding: '40' } },
          NCard({ title: 'Settings', width: 480 },
            NSpace({ justify: 'space-between', align: 'center' },
              NSpace({ size: 'small' }, NTag({ type: 'success' }, 'stable'), NTag({ type: 'info', round: true }, 'v1')),
              NSpace({ size: 'small', align: 'center' }, label('Dark'), NSwitch({ id: 'darkSwitch', value: dark.value, onUpdate: v => dark.value = v }))),

            NTabs({ value: tab.value, onUpdate: v => tab.value = v,
              panes: [{ name: 'profile', label: 'Profile', content: profile },
                      { name: 'display', label: 'Display', content: display }] }),

            NSpace({ justify: 'flex-end' },
              NButton({ onClick: () => showModal.value = true }, 'About'),
              NButton({ type: 'primary', disabled: !!nameError(), onClick: () => name.value = 'Saved!' }, 'Save')))),

        NModal({ show: showModal.value, title: 'About PollyUI', width: 360, onClose: () => showModal.value = false },
          h('view', { style: { color: theme.textSecondary, fontSize: '14' } },
            'A cross-platform UI framework: JS + Flexbox + Skia, with a Vue-style reactivity layer and Naive UI-flavored components.'),
          NSpace({ justify: 'flex-end' }, NButton({ type: 'primary', onClick: () => showModal.value = false }, 'Got it'))),

        NOverlayHost());
    };
  },
};

createApp(App).mount(document.body);

if (typeof host !== 'undefined') {
  document.body.style.width = '100%';
  document.body.style.height = '100%';
  host.render();
  host.save('build/win-clang/naive.png');                 // light
  const teamSel = document.getElementById('teamSelect');
  host.click(teamSel.offsetLeft + 20, teamSel.offsetTop + 17);  // open the Team dropdown
  host.save('build/win-clang/naive-select.png');          // dropdown open (portal layer)
  console.log('wrote naive.png + naive-select.png');
}
