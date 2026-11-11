import { createHash } from 'node:crypto';
import { RISK_SCAN_VERSION, type Address, type ContractScan, type RiskFlag, type TriState } from '@doomscout/domain';
import { ResilientHttpClient, type FetchLike, type ResilienceOptions } from './resilient.js';

interface RpcResponse<T> { jsonrpc: '2.0'; id: number; result?: T; error?: { code: number; message: string } }
const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

export class JsonRpcAdapter {
  private readonly client: ResilientHttpClient;
  private nextId = 1;
  constructor(private readonly url: string, options: ResilienceOptions, fetchImpl?: FetchLike) { this.client = new ResilientHttpClient('robinhood_rpc', { ...options, requestsPerMinute: Math.min(options.requestsPerMinute, 240) }, fetchImpl); }
  status() { return this.client.status(); }
  async call<T>(method: string, params: unknown[]): Promise<T> {
    const id = this.nextId++;
    const response = await this.client.json<RpcResponse<T>>(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }, `${method}:${JSON.stringify(params)}`);
    if (response.error) throw new Error(`RPC ${method} failed (${response.error.code})`);
    if (response.result === undefined) throw new Error(`RPC ${method} returned no result`);
    return response.result;
  }
  getCode(address: Address): Promise<string> { return this.call('eth_getCode', [address, 'latest']); }
  getStorageAt(address: Address, slot: string): Promise<string> { return this.call('eth_getStorageAt', [address, slot, 'latest']); }
  ethCall(address: Address, data: string): Promise<string> { return this.call('eth_call', [{ to: address, data }, 'latest']); }
  gasPrice(): Promise<string> { return this.call('eth_gasPrice', []); }

  async validateContract(address: Address): Promise<boolean> { const code = await this.getCode(address); return code !== '0x' && code !== '0x0'; }

  private async callOptional(address: Address, selector: string): Promise<string | null> { try { const result = await this.ethCall(address, selector); return result === '0x' ? null : result; } catch { return null; } }

  async metadata(address: Address): Promise<{ name: string | null; symbol: string | null; decimals: number | null; totalSupply: string | null }> {
    const [name, symbol, decimals, supply] = await Promise.all([this.callOptional(address, '0x06fdde03'), this.callOptional(address, '0x95d89b41'), this.callOptional(address, '0x313ce567'), this.callOptional(address, '0x18160ddd')]);
    return { name: decodeAbiString(name), symbol: decodeAbiString(symbol), decimals: decodeUint(decimals), totalSupply: decodeUintString(supply) };
  }

  async scanContract(chainId: number, address: Address): Promise<ContractScan> {
    const scannedAt = new Date().toISOString();
    let code: string;
    try { code = await this.getCode(address); } catch {
      return { version: RISK_SCAN_VERSION, chainId, address, scannedAt, codeHash: null, codeSize: null, isContract: 'unknown', metadata: { name: null, symbol: null, decimals: null, totalSupply: null }, flags: staticFlags('', scannedAt, 'unknown') };
    }
    if (code === '0x' || code === '0x0') return { version: RISK_SCAN_VERSION, chainId, address, scannedAt, codeHash: null, codeSize: 0, isContract: 'not_detected', metadata: { name: null, symbol: null, decimals: null, totalSupply: null }, flags: [{ code: 'not_contract', label: 'No contract code', state: 'detected', severity: 'hard_fail', confidence: 100, explanation: 'eth_getCode returned no runtime bytecode; this address is not currently a token contract.', evidence: [{ source: 'robinhood_rpc', observedAt: scannedAt, detail: 'eth_getCode=0x' }] }] };
    const metadata = await this.metadata(address);
    const ownerRaw = await this.callOptional(address, '0x8da5cb5b');
    let proxyState: TriState = 'not_detected';
    try { const slot = await this.getStorageAt(address, EIP1967_IMPLEMENTATION_SLOT); if (slot && !/^0x0+$/.test(slot)) proxyState = 'detected'; } catch { proxyState = 'unknown'; }
    const flags = staticFlags(code, scannedAt, proxyState);
    if (ownerRaw) {
      const owner = `0x${ownerRaw.slice(-40)}`;
      flags.push({ code: 'nonzero_owner', label: 'Readable non-zero owner', state: /^0x0+$/.test(owner) ? 'not_detected' : 'detected', severity: 'warning', confidence: 95, explanation: 'A readable owner may retain privileged controls. Review verified source and admin capabilities.', evidence: [{ source: 'robinhood_rpc', observedAt: scannedAt, detail: `owner()=${owner}` }] });
    } else flags.push({ code: 'owner_status', label: 'Owner status', state: 'unknown', severity: 'info', confidence: 0, explanation: 'owner() was not readable. This does not prove ownership is renounced.', evidence: [{ source: 'robinhood_rpc', observedAt: scannedAt, detail: 'owner() unavailable or reverted' }] });
    return { version: RISK_SCAN_VERSION, chainId, address, scannedAt, codeHash: createHash('sha256').update(code).digest('hex'), codeSize: Math.max(0, (code.length - 2) / 2), isContract: 'detected', metadata, flags };
  }
}

function decodeUint(value: string | null): number | null { if (!value) return null; try { const parsed = BigInt(value); return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null; } catch { return null; } }
function decodeUintString(value: string | null): string | null { if (!value) return null; try { return BigInt(value).toString(); } catch { return null; } }
function decodeAbiString(value: string | null): string | null {
  if (!value || value === '0x') return null;
  try {
    const hex = value.slice(2);
    if (hex.length === 64) return Buffer.from(hex, 'hex').toString('utf8').replace(/\0+$/g, '') || null;
    const offset = Number.parseInt(hex.slice(0, 64), 16) * 2;
    const length = Number.parseInt(hex.slice(offset, offset + 64), 16) * 2;
    return Buffer.from(hex.slice(offset + 64, offset + 64 + length), 'hex').toString('utf8').split('').filter((character) => character.charCodeAt(0) >= 32).join('').slice(0, 128) || null;
  } catch { return null; }
}

const SIGNATURES: Array<[string, string, string]> = [
  ['blacklist_selector', 'Blacklist controls', 'f9f92be4'], ['pause_selector', 'Pause controls', '8456cb59'], ['mint_selector', 'Mint function', '40c10f19'],
  ['max_wallet_selector', 'Max-wallet controls', 'da90a3e9'], ['max_tx_selector', 'Max-transaction controls', '8c1f58e4'], ['trading_toggle_selector', 'Trading-enable controls', '8a8c523c']
];
export function containsExecutableOpcode(code: string, opcode: number): boolean {
  const normalized = code.toLowerCase().replace(/^0x/, '');
  if (!normalized || normalized.length % 2 !== 0) return false;
  let bytes = Buffer.from(normalized, 'hex');
  // Solidity appends CBOR metadata plus a two-byte length. It is data rather
  // than executable code and otherwise creates convincing opcode false hits.
  if (bytes.length >= 4) {
    const metadataLength = bytes.readUInt16BE(bytes.length - 2);
    const metadataStart = bytes.length - metadataLength - 2;
    if (metadataStart > 0 && metadataStart < bytes.length - 2 && bytes[metadataStart]! >= 0xa0 && bytes[metadataStart]! <= 0xbf) bytes = bytes.subarray(0, metadataStart);
  }
  for (let index = 0; index < bytes.length;) {
    const current = bytes[index]!;
    if (current === opcode) return true;
    index += current >= 0x60 && current <= 0x7f ? current - 0x5f + 1 : 1;
  }
  return false;
}

function staticFlags(code: string, observedAt: string, proxyState: TriState): RiskFlag[] {
  const normalized = code.toLowerCase().replace(/^0x/, '');
  const delegatecall = containsExecutableOpcode(code, 0xf4);
  const selfdestruct = containsExecutableOpcode(code, 0xff);
  const txOrigin = containsExecutableOpcode(code, 0x32);
  const flags: RiskFlag[] = SIGNATURES.map(([flagCode, label, selector]) => ({ code: flagCode, label, state: normalized ? (normalized.includes(selector) ? 'detected' : 'not_detected') : 'unknown', severity: 'warning', confidence: normalized.includes(selector) ? 65 : 25, explanation: 'Static selector matching is a heuristic. Presence needs source review; absence does not prove the capability is absent.', evidence: [{ source: 'robinhood_rpc_bytecode', observedAt, detail: normalized.includes(selector) ? `selector 0x${selector} present` : normalized ? `selector 0x${selector} not observed` : 'bytecode unavailable' }] }));
  flags.push({ code: 'proxy', label: 'Upgradeable proxy', state: proxyState, severity: 'warning', confidence: proxyState === 'detected' ? 90 : proxyState === 'not_detected' ? 60 : 0, explanation: 'EIP-1967 implementation storage was checked. Other proxy patterns may not be recognized.', evidence: [{ source: 'robinhood_rpc_storage', observedAt, detail: `EIP-1967 implementation slot: ${proxyState}` }] });
  flags.push({ code: 'delegatecall_opcode', label: 'Delegatecall opcode', state: normalized ? (delegatecall ? 'detected' : 'not_detected') : 'unknown', severity: 'warning', confidence: delegatecall ? 70 : 35, explanation: 'Instruction-aware runtime scanning skips pushed constants and compiler metadata. Presence still requires source review.', evidence: [{ source: 'robinhood_rpc_bytecode', observedAt, detail: delegatecall ? 'executable DELEGATECALL (0xf4) observed' : normalized ? 'no executable DELEGATECALL observed' : 'bytecode unavailable' }] });
  flags.push({ code: 'selfdestruct_opcode', label: 'Self-destruct opcode', state: normalized ? (selfdestruct ? 'detected' : 'not_detected') : 'unknown', severity: 'warning', confidence: selfdestruct ? 70 : 35, explanation: 'Instruction-aware runtime scanning skips pushed constants and compiler metadata. Presence is a warning, not an audit finding.', evidence: [{ source: 'robinhood_rpc_bytecode', observedAt, detail: selfdestruct ? 'executable SELFDESTRUCT (0xff) observed' : normalized ? 'no executable SELFDESTRUCT observed' : 'bytecode unavailable' }] });
  flags.push({ code: 'tx_origin_opcode', label: 'tx.origin usage', state: normalized ? (txOrigin ? 'detected' : 'not_detected') : 'unknown', severity: 'warning', confidence: txOrigin ? 70 : 35, explanation: 'Instruction-aware runtime scanning skips pushed constants and compiler metadata. Source review is still required.', evidence: [{ source: 'robinhood_rpc_bytecode', observedAt, detail: txOrigin ? 'executable ORIGIN (0x32) observed' : normalized ? 'no executable ORIGIN observed' : 'bytecode unavailable' }] });
  flags.push({ code: 'tax_fee_controls', label: 'Mutable transfer tax / fee', state: 'unknown', severity: 'warning', confidence: 0, explanation: 'Runtime bytecode alone cannot reliably establish every mutable transfer-fee implementation. Quotes and verified-source review are required.', evidence: [{ source: 'robinhood_rpc_bytecode', observedAt, detail: 'No authoritative tax simulator or verified source finding available' }] });
  flags.push({ code: 'pool_concentration', label: 'Pool / holder concentration', state: 'unknown', severity: 'warning', confidence: 0, explanation: 'No reliable credential-free holder/pool concentration observation was available for this scan.', evidence: [{ source: 'blockchain_data', observedAt, detail: 'Concentration evidence unavailable' }] });
  return flags;
}
