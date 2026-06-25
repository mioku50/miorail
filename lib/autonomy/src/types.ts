export interface SpendPermission {
  id: string;
  userId: string;
  limit: number; // For simplicity, a numeric limit
  spent: number;
  whitelist: string[]; // List of allowed contract addresses
  expiresAt: number; // Timestamp
  isActive: boolean; // For kill-switch
}

export interface Call {
  to: string;
  data: string;
  value: string;
}
