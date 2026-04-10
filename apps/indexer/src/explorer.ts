export function resolveExplorerApiUrl(params: {
  chainId: number;
  bscScanApiUrl?: string;
  baseScanApiUrl?: string;
  etherscanApiUrl?: string;
  defaultApiUrl?: string;
  preferMultichainApi?: boolean;
  hasBscScanApiKey?: boolean;
  hasBaseScanApiKey?: boolean;
  hasEtherscanApiKey?: boolean;
}) {
  const bscScanApiUrl = params.bscScanApiUrl?.trim();
  const baseScanApiUrl = params.baseScanApiUrl?.trim();
  const etherscanApiUrl = params.etherscanApiUrl?.trim();
  const defaultApiUrl = params.defaultApiUrl?.trim();
  const hasBscScanApiKey = params.hasBscScanApiKey ?? false;
  const hasBaseScanApiKey = params.hasBaseScanApiKey ?? false;
  const hasEtherscanApiKey = params.hasEtherscanApiKey ?? false;

  if ((params.preferMultichainApi || hasEtherscanApiKey) && etherscanApiUrl) {
    return etherscanApiUrl;
  }

  if (params.chainId === 56) {
    if (bscScanApiUrl) {
      return bscScanApiUrl;
    }
    if (hasBscScanApiKey && defaultApiUrl) {
      return defaultApiUrl;
    }
  }

  if (params.chainId === 8453) {
    if (baseScanApiUrl) {
      return baseScanApiUrl;
    }
    if (hasBaseScanApiKey && defaultApiUrl) {
      return defaultApiUrl;
    }
  }

  return etherscanApiUrl || bscScanApiUrl || baseScanApiUrl || defaultApiUrl || "https://api.etherscan.io/v2/api";
}

export function explorerApiNeedsChainId(apiUrl: string) {
  return /\/v2\/api(?:\?|$)/i.test(apiUrl);
}

export function explorerApiUsesPostQueryParams(apiUrl: string) {
  return explorerApiNeedsChainId(apiUrl);
}

export function explorerUsesLegacyConstructorArgKey(apiUrl: string) {
  return /(bscscan\.com|basescan\.org)\/api(?:\?|$)/i.test(apiUrl) && !explorerApiNeedsChainId(apiUrl);
}

export function withExplorerBaseParams(params: {
  apiUrl: string;
  apiKey?: string;
  chainId: number;
  query: Record<string, string>;
}) {
  const base: Record<string, string> = {
    apikey: params.apiKey ?? ""
  };

  if (explorerApiNeedsChainId(params.apiUrl)) {
    base.chainid = String(params.chainId);
  }

  return {
    ...base,
    ...params.query
  };
}

export function withExplorerVerificationParams(params: {
  apiUrl: string;
  apiKey?: string;
  chainId: number;
  query: Record<string, string>;
  constructorArguments: string;
}) {
  const query = withExplorerBaseParams({
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
    chainId: params.chainId,
    query: {
      ...params.query,
      constructorArguments: params.constructorArguments
    }
  });

  if (explorerUsesLegacyConstructorArgKey(params.apiUrl)) {
    query.constructorArguements = params.constructorArguments;
  }

  return query;
}
