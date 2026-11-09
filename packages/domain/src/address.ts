import { z } from 'zod';
import type { Address, PoolAddress } from './types.js';

export const evmAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address');
export const poolAddressSchema = z.string().regex(/^0x(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/, 'Invalid EVM pool identifier');

export function normalizeAddress(value: string): Address {
  return evmAddressSchema.parse(value).toLowerCase() as Address;
}

export function isEvmAddress(value: string): value is Address {
  return evmAddressSchema.safeParse(value).success;
}

export function normalizePoolAddress(value: string): PoolAddress {
  return poolAddressSchema.parse(value).toLowerCase() as PoolAddress;
}

export function isPoolAddress(value: string): value is PoolAddress {
  return poolAddressSchema.safeParse(value).success;
}
