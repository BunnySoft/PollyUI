import { fontFamilyStyle, requireFontFamily } from '../../../gui/sdk/js/font-family.mjs';

export const bodyFont = theme => fontFamilyStyle(theme?.layout?.fontFamily);
export function preflightBodyFont(theme) {
  requireFontFamily(theme?.layout?.fontFamily);
  return theme;
}
