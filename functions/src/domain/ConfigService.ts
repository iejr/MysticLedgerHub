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

export class ConfigService {
  private config: AppConfig;

  constructor(configPath?: string) {
    const resolvedPath = configPath || path.resolve(process.cwd(), 'src/config/tokens.yaml');
    const fileContents = fs.readFileSync(resolvedPath, 'utf8');
    this.config = yaml.load(fileContents) as AppConfig;
  }

  getTokensForChain(chain: string): TokenMetadata[] {
    const chainConfig = this.config.chains[chain.toLowerCase()];
    if (!chainConfig) return [];

    return this.config.tokens.filter(token => 
      chainConfig.allowlist.includes(token.id) && token.chains[chain.toLowerCase()]
    );
  }

  getTokenById(id: string): TokenMetadata | undefined {
    return this.config.tokens.find(t => t.id === id);
  }
}
