import { createFileTextApp } from './desktop/client/file-dialog-example.mjs';

createFileTextApp({ initialDirectory: application.arguments.find(value => value !== '--theme') || null,
  optInTheme: application.arguments.includes('--theme') }).start();
