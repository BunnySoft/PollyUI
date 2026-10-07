import { h } from './js/reconciler.mjs';
import { NButton, lightTheme } from './js/naive.mjs';
import { selectable, formatBytes } from './desktop/installer/target-model.mjs';

const row = { flexDirection: 'row', gap: 8, flexWrap: 'wrap', flexShrink: 0 };
const phaseText = {
  unavailable: 'Native helper integration pending; no devices enumerated.',
  idle: 'Request a read-only report. No target is selected.',
  loading: 'Acquiring a read-only report. Previous evidence is not actionable.',
  ready: 'Report available. Explicitly select a qualified target; none is preselected.',
  selected: 'Review the selected identity and exact scope before acknowledging.',
  reidentifying: 'Re-identifying from a fresh report; this does not write or install.',
  confirmed: 'UI scope confirmation recorded only. No OS authorization or write occurred.',
  blocked: 'Hypothetical next step blocked. No writer or real authorization exists.',
  invalidated: 'Confirmation invalidated. Refresh, select and acknowledge again.',
  cancelled: 'Cancelled. Nothing was written. Refresh to retry.',
  error: 'Report failed. No target or confirmation is valid. Retry explicitly.',
  disposed: 'This view is closed; confirmation was discarded.',
};
function palette(pollyTheme) {
  const colors = pollyTheme?.colors;
  const bounded = (key, fallback) => /^#[0-9a-f]{6}$/i.test(colors?.[key]) ? colors[key] : fallback;
  return {
    text: bounded('text', lightTheme.text), muted: bounded('muted', lightTheme.textSecondary),
    surface: bounded('surface', lightTheme.card), background: bounded('body', lightTheme.body),
    border: bounded('border', lightTheme.border), accent: bounded('accent', lightTheme.info),
    focus: bounded('focus', lightTheme.info), warning: lightTheme.warning, error: lightTheme.error,
  };
}

export function targetView(state, controller, { pollyTheme = null, themeError = '', synthetic = false } = {}) {
  const colors = palette(pollyTheme);
  const generation = state.generation;
  const selection = state.selection;
  const label = (id, value, color = colors.text, size = 13) =>
    h('view', { id, style: { color, fontSize: size, flexShrink: 0 } }, value);
  const box = (id, ...children) => h('view', { id, style: {
    gap: 6, padding: 12, backgroundColor: colors.surface, borderWidth: 1,
    borderColor: colors.border, borderRadius: 3, flexShrink: 0,
  } }, children);
  function button(id, caption, action, enabled = true, pressed = false) {
    const activate = event => {
      if (!enabled || (event?.button !== undefined && event.button !== 0)) return;
      event?.stopPropagation?.(); return action();
    };
    const node = NButton({ id, size: 'small', disabled: !enabled, onClick: activate }, caption);
    Object.assign(node.props, {
      role: 'button', tabIndex: enabled ? 0 : -1, 'aria-label': caption,
      'aria-disabled': String(!enabled), 'aria-pressed': String(pressed),
      onKeydown: event => {
        if (enabled && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault(); return activate(event);
        }
      },
      hoverStyle: enabled ? { borderColor: colors.accent } : {},
      focusStyle: enabled ? { borderColor: colors.focus } : {},
    });
    Object.assign(node.props.style, { backgroundColor: colors.surface, color: colors.text,
      borderColor: pressed ? colors.accent : colors.border, flexShrink: 0 });
    return node;
  }
  const showReasons = (prefix, reasons) => reasons.map((reason, index) =>
    label(prefix + '-' + index, reason.code + ': ' + reason.message +
      (Object.hasOwn(reason, 'detail') ? ' | Evidence: ' + JSON.stringify(reason.detail) : ''), colors.error));
  const partitionRows = (prefix, parts) => parts.length ? parts.map((part, index) =>
    label(prefix + '-' + index, (part.path ?? 'Unknown path') + ' | ' +
      formatBytes(part.capacityBytes) + ' | start512=' + (part.startSector512 ?? 'Unknown') +
      ' | FS=' + (part.filesystem ?? 'Unknown') + ' | UUID=' + (part.uuid ?? 'Unknown') +
      ' | PARTUUID=' + (part.partuuid ?? 'Unknown') +
      ' | mounts=' + (part.mountpoints.length ? part.mountpoints.join(', ') : 'None reported'))) :
    [label(prefix + '-empty', 'No partitions reported (not proof of an empty disk).', colors.muted)];
  function targetDetails(entry, prefix) {
    const observation = entry.observation;
    return [
      label(prefix + '-model', (entry.model ?? 'Unknown model') + ' | ' + formatBytes(entry.capacityBytes), colors.text, 16),
      label(prefix + '-identity', 'Serial: ' + (entry.identity.serial ?? 'Missing') +
        ' | WWN: ' + (entry.identity.wwn ?? 'Missing') + ' | logical sector: ' +
        (entry.identity.logicalSectorBytes ?? 'Unknown') + ' bytes'),
      label(prefix + '-observation', 'Observed path: ' + (observation.path ?? 'Unknown') +
        ' | kernel ID: ' + (observation.majorMinor ?? 'Unknown') + ' | diskseq: ' +
        (observation.kernel?.diskseq ?? 'Unknown') + ' | transport: ' + (observation.transport ?? 'Unknown')),
      label(prefix + '-sysfs', 'Kernel path: ' + (observation.kernel?.sysfsPath ?? 'Unknown')),
      label(prefix + '-use', 'Current use/source: ' +
        (entry.reasons.filter(reason => ['mounted', 'in-use', 'active-root', 'active-boot', 'active-source',
          'active-ancestry-unknown', 'incomplete-context'].includes(reason.code)).map(reason => reason.code).join(', ') ||
          'No current use reported in this snapshot; no raw-opener/other-namespace proof.')),
      label(prefix + '-scope', 'HYPOTHETICAL WHOLE-DISK CLEAR: bytes [0, ' +
        (entry.clearingScope.endByteExclusive ?? 'Unknown') + ') (end exclusive), ' +
        (entry.clearingScope.partitionTable ?? 'unknown table') + ' table and ALL listed partitions; performed=false.',
      colors.error),
      ...partitionRows(prefix + '-partition', entry.partitions),
      ...showReasons(prefix + '-reason', entry.reasons),
    ];
  }
  const content = [
    label('installer-title', 'Installation target review (read-only)', colors.text, 20),
    box('installer-warning',
      label('installer-clearing-warning', 'WARNING: Whole-disk clearing would destroy the partition table and all existing disk data.', colors.error, 16),
      label('installer-no-authorization', 'This module NEVER writes. Eligibility and UI confirmation are NOT OS authorization or a private broker token.'),
      label('installer-live-password', 'The public Live root password grants NO target-write permission. A real disk/user gate remains required.'),
      label('installer-no-proof', 'USB corroboration is only a policy floor; no physical-media, exclusive-access, raw-opener or other mount-namespace proof.')),
    synthetic ? label('installer-synthetic', 'SYNTHETIC MOCK SNAPSHOTS ONLY - no real drive enumeration or installation evidence.', colors.warning) : null,
    label('installer-status', phaseText[state.phase] ?? 'Unknown state; no permission to write.', colors.muted),
    label('installer-generation', 'UI generation: ' + generation + ' | report generation: ' +
      (state.envelope?.generation ?? 'None') + ' | readOnly=true | writeAuthorized=false', colors.muted),
    ...showReasons('installer-state-reason', state.reasons),
    themeError ? label('installer-theme-error', 'Theme subscription error: ' + themeError, colors.error) : null,
    h('view', { style: row },
      button('installer-refresh', 'Refresh / retry read-only report', () => controller.refresh(generation),
        !['unavailable', 'disposed'].includes(state.phase)),
      button('installer-cancel', 'Cancel and discard confirmation', () => controller.cancel(generation),
        !['unavailable', 'disposed', 'cancelled'].includes(state.phase))),
  ];
  if (state.envelope) {
    const { source, report } = state.envelope;
    content.push(box('installer-source',
      label('installer-source-description', 'Installation source: ' + source.description + ' | kind=' + source.kind),
      label('installer-downloaded-bytes', 'Downloaded payload bytes: ' + formatBytes(source.downloadedBytes)),
      label('installer-memory-bytes', 'Memory logical payload bytes: ' + formatBytes(source.memoryLogicalBytes) + ' (not physical target capacity)'),
      label('installer-source-mapping', 'Exact source mapping: ' + source.exactSourceMapping +
        ' | supplied kernel basis: ' + (source.kernelBasis.join(', ') || 'Unknown') +
        ' | trusted native server integration is still pending.'),
      ...showReasons('installer-source-reason', source.reasons)));
    content.push(box('installer-capacity',
      label('installer-required-bytes', 'Measured layout requirement: ' + formatBytes(report.capacity.requiredBytes)),
      ...report.capacity.partitions.map(part => label('installer-capacity-' + part.name,
        part.name + ': payload ' + formatBytes(part.payloadBytes) + ' | planned ' + part.sizeMiB +
        ' MiB | reserve ' + part.reserveMiB + ' MiB | overhead ' + part.filesystemOverheadMiB + ' MiB')),
      ...showReasons('installer-report-error', report.errors),
      ...report.limitations.map((value, index) => label('installer-limit-' + index, value, colors.muted))));
    if (!source.exactSourceMapping)
      content.push(label('installer-source-blocked', 'Source storage is unknown/unmapped. Target selection and confirmation are disabled.', colors.error));
    if (!report.devices.length)
      content.push(label('installer-no-targets', 'No entries reported. No target is selected.', colors.muted));
    for (const [index, entry] of report.devices.entries()) {
      const prefix = 'installer-target-' + index;
      const enabled = ['ready', 'selected'].includes(state.phase) && selectable(state.envelope, entry);
      content.push(box(prefix, ...targetDetails(entry, prefix),
        label(prefix + '-eligibility', 'Reported eligible=' + entry.eligible + ' (NOT write permission)', colors.muted),
        button(prefix + '-select', selection?.entryId === entry.entryId ? 'Selected (explicit choice)' : 'Select this exact target',
          () => controller.select(entry.entryId, generation), enabled, selection?.entryId === entry.entryId)));
    }
  }
  if (selection) {
    const selectedEntry = state.envelope.report.devices.find(entry => entry.entryId === selection.entryId);
    content.push(box('installer-confirmation',
      label('installer-confirmation-title', 'Explicit clearing-scope acknowledgement', colors.text, 16),
      ...targetDetails(selectedEntry, 'installer-selected'),
      label('installer-consent-scope', 'Acknowledgement applies ONLY to the identity, partitions, source and exact byte range above.'),
      button('installer-acknowledge', state.scopeAcknowledged ? 'Acknowledged - click to uncheck' :
        'I understand ALL data on this disk would be cleared',
      () => controller.acknowledgeScope(generation, selection, !state.scopeAcknowledged),
      state.phase === 'selected', state.scopeAcknowledged),
      button('installer-confirm', 'Fresh re-identify and record UI confirmation (NO WRITE)',
        () => controller.confirm(generation, selection), state.phase === 'selected' && state.scopeAcknowledged),
      state.confirmation ? label('installer-confirmation-record', 'UI-only confirmation | acknowledged=' +
        state.confirmation.acknowledgedReportGeneration + ' | reidentified=' +
        state.confirmation.reidentifiedReportGeneration + ' | writeAuthorized=false | no authorization token', colors.muted) : null,
      state.confirmation ? button('installer-onward', 'Recheck hypothetical next step (NO WRITER)',
        () => controller.hypotheticalOnward(generation, state.confirmation), state.phase === 'confirmed') : null));
  }
  return h('view', { id: 'installer-root', style: {
    width: '100%', height: '100%', backgroundColor: colors.background, padding: 18,
    gap: 12, overflow: 'scroll', flexDirection: 'column',
  }, onKeydown: event => {
    if (event.key === 'Escape') { event.preventDefault(); controller.cancel(generation); }
  }, onWheel: event => {
    event.preventDefault();
    const node = event.currentTarget;
    const extent = node.childNodes.reduce((end, child) =>
      Math.max(end, child.offsetTop + child.offsetHeight - node.offsetTop), 0);
    node.scrollTop = Math.max(0, Math.min(Math.max(0, extent - node.offsetHeight),
      Number(node.scrollTop) + event.deltaY));
  } }, content);
}
