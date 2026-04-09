import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

export interface TokenMetadata {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  type: "native" | "erc20";
  source: "system" | "uniswap";
  chains: Record<string, { address?: string; decimals?: number }>;
}

export interface ChainConfig {
  allowlist: string[];
}

export interface AppConfig {
  tokens: TokenMetadata[];
  chains: Record<string, ChainConfig>;
}

export interface WalletMetadata {
  address: string;
  label: string;
  chains?: string[];
}

export interface GlobalConfig {
  chains: string[];
  includeUsd: boolean;
}

export interface WalletConfig {
  global: GlobalConfig;
  auxiliaryAddresses: WalletMetadata[];
  wallets: WalletMetadata[];
}

export interface ChainMetadata {
  /** Internal system ID — matches the YAML map key (e.g. "ethereum", "base") */
  id: string;
  /** Human-readable display name (e.g. "Ethereum Mainnet") */
  name: string;
  nativeSymbol: string;
  averageBlockTime: number;
  /** Whether block times are roughly uniform. When false, binary search is used instead of interpolation. Default true. */
  linearBlockTime: boolean;
  startBlock: number;
  explorerUrl: string;
  /** EVM network chain ID — optional, for reference/interop only */
  evmChainId?: number;
}

interface UniswapToken {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
}

export class ConfigService {
  private tokenConfig: AppConfig;
  private walletConfig: WalletConfig;
  private chainConfig: Record<string, ChainMetadata>;

  /** Full token database: system tokens + uniswap tokens, indexed by {chain}_{address} */
  private tokenIndex: Map<string, TokenMetadata> = new Map();
  /** Token database indexed by token ID */
  private tokenByIdIndex: Map<string, TokenMetadata> = new Map();
  /** Reverse map: evmChainId → internal chain ID */
  private evmChainIdToChain: Map<number, string> = new Map();

  constructor() {
    // Load chains
    const chainsPath = path.resolve(process.cwd(), 'src/config/chains.yaml');
    const chainsFile = fs.readFileSync(chainsPath, 'utf8');
    this.chainConfig = yaml.load(chainsFile) as Record<string, ChainMetadata>;

    // Build reverse evmChainId → internal chain ID map
    for (const [key, meta] of Object.entries(this.chainConfig)) {
      if (meta.evmChainId) {
        this.evmChainIdToChain.set(meta.evmChainId, key.toLowerCase());
      }
    }

    // Load tokens
    const tokensPath = path.resolve(process.cwd(), 'src/config/tokens.yaml');
    const tokensFile = fs.readFileSync(tokensPath, 'utf8');
    this.tokenConfig = yaml.load(tokensFile) as AppConfig;

    // Index system tokens (source of truth — wins over uniswap)
    for (const token of this.tokenConfig.tokens) {
      const entry: TokenMetadata = { ...token, source: 'system' };
      this.tokenByIdIndex.set(token.id, entry);
      for (const [chain, chainData] of Object.entries(token.chains)) {
        if (chainData.address) {
          this.tokenIndex.set(`${chain.toLowerCase()}_${chainData.address.toLowerCase()}`, entry);
        }
      }
    }

    // Load and index uniswap tokens
    this.loadUniswapTokens();

    // Load wallets
    const walletsPath = path.resolve(process.cwd(), 'src/config/wallets.yaml');
    const walletsFile = fs.readFileSync(walletsPath, 'utf8');
    this.walletConfig = yaml.load(walletsFile) as WalletConfig;
  }

  private loadUniswapTokens(): void {
    const uniswapPath = path.resolve(process.cwd(), 'tokens.uniswap.json');
    if (!fs.existsSync(uniswapPath)) return;

    const raw = JSON.parse(fs.readFileSync(uniswapPath, 'utf8'));
    const uniswapTokens: UniswapToken[] = raw.tokens || [];

    for (const ut of uniswapTokens) {
      const chain = this.evmChainIdToChain.get(ut.chainId);
      if (!chain) continue; // Skip unsupported chains

      const indexKey = `${chain}_${ut.address.toLowerCase()}`;
      if (this.tokenIndex.has(indexKey)) continue; // System token already registered

      const tokenId = `uniswap-${chain}-${ut.address.toLowerCase().slice(2, 10)}`;
      const entry: TokenMetadata = {
        id: tokenId,
        name: ut.name,
        symbol: ut.symbol,
        decimals: ut.decimals,
        type: 'erc20',
        source: 'uniswap',
        chains: { [chain]: { address: ut.address } },
      };

      this.tokenIndex.set(indexKey, entry);
      if (!this.tokenByIdIndex.has(tokenId)) {
        this.tokenByIdIndex.set(tokenId, entry);
      }
    }
  }

  // --- Token Database methods (full DB: system + uniswap) ---

  /** Check if a token is known in the full database (system + uniswap) */
  isKnownToken(chain: string, address: string): boolean {
    return this.tokenIndex.has(`${chain.toLowerCase()}_${address.toLowerCase()}`);
  }

  /** Look up a token by contract address from the full database */
  getTokenEntryByAddress(chain: string, address: string): TokenMetadata | undefined {
    return this.tokenIndex.get(`${chain.toLowerCase()}_${address.toLowerCase()}`);
  }

  /** Look up a token by ID from the full database */
  getTokenEntryById(id: string): TokenMetadata | undefined {
    return this.tokenByIdIndex.get(id);
  }

  // --- System token methods (curated tokens.yaml only) ---

  /** Returns only curated system tokens for the chain allowlist */
  getTokensForChain(chain: string): TokenMetadata[] {
    const chainConfig = this.tokenConfig.chains[chain.toLowerCase()];
    if (!chainConfig) return [];

    return this.tokenConfig.tokens.filter(token =>
      chainConfig.allowlist.includes(token.id) && token.chains[chain.toLowerCase()]
    ).map(t => ({ ...t, source: 'system' as const }));
  }

  /** Look up by ID from system tokens only */
  getTokenById(id: string): TokenMetadata | undefined {
    return this.tokenConfig.tokens.find(t => t.id === id);
  }

  // Wallet Methods
  getWallets(): WalletMetadata[] {
    return this.walletConfig.wallets;
  }

  getAuxiliaryAddresses(): WalletMetadata[] {
    return this.walletConfig.auxiliaryAddresses;
  }

  getGlobalChains(): string[] {
    return this.walletConfig.global.chains;
  }

  getGlobalIncludeUsd(): boolean {
    return this.walletConfig.global.includeUsd;
  }

  getWalletEffectiveChains(wallet: WalletMetadata): string[] {
    return wallet.chains || this.walletConfig.global.chains;
  }

  // Chain Methods
  getChainMetadata(chain: string): ChainMetadata | undefined {
    const key = chain.toLowerCase();
    const meta = this.chainConfig[key];
    if (!meta) return undefined;
    return { ...meta, id: key, linearBlockTime: meta.linearBlockTime ?? true };
  }

  /** Look up from system tokens only by contract address (legacy, prefer getTokenEntryByAddress) */
  getTokenByAddress(chain: string, address: string): TokenMetadata | undefined {
    const lowerAddr = address.toLowerCase();
    const lowerChain = chain.toLowerCase();
    return this.tokenConfig.tokens.find(t => {
      const chainEntry = t.chains[lowerChain];
      return chainEntry?.address?.toLowerCase() === lowerAddr;
    });
  }
}
