import { createTargetApp } from './desktop/apps/installer/target-app.mjs';
import { createFixtureProvider } from './desktop/apps/installer/tests/fixtures.mjs';

createTargetApp({ provider: createFixtureProvider(), synthetic: true,
  optInTheme: application.arguments.includes('--theme') }).start();
