import { createProcessProvider } from './desktop/apps/processes/logic/native-provider.mjs';
import { createProcessesApp } from './desktop/apps/processes/app.mjs';

let provider;
try { provider = createProcessProvider(); }
catch (error) { provider = { snapshot() { throw error; } }; }
createProcessesApp({ provider }).start();
