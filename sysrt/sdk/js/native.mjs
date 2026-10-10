import { open, platform, libc, architecture, pointerSize, longSize } from 'sysrt:ffi';
import { compileLayout } from './sysrt/sdk/js/memory.mjs';

export function loadBindings(configuration) {
  if (!configuration || typeof configuration !== 'object' ||
      Array.isArray(configuration) || !configuration.functions ||
      typeof configuration.functions !== 'object' || Array.isArray(configuration.functions) ||
      Object.keys(configuration).some(key => !['library', 'functions', 'layouts', 'target'].includes(key)))
    throw new TypeError('Native bindings require a library and function descriptions');
  if (configuration.target !== undefined) {
    const target = configuration.target;
    if (!target || typeof target !== 'object' || Array.isArray(target) ||
        Object.keys(target).some(key => !['architecture', 'pointerSize', 'longSize'].includes(key)) ||
        (target.architecture !== undefined && target.architecture !== architecture) ||
        (target.pointerSize !== undefined && target.pointerSize !== pointerSize) ||
        (target.longSize !== undefined && target.longSize !== longSize))
      throw new Error('Native configuration does not match the host ABI');
  }

  const layouts = new Map();
  if (configuration.layouts !== undefined) {
    if (!configuration.layouts || typeof configuration.layouts !== 'object' || Array.isArray(configuration.layouts))
      throw new TypeError('Native layouts must be an object');
    for (const [name, description] of Object.entries(configuration.layouts))
      layouts.set(name, compileLayout(description));
  }
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
      if (Object.keys(description).some(field => !['symbol', 'result', 'parameters', 'abi', 'variadic'].includes(field)))
        throw new TypeError('Unsupported native function metadata: ' + key);
      functions.set(key, library.bind(description.symbol, {
        result: description.result, parameters: description.parameters,
        ...(description.abi === undefined ? {} : { abi: description.abi }),
        ...(description.variadic === undefined ? {} : { variadic: description.variadic }),
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
    createRecord(name) {
      if (closed) throw new Error('Native bindings are closed');
      const layout = layouts.get(name);
      if (!layout) throw new Error('Unknown native layout: ' + name);
      return layout.create();
    },
    close() {
      if (closed) return;
      for (const function_ of functions.values()) function_.close();
      library.close();
      closed = true;
    },
  };
}

export function loadNativeApi(configuration) {
  const functions = Object.create(null);
  for (const binding of Object.values(configuration.functions)) {
    if (!binding || typeof binding.symbol !== 'string' ||
        ['createRecord', 'dispose'].includes(binding.symbol) || Object.hasOwn(functions, binding.symbol))
      throw new TypeError('Native API requires unique, non-reserved symbol names');
    functions[binding.symbol] = binding;
  }
  const bindings = loadBindings({ ...configuration, functions });
  return Object.freeze({
    ...Object.fromEntries(Object.keys(functions).map(symbol => [symbol, (...args) => bindings.call(symbol, ...args)])),
    createRecord: name => bindings.createRecord(name),
    dispose: () => bindings.close(),
  });
}
