import { createTargetApp } from './desktop/installer/target-app.mjs';

// No provider exists in the installed runtime yet. Do not launch a helper from
// user arguments, infer privileges from Live credentials or enumerate host disks.
createTargetApp({ optInTheme: application.arguments.includes('--theme') }).start();
