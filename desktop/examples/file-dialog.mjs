import { createFileTextApp, parseFileTextArguments } from './desktop/client/file-dialog-example.mjs';

createFileTextApp(parseFileTextArguments(application.arguments)).start();
