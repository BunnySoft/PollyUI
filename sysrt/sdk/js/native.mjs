import { open, platform, libc } from 'sysrt:ffi';

export function loadBindings(configuration) {
  if (!configuration || typeof configuration !== 'object' ||
      Array.isArray(configuration) || !configuration.functions ||
      typeof configuration.functions !== 'object' || Array.isArray(configuration.functions) ||
      Object.keys(configuration).some(key => !['library', 'functions'].includes(key)))
    throw new TypeError('Native bindings require a library and function descriptions');
  const name = typeof configuration.library === 'string' ?
    configuration.library : configuration.library?.[libc];
  if (typeof name !== 'string' || !name)
    throw new Error('Native library configuration is missing for ' + platform + '/' + libc);
  const library = open(name), functions = new Map();
  let closed = false;
  try {
    for (const [key, description] of Object.entries(configuration.functions)) {
      if (!description || typeof description.symbol !== 'string' || !Array.isArray(description.parameters))
        throw new TypeError('Invalid native function description: ' + key);
      if (Object.keys(description).some(field => !['symbol', 'result', 'parameters', 'abi'].includes(field)))
        throw new TypeError('Unsupported native function metadata: ' + key);
      functions.set(key, library.bind(description.symbol, {
        result: description.result, parameters: description.parameters,
        ...(description.abi === undefined ? {} : { abi: description.abi }),
      }));
    }
  } catch (error) {
    for (const function_ of functions.values()) function_.close();
    library.close();
    throw error;
  }
  return {
    call(name, ...args) {
      if (closed) throw new Error('Native bindings are closed');
      const function_ = functions.get(name);
      if (!function_) throw new Error('Unknown native binding: ' + name);
      return function_(...args);
    },
    close() {
      if (closed) return;
      for (const function_ of functions.values()) function_.close();
      library.close();
      closed = true;
    },
  };
}
