const root = new URL('../../', import.meta.url);

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('./gui/sdk/js/') || specifier.startsWith('./desktop/') || specifier.startsWith('./sysrt/'))
    return nextResolve(new URL(specifier.slice(2), root).href, context);
  return nextResolve(specifier, context);
}
