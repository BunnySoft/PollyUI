const root = new URL('../../', import.meta.url);

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('./desktop/') || specifier.startsWith('./js/'))
    return nextResolve(new URL(specifier, root).href, context);
  return nextResolve(specifier, context);
}
