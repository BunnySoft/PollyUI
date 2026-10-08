import { createTargetApp } from './desktop/installer/target-app.mjs';
import { createNativeTargetProvider } from './desktop/installer/native-provider.mjs';

let provider = null;
if (application.arguments.includes('--readonly-provider')) {
  try {
    provider = createNativeTargetProvider(typeof desktop === 'undefined' ? null : desktop);
  } catch (error) {
    console.error('[installer] ' + error);
    // Preserve the ordinary error view instead of inventing a provider/report.
    provider = { readReport: async () => { throw error; } };
  }
}
createTargetApp({ provider, optInTheme: application.arguments.includes('--theme') }).start();
