// dashboard_demo.mjs — a data dashboard from Naive UI-style components.
//   Windowed:  pollyui js/dashboard_demo.mjs
//   Snapshot:  pollyui --test js/dashboard_demo.mjs  (build/win-clang/dashboard*.png)

import { ref, createApp, h } from './js/vue.mjs';
import {
  NCard, NButton, NSpace, NTag, NAvatar, NBadge, NDataTable, NPagination,
  NDatePicker, NDropdown, NOverlayHost, message, theme,
} from './js/naive.mjs';

const USERS = [
  { name: 'Alice Chen', role: 'Admin', status: 'active', color: '#2080f0', initials: 'AC' },
  { name: 'Bob Diaz', role: 'Editor', status: 'active', color: '#18a058', initials: 'BD' },
  { name: 'Carol Wu', role: 'Viewer', status: 'away', color: '#f0a020', initials: 'CW' },
  { name: 'Dan Park', role: 'Editor', status: 'active', color: '#d03050', initials: 'DP' },
];
const roleType = { Admin: 'error', Editor: 'info', Viewer: 'default' };

const App = {
  setup() {
    const page = ref(1);
    const date = ref(new Date(2024, 0, 15));

    return () => h('view', { style: { width: '100%', height: '100%' } },
      h('view', { style: { padding: '32', gap: '0' } },
        NCard({ title: 'Team Members', width: 700 },
          NSpace({ justify: 'space-between', align: 'center' },
            NSpace({ size: 'small', align: 'center' },
              h('view', { style: { color: theme.textSecondary, fontSize: '14' } }, 'As of'),
              NDatePicker({ id: 'dp', value: date.value, onUpdate: d => date.value = d, width: 160 })),
            NButton({ type: 'primary', onClick: () => message.success('Invite sent!', 0) }, '+ Invite')),

          NDataTable({
            columns: [
              { title: 'User', key: 'name', render: (u) => h('view', { style: { flexDirection: 'row', alignItems: 'center', gap: '10' } },
                  NAvatar({ size: 32, color: u.color }, u.initials),
                  h('view', { style: { color: theme.text, fontSize: '14' } }, u.name)) },
              { title: 'Role', key: 'role', width: 120, render: (u) => NTag({ type: roleType[u.role] }, u.role) },
              { title: 'Status', key: 'status', width: 120, render: (u) => NBadge({ dot: true },
                  h('view', { style: { color: theme.textSecondary, fontSize: '14', paddingRight: '4' } }, u.status)) },
              { title: '', key: 'x', width: 60, render: (u) => NDropdown({
                  options: [{ key: 'edit', label: 'Edit' }, { key: 'remove', label: 'Remove' }], width: 130,
                  onSelect: (k) => message.info(`${k} ${u.name}`, 0) },
                  h('view', { id: u.initials === 'AC' ? 'rowMenu' : undefined, style: { width: '28', height: '28', borderRadius: '4', alignItems: 'center', justifyContent: 'center' } },
                    h('view', { style: { color: theme.textSecondary, fontSize: '18' } }, '⋯'))) },
            ],
            data: USERS,
          }),

          NSpace({ justify: 'space-between', align: 'center' },
            h('view', { style: { color: theme.textSecondary, fontSize: '13' } }, `${USERS.length} members`),
            NPagination({ page: page.value, pageCount: 4, onUpdate: p => page.value = p }))),

        NOverlayHost()));
  },
};

createApp(App).mount(document.body);

if (typeof host !== 'undefined') {
  document.body.style.width = '100%';
  document.body.style.height = '100%';
  document.body.style.backgroundColor = '#f5f7fa';
  host.render();
  host.save('build/win-clang/dashboard.png');
  const menu = document.getElementById('rowMenu');
  host.click(menu.offsetLeft + 14, menu.offsetTop + 14);   // open a row action menu
  host.save('build/win-clang/dashboard-menu.png');
  console.log('wrote dashboard.png + dashboard-menu.png');
}
