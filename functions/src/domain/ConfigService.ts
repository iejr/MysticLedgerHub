import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

export interface TokenMetadata {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  type: 'native' | 'erc20';
  chains: Record<string, { address?: string }>;
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
  wallets: WalletMetadata[];
}

export interface ChainMetadata {
  name: string;
  nativeSymbol: string;
  averageBlockTime: number;
  startBlock: number;
  explorerUrl: string;
}

export class ConfigService {
  private tokenConfig: AppConfig;
  private walletConfig: WalletConfig;
  private chainConfig: Record<string, ChainMetadata>;

  constructor() {
    // Load tokens
    const tokensPath = path.resolve(process.cwd(), 'src/config/tokens.yaml');
    const tokensFile = fs.readFileSync(tokensPath, 'utf8');
    this.tokenConfig = yaml.load(tokensFile) as AppConfig;

    // Load wallets
    const walletsPath = path.resolve(process.cwd(), 'src/config/wallets.yaml');
    const walletsFile = fs.readFileSync(walletsPath, 'utf8');
    this.walletConfig = yaml.load(walletsFile) as WalletConfig;

    // Load chains
    const chainsPath = path.resolve(process.cwd(), 'src/config/chains.yaml');
    const chainsFile = fs.readFileSync(chainsPath, 'utf8');
    this.chainConfig = yaml.load(chainsFile) as Record<string, ChainMetadata>;
  }

  getTokensForChain(chain: string): TokenMetadata[] {
    const chainConfig = this.tokenConfig.chains[chain.toLowerCase()];
    if (!chainConfig) return [];

    return this.tokenConfig.tokens.filter(token => 
      chainConfig.allowlist.includes(token.id) && token.chains[chain.toLowerCase()]
    );
  }

  getTokenById(id: string): TokenMetadata | undefined {
    return this.tokenConfig.tokens.find(t => t.id === id);
  }

  // Wallet Methods
  getWallets(): WalletMetadata[] {
    return this.walletConfig.wallets;
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
    return this.chainConfig[chain.toLowerCase()];
  }
}
