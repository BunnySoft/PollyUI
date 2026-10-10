// gallery.mjs — every PollyUI / Naive UI-style component on one scrollable page.
//   Windowed:  pollyui gui/examples/playground/gallery.mjs   (wheel to scroll)
//   Snapshot:  pollyui --test gui/examples/playground/gallery.mjs  (build/win-clang/gallery.png — top)

import { ref, reactive, createApp, h } from './gui/sdk/js/vue.mjs';
import * as N from './gui/sdk/js/naive.mjs';
const { theme, useTheme, message, notification, loadingBar } = N;

const lbl = (t) => h('view', { style: { color: theme.textSecondary, fontSize: '13', fontWeight: '500' } }, t);
const row = (...kids) => h('view', { style: { flexDirection: 'row', gap: '12', alignItems: 'center', flexWrap: 'wrap' } }, ...kids.filter(Boolean));
const col = (...kids) => h('view', { style: { flexDirection: 'column', gap: '12' } }, ...kids.filter(Boolean));
const section = (title, ...items) => N.NCard({ title, width: 720 }, col(...items));

const App = {
  setup() {
    const s = {
      input: ref('PollyUI'), num: ref(3), sel: ref('b'), casc: ref([]), tree: ref(null), ac: ref(''),
      men: ref(''), date: ref(new Date(2024, 0, 15)), time: ref({ h: 9, m: 30, s: 0 }), color: ref('#2080f0'),
      slider: ref(60), sw1: ref(true), sw2: ref(false), chk: ref(true), radio: ref('a'), rate: ref(4),
      tags: ref(['vue', 'skia']), dyn: ref(['one']), transfer: ref(['b']), tab: ref('one'), step: ref(1),
      page: ref(2), menu: ref('home'), collapse: ref(['a']), nav: ref('intro'), dark: ref(false),
      modal: ref(false), drawer: ref(false), spin: ref(0),
    };
    const fmodel = reactive({ username: '', email: '', age: '' });
    const form = N.createForm(fmodel, {
      username: { required: true, message: 'Username is required' },
      email: { required: true, pattern: /^[^@]+@[^@]+\.[^@]+$/, message: 'Enter a valid email address' },
      age: { validator: (v) => (v === '' || Number(v) >= 18 ? true : 'Must be 18 or older') },
    });
    return () => {
      useTheme(s.dark.value ? 'dark' : 'light');
      document.body.style.backgroundColor = theme.body;
      const opts = (...v) => v.map(x => ({ value: x, label: x[0].toUpperCase() + x.slice(1) }));

      return h('view', { style: { width: '100%', height: '100%' } },
        h('view', { style: { height: '100%', overflow: 'scroll', padding: '24', gap: '20', flexDirection: 'column', backgroundColor: theme.body } },
          h('view', { style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' } },
            N.NGradientText({ from: '#6366f1', to: '#ec4899', fontSize: 30 }, 'PollyUI Component Gallery'),
            row(lbl('Dark'), N.NSwitch({ value: s.dark.value, onUpdate: v => s.dark.value = v }))),

          section('Typography & buttons',
            row(N.NTitle({ level: 3 }, 'Title'), N.NText({ strong: true }, 'strong'), N.NText({ type: 'success' }, 'success'), N.NText({ depth: 3 }, 'muted')),
            row(N.NButton({ type: 'primary' }, 'Primary'), N.NButton({ type: 'info' }, 'Info'), N.NButton({ type: 'warning' }, 'Warning'), N.NButton({ type: 'error' }, 'Error'), N.NButton({}, 'Default'), N.NButton({ type: 'primary', ghost: true }, 'Ghost'), N.NButton({ type: 'primary', round: true }, 'Round'), N.NButton({ disabled: true }, 'Disabled')),
            row(N.NButtonGroup({}, N.NButton({}, 'Left'), N.NButton({}, 'Mid'), N.NButton({}, 'Right')), N.NIcon({ size: 22, color: theme.warning }, '★'), N.NIcon({ size: 22, color: theme.info }, '◆'))),

          section('Tags, avatars, badges',
            row(N.NTag({ type: 'success' }, 'stable'), N.NTag({ type: 'info', round: true }, 'v1'), N.NTag({ type: 'warning' }, 'beta'), N.NTag({ type: 'error' }, 'eol'), N.NTag({}, 'default')),
            row(N.NAvatar({ color: '#2080f0' }, 'AC'), N.NAvatar({ color: '#18a058' }, 'BD'), N.NAvatarGroup({ size: 36, max: 3 }, N.NAvatar({ color: '#f0a020' }, 'C'), N.NAvatar({ color: '#d03050' }, 'D'), N.NAvatar({ color: '#6366f1' }, 'E'), N.NAvatar({ color: '#999' }, 'F')),
              N.NBadge({ value: 8 }, N.NButton({}, 'Inbox')), N.NBadge({ dot: true }, N.NButton({}, 'Alerts')))),

          section('Form inputs',
            row(N.NInput({ id: 'galleryInput', value: s.input.value, onInput: v => s.input.value = v, width: 200 }),
              N.NInputNumber({ value: s.num.value, onUpdate: v => s.num.value = v }),
              N.NSelect({ value: s.sel.value, onUpdate: v => s.sel.value = v, width: 160, options: opts('apple', 'banana', 'cherry').map((o, i) => ({ value: ['a', 'b', 'c'][i], label: o.label })) })),
            row(N.NCascader({ value: s.casc.value, onUpdate: v => s.casc.value = v, options: [{ value: 'asia', label: 'Asia', children: [{ value: 'cn', label: 'China' }, { value: 'jp', label: 'Japan' }] }] }),
              N.NTreeSelect({ value: s.tree.value, onUpdate: v => s.tree.value = v, options: [{ key: 'a', label: 'Group', children: [{ key: 'a1', label: 'Item 1' }] }] }),
              N.NAutoComplete({ value: s.ac.value, onInput: v => s.ac.value = v, options: ['Alpha', 'Beta', 'Gamma'], placeholder: 'Auto-complete', width: 160 })),
            row(N.NDatePicker({ value: s.date.value, onUpdate: v => s.date.value = v }),
              N.NTimePicker({ value: s.time.value, onUpdate: v => s.time.value = v }),
              N.NColorPicker({ value: s.color.value, onUpdate: v => s.color.value = v }),
              N.NMention({ value: s.men.value, onInput: v => s.men.value = v, options: ['alice', 'bob'], width: 180 })),
            row(lbl('Slider'), h('view', { style: { width: '180' } }, N.NSlider({ value: s.slider.value, onUpdate: v => s.slider.value = v, width: 180 })),
              lbl('Rate'), N.NRate({ value: s.rate.value, onUpdate: v => s.rate.value = v })),
            row(N.NSwitch({ value: s.sw1.value, onUpdate: v => s.sw1.value = v }), N.NCheckbox({ checked: s.chk.value, onChange: v => s.chk.value = v }, 'Subscribe'),
              N.NRadioGroup({ value: s.radio.value, onUpdate: v => s.radio.value = v, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }] })),
            row(N.NDynamicTags({ value: s.tags.value, onChange: v => s.tags.value = v, onAdd: () => s.tags.value = s.tags.value.concat('tag' + s.tags.value.length) }))),

          section('Form validation',
            N.NForm({},
              N.NFormItem({ label: 'Username', form, path: 'username' }, N.NInput({ id: 'fmUser', value: fmodel.username, onInput: v => fmodel.username = v, width: 280 })),
              N.NFormItem({ label: 'Email', form, path: 'email' }, N.NInput({ id: 'fmEmail', value: fmodel.email, onInput: v => fmodel.email = v, width: 280 })),
              N.NFormItem({ label: 'Age', form, path: 'age' }, N.NInput({ id: 'fmAge', value: fmodel.age, onInput: v => fmodel.age = v, width: 280 })),
              row(N.NButton({ type: 'primary', onClick: () => { if (form.validate()) N.message.success('Form submitted!', 2000); } }, 'Validate & submit'),
                N.NButton({ onClick: () => { form.clearValidation(); fmodel.username = ''; fmodel.email = ''; fmodel.age = ''; } }, 'Reset')))),

          section('Static table',
            N.NTable({ bordered: true, striped: true,
              columns: [{ title: 'Package', key: 'pkg' }, { title: 'Version', key: 'ver', width: 120 }, { title: 'Size', key: 'size', width: 120, align: 'right' }],
              data: [{ pkg: 'skia', ver: 'm123', size: '8.2 MB' }, { pkg: 'quickjs-ng', ver: '0.9.0', size: '1.1 MB' }, { pkg: 'yoga', ver: '3.1.0', size: '420 KB' }] })),

          section('Data display',
            N.NDataTable({ columns: [{ title: 'Name', key: 'name' }, { title: 'Role', key: 'role', width: 120, render: u => N.NTag({ type: u.role === 'Admin' ? 'error' : 'info' }, u.role) }, { title: 'Score', key: 'score', width: 100, sortable: true }], onSort: () => {}, data: [{ name: 'Alice', role: 'Admin', score: 92 }, { name: 'Bob', role: 'Editor', score: 78 }] }),
            row(N.NStatistic({ label: 'Downloads', value: 12840, suffix: '/mo' }), N.NStatistic({ label: 'Uptime', value: 99.9, suffix: '%' }), N.NNumberAnimation({ value: 1234567 }), N.NCountdown({ value: 3725000, format: 'HH:MM:SS' })),
            row(N.NCode({}, 'const n = pollyui(view)'), N.NEllipsis({ width: 160 }, 'This text is too long to fit and will be truncated')),
            N.NProgress({ percentage: s.slider.value, width: 400 }),
            N.NTimeline({ items: [{ title: 'Created', time: 'Mon' }, { title: 'Shipped', type: 'success', time: 'Wed' }] })),

          section('Feedback',
            row(N.NAlert({ type: 'info', title: 'Heads up' }, 'An informational message.'), N.NAlert({ type: 'success', title: 'Done' }, 'Saved successfully.')),
            row(N.NSpin({ size: 28 }), N.NSkeleton({ rows: 2, width: 240 }), N.NResult({ status: 'success', title: 'Submitted' })),
            row(N.NButton({ onClick: () => message.success('Saved!', 2000) }, 'message'),
              N.NButton({ onClick: () => notification.info({ title: 'Update', content: 'A new version is available.', duration: 3000 }) }, 'notification'),
              N.NButton({ onClick: () => loadingBar.start() }, 'loadingBar'),
              N.NButton({ type: 'error', onClick: () => N.dialog.warning({ title: 'Delete file?', content: 'This action cannot be undone. Continue?', positiveText: 'Delete', negativeText: 'Cancel', onPositiveClick: () => message.success('Deleted', 1500), onNegativeClick: () => message.info('Cancelled', 1500) }) }, 'dialog'),
              N.NButton({ type: 'primary', onClick: () => s.modal.value = true }, 'Modal'),
              N.NButton({ onClick: () => s.drawer.value = true }, 'Drawer'),
              N.NPopconfirm({ title: 'Delete this?', onConfirm: () => message.success('deleted', 1500) }, N.NButton({ type: 'error' }, 'Popconfirm')),
              N.NPopover({ content: 'Popover content here', trigger: 'click' }, N.NButton({}, 'Popover')))),

          section('Navigation & layout',
            N.NTabs({ value: s.tab.value, onUpdate: v => s.tab.value = v, panes: [{ name: 'one', label: 'Profile', content: h('view', { style: { color: theme.textSecondary, fontSize: '14' } }, 'Profile pane') }, { name: 'two', label: 'Settings', content: h('view', { style: { color: theme.textSecondary, fontSize: '14' } }, 'Settings pane') }] }),
            N.NSteps({ current: s.step.value, steps: [{ title: 'Cart' }, { title: 'Pay' }, { title: 'Done' }] }),
            row(N.NPagination({ page: s.page.value, pageCount: 5, onUpdate: v => s.page.value = v })),
            N.NBreadcrumb({ items: [{ label: 'Home' }, { label: 'Docs' }, { label: 'Components' }] }),
            N.NDivider({}, 'Collapse'),
            N.NCollapse({ value: s.collapse.value, onUpdate: v => s.collapse.value = v, items: [{ name: 'a', title: 'What is PollyUI?', content: 'A cross-platform UI framework.' }, { name: 'b', title: 'Is it reactive?', content: 'Yes — Vue-style reactivity.' }] }))),

        // overlays
        N.NModal({ show: s.modal.value, title: 'Modal', width: 360, onClose: () => s.modal.value = false },
          h('view', { style: { color: theme.textSecondary, fontSize: '14' } }, 'A centered dialog over a dim backdrop.'),
          row(N.NButton({ type: 'primary', onClick: () => s.modal.value = false }, 'OK'))),
        N.NDrawer({ show: s.drawer.value, title: 'Drawer', width: 320, onClose: () => s.drawer.value = false },
          h('view', { style: { color: theme.textSecondary, fontSize: '14' } }, 'A panel sliding in from the right.'),
          N.NButton({ type: 'primary', onClick: () => s.drawer.value = false }, 'Close')),
        N.NOverlayHost());
    };
  },
};

createApp(App).mount(document.body);

if (typeof host !== 'undefined') {
  document.body.style.width = '100%';
  document.body.style.height = '100%';
  host.render();
  host.save('build/win-clang/gallery.png');
  // scroll the page and snapshot the lower sections too
  host.scroll(400, 300, 560); host.render(); host.save('build/win-clang/gallery2.png');
  host.scroll(400, 300, 560); host.render(); host.save('build/win-clang/gallery3.png');
  host.scroll(400, 300, 560); host.render(); host.save('build/win-clang/gallery4.png');
  console.log('gallery rendered without errors; wrote gallery.png + gallery2/3/4.png');
}
