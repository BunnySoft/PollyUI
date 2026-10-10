import { createFilesApp } from './desktop/apps/files/app.mjs';

const args = application.arguments;
if (args.length > 1) throw new Error('Files accepts at most one explicit absolute local directory path');
createFilesApp({ initialPath: args[0] ?? null }).start();
