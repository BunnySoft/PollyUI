import { createTargetApp } from './desktop/installer/target-app.mjs';
import { createFixtureProvider } from './desktop/installer/fixtures.mjs';

createTargetApp({ provider: createFixtureProvider(), synthetic: true,
  optInTheme: application.arguments.includes('--theme') }).start();
