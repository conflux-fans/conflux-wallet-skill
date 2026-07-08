import { existsSync, readFileSync } from 'fs';
import { isAddress, getAddress } from 'viem';
import { LENDING_DATA_ABI } from './abis.js';

const BUILTIN_CONFIGS = {
  conflux: {
    chain: 'conflux',
    chainId: 1030,
    pool: 'general',
    controller: '0xA377eCF53253275125D0a150aF195186271f6a56',
    lendingData: '0x121F88625831702d02dcF93092E5247eca7b94f4',
    source: 'built-in',
  },
};

function normalizeAddress(address, label) {
  if (!isAddress(address)) {
    throw new Error(`Invalid ${label} address: ${address}`);
  }
  return getAddress(address);
}

function readLocalConfig(path) {
  if (!path || !existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return parsed.unitus ?? parsed;
}

function getLocalChainConfig(localConfig, chainName) {
  return localConfig[chainName] ?? localConfig.chains?.[chainName] ?? {};
}

export function getUnitusConfig(chainName, options = {}) {
  const normalizedChain = chainName.toLowerCase();
  const base = BUILTIN_CONFIGS[normalizedChain];
  if (!base) {
    throw new Error(`Unsupported Unitus chain: ${chainName}`);
  }

  const env = options.env ?? process.env;
  const localConfig = readLocalConfig(options.configPath ?? 'unitus.config.json');
  const localChain = getLocalChainConfig(localConfig, normalizedChain);
  const controller = env.UNITUS_CONFLUX_CONTROLLER ?? localChain.controller ?? base.controller;
  const lendingData = env.UNITUS_CONFLUX_LENDING_DATA ?? localChain.lendingData ?? base.lendingData;
  let source = 'built-in';
  if (localChain.controller || localChain.lendingData) source = 'local';
  if (env.UNITUS_CONFLUX_CONTROLLER || env.UNITUS_CONFLUX_LENDING_DATA) source = 'env';

  return {
    ...base,
    ...localChain,
    chain: normalizedChain,
    controller: normalizeAddress(controller, 'controller'),
    lendingData: normalizeAddress(lendingData, 'lendingData'),
    source,
  };
}

export function sameAddress(left, right) {
  return left?.toLowerCase() === right?.toLowerCase();
}

export async function validateUnitusConfig(client, config) {
  const lendingDataController = await client.readContract({
    address: config.lendingData,
    abi: LENDING_DATA_ABI,
    functionName: 'controller',
  });

  if (!sameAddress(lendingDataController, config.controller)) {
    throw new Error(
      `LendingData controller mismatch: ${lendingDataController} != ${config.controller}`,
    );
  }

  return {
    ...config,
    lendingDataController,
    valid: true,
  };
}
