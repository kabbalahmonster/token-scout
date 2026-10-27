import { z } from 'zod';
import type { Address } from './types.js';

export const evmAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address');

export function normalizeAddress(value: string): Address {
  return evmAddressSchema.parse(value).toLowerCase() as Address;
}

export function isEvmAddress(value: string): value is Address {
  return evmAddressSchema.safeParse(value).success;
}
