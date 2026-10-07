import { validateTheme } from './desktop/shell/theme-schema.mjs';

export function isLunaSchemaRejection(failure) {
  return failure?.code === 'ERR_APPEARANCE_SCHEMA_REJECTED' && failure.appearanceSchema === 2 &&
    ['Unsupported appearance schema', 'Unsupported or out-of-range appearance data'].includes(failure.compositorMessage);
}

export function genericAppearance(theme) {
  return validateTheme({ ...theme,
    window: { ...theme.window, surfaceStyle: 'generic' },
    button: { ...theme.button, surfaceStyle: 'generic' },
    panel: { ...theme.panel, surfaceStyle: 'generic' },
  });
}
