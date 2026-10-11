globalThis.settingsProbeHost = {
  close: () => window.close(),
  create: options => window.create({ ...options, width: 640, height: 520 }),
};
await import('./desktop/tests/settings-probe.mjs');
