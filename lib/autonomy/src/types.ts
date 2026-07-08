export interface SpendPermission {
  id: string;
  userId: string;
  chainId?: number;
  asset?: string;
  signerAddress?: string;
  limit: number;
  spent: number;
  whitelist: string[];
  expiresAt: number;
  isActive: boolean;
}

export interface Call {
  to: string;
  data?: string;
  value?: string;
}
