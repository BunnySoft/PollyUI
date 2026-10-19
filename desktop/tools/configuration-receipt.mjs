import { isDeepStrictEqual } from 'node:util';

export function configurationLabel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !isDeepStrictEqual(Object.keys(value).sort(), [
        'schemaVersion', 'name', 'configSha256', 'nativeVariantInputSha256', 'planSha256',
        'packageRequestSha256', 'lockSha256', 'nativeVariant', 'capabilities', 'stableAliasEligible',
      ].sort()) || value.schemaVersion !== 1 ||
      typeof value.name !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value.name) ||
      !['configSha256', 'nativeVariantInputSha256', 'planSha256', 'packageRequestSha256', 'lockSha256']
        .every(key => typeof value[key] === 'string' && /^[0-9a-f]{64}$/.test(value[key])) ||
      value.nativeVariant !== 'standard-effects4' || typeof value.stableAliasEligible !== 'boolean')
    throw new Error('Invalid configuration identity');
  return value.name + '-' + value.planSha256.slice(0, 12);
}
