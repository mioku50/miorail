import { randomUUID } from 'node:crypto';
import type { ConfirmedSettlementProof, SqlTemplateExecutor } from './repository';

export type AutonomyReservationStatus = 'reserved' | 'settled' | 'released' | 'expired';

export interface AutonomyPolicy {
  id: string;
  userId: string;
  chainId: number;
  walletAddress: string;
  dailyLimit: number;
  maxPerAction: number;
  spentToday: number;
  reservedToday: number;
  periodStartedAt: number;
  whitelist: string[];
  scope: string;
  expiresAt: number;
  isActive: boolean;
  killSwitch: boolean;
  mainnetOptIn: boolean;
}

export interface ConfigureAutonomyPolicyInput {
  userId: string;
  chainId: number;
  walletAddress: string;
  dailyLimit: number;
  maxPerAction: number;
  whitelist: string[];
  scope: string;
  expiresAt: number;
  mainnetOptIn: boolean;
}

export interface AutonomyExecutionReservation {
  id: string;
  policyId: string;
  userId: string;
  actionId: string;
  amount: number;
  status: AutonomyReservationStatus;
  expiresAt: number;
  proof?: ConfirmedSettlementProof;
}

export interface ReserveAutonomyInput {
  policyId: string;
  userId: string;
  actionId: string;
  amount: number;
  ttlMs?: number;
}

export interface AutonomyReservationResult {
  success: boolean;
  status: string;
  policy?: AutonomyPolicy;
  reservation?: AutonomyExecutionReservation;
  error?: string;
}

export interface AutonomyPolicyRepository {
  configure(input: ConfigureAutonomyPolicyInput): Promise<AutonomyPolicy>;
  getByUser(userId: string, chainId: number): Promise<AutonomyPolicy | undefined>;
  getById(id: string): Promise<AutonomyPolicy | undefined>;
  reserve(input: ReserveAutonomyInput): Promise<AutonomyReservationResult>;
  settle(actionId: string, proof: ConfirmedSettlementProof): Promise<AutonomyReservationResult>;
  release(actionId: string, reason?: string): Promise<AutonomyReservationResult>;
  setKillSwitch(policyId: string, enabled: boolean): Promise<AutonomyPolicy | undefined>;
}

const DEFAULT_RESERVATION_TTL_MS = 30 * 60_000;

function policyId(userId: string, chainId: number): string {
  return `autonomy:${chainId}:${userId}`;
}

function utcDayStart(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function clonePolicy(policy: AutonomyPolicy): AutonomyPolicy {
  return { ...policy, whitelist: [...policy.whitelist] };
}

function cloneReservation(reservation: AutonomyExecutionReservation): AutonomyExecutionReservation {
  return {
    ...reservation,
    ...(reservation.proof ? { proof: { ...reservation.proof } } : {}),
  };
}

export class InMemoryAutonomyPolicyRepository implements AutonomyPolicyRepository {
  private readonly policies = new Map<string, AutonomyPolicy>();
  private readonly reservations = new Map<string, AutonomyExecutionReservation>();

  async configure(input: ConfigureAutonomyPolicyInput): Promise<AutonomyPolicy> {
    validatePolicyInput(input);
    const id = policyId(input.userId, input.chainId);
    const existing = this.policies.get(id);
    for (const reservation of this.reservations.values()) {
      if (reservation.policyId === id && reservation.status === 'reserved') {
        reservation.status = 'released';
      }
    }
    const today = utcDayStart();
    const sameDay = existing && existing.periodStartedAt >= today;
    const policy: AutonomyPolicy = {
      id,
      userId: input.userId,
      chainId: input.chainId,
      walletAddress: input.walletAddress.toLowerCase(),
      dailyLimit: input.dailyLimit,
      maxPerAction: input.maxPerAction,
      spentToday: sameDay ? existing.spentToday : 0,
      reservedToday: 0,
      periodStartedAt: sameDay ? existing.periodStartedAt : today,
      whitelist: input.whitelist.map((address) => address.toLowerCase()),
      scope: input.scope,
      expiresAt: input.expiresAt,
      isActive: true,
      killSwitch: false,
      mainnetOptIn: input.mainnetOptIn,
    };
    this.policies.set(id, policy);
    return clonePolicy(policy);
  }

  async getByUser(userId: string, chainId: number): Promise<AutonomyPolicy | undefined> {
    return this.getById(policyId(userId, chainId));
  }

  async getById(id: string): Promise<AutonomyPolicy | undefined> {
    const policy = this.policies.get(id);
    if (!policy) return undefined;
    this.resetPeriod(policy);
    this.expireReservations(policy);
    return clonePolicy(policy);
  }

  async reserve(input: ReserveAutonomyInput): Promise<AutonomyReservationResult> {
    if (!Number.isFinite(input.amount) || input.amount < 0) {
      return { success: false, status: 'invalid_amount', error: 'Invalid autonomy reservation amount' };
    }
    if (input.ttlMs !== undefined && (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0)) {
      return { success: false, status: 'invalid_reservation_ttl', error: 'Reservation TTL must be greater than zero' };
    }
    const existing = this.reservations.get(input.actionId);
    if (existing) {
      const policy = this.policies.get(existing.policyId);
      if (
        existing.policyId === input.policyId &&
        existing.userId === input.userId &&
        existing.amount === input.amount &&
        existing.status === 'reserved' &&
        existing.expiresAt > Date.now() &&
        policy
      ) {
        return { success: true, status: 'reserved', policy: clonePolicy(policy), reservation: cloneReservation(existing) };
      }
      return { success: false, status: 'reservation_conflict', error: 'Action already has a different autonomy reservation' };
    }

    const policy = this.policies.get(input.policyId);
    if (!policy || policy.userId !== input.userId) return { success: false, status: 'missing_policy', error: 'Autonomy policy not found' };
    this.resetPeriod(policy);
    this.expireReservations(policy);
    const failure = policyFailure(policy, input.amount);
    if (failure) return { success: false, ...failure, policy: clonePolicy(policy) };

    const reservation: AutonomyExecutionReservation = {
      id: randomUUID(),
      policyId: policy.id,
      userId: input.userId,
      actionId: input.actionId,
      amount: input.amount,
      status: 'reserved',
      expiresAt: Date.now() + (input.ttlMs ?? DEFAULT_RESERVATION_TTL_MS),
    };
    policy.reservedToday += input.amount;
    this.reservations.set(input.actionId, reservation);
    return { success: true, status: 'reserved', policy: clonePolicy(policy), reservation: cloneReservation(reservation) };
  }

  async settle(actionId: string, proof: ConfirmedSettlementProof): Promise<AutonomyReservationResult> {
    if (!hasDurableProof(proof)) return { success: false, status: 'missing_proof', error: 'Durable settlement proof required' };
    const reservation = this.reservations.get(actionId);
    if (!reservation) return { success: false, status: 'missing_reservation', error: 'Autonomy reservation not found' };
    const policy = this.policies.get(reservation.policyId);
    if (!policy) return { success: false, status: 'missing_policy', error: 'Autonomy policy not found' };
    if (reservation.status === 'settled') {
      return { success: true, status: 'settled', policy: clonePolicy(policy), reservation: cloneReservation(reservation) };
    }
    if (reservation.status === 'reserved') {
      policy.reservedToday = Math.max(0, policy.reservedToday - reservation.amount);
    }
    policy.spentToday += reservation.amount;
    reservation.status = 'settled';
    reservation.proof = { ...proof };
    return { success: true, status: 'settled', policy: clonePolicy(policy), reservation: cloneReservation(reservation) };
  }

  async release(actionId: string): Promise<AutonomyReservationResult> {
    const reservation = this.reservations.get(actionId);
    if (!reservation) return { success: true, status: 'missing_reservation' };
    const policy = this.policies.get(reservation.policyId);
    if (reservation.status === 'reserved' && policy) {
      policy.reservedToday = Math.max(0, policy.reservedToday - reservation.amount);
      reservation.status = 'released';
    }
    return {
      success: true,
      status: reservation.status,
      ...(policy ? { policy: clonePolicy(policy) } : {}),
      reservation: cloneReservation(reservation),
    };
  }

  async setKillSwitch(id: string, enabled: boolean): Promise<AutonomyPolicy | undefined> {
    const policy = this.policies.get(id);
    if (!policy) return undefined;
    policy.killSwitch = enabled;
    policy.isActive = !enabled;
    if (enabled) {
      for (const reservation of this.reservations.values()) {
        if (reservation.policyId === id && reservation.status === 'reserved') reservation.status = 'released';
      }
      policy.reservedToday = 0;
    }
    return clonePolicy(policy);
  }

  private resetPeriod(policy: AutonomyPolicy): void {
    const today = utcDayStart();
    if (policy.periodStartedAt >= today) return;
    policy.periodStartedAt = today;
    policy.spentToday = 0;
    policy.reservedToday = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.policyId === policy.id && reservation.status === 'reserved') reservation.status = 'expired';
    }
  }

  private expireReservations(policy: AutonomyPolicy): void {
    const now = Date.now();
    for (const reservation of this.reservations.values()) {
      if (reservation.policyId !== policy.id || reservation.status !== 'reserved' || reservation.expiresAt > now) continue;
      reservation.status = 'expired';
      policy.reservedToday = Math.max(0, policy.reservedToday - reservation.amount);
    }
  }
}

export function createDatabaseAutonomyPolicyRepository(sql: SqlTemplateExecutor): AutonomyPolicyRepository {
  async function expireReservations(id: string): Promise<void> {
    await sql`
      WITH expired AS (
        UPDATE autonomy_execution_reservations
        SET status = 'expired', updated_at = now()
        WHERE policy_id = ${id}
          AND status = 'reserved'
          AND expires_at <= now()
        RETURNING amount
      ), totals AS (
        SELECT COALESCE(SUM(amount), 0) AS amount FROM expired
      )
      UPDATE autonomy_policies
      SET reserved_today = GREATEST(0, reserved_today - totals.amount), updated_at = now()
      FROM totals
      WHERE id = ${id} AND totals.amount > 0
    `;
  }

  async function resetPeriod(id: string): Promise<void> {
    await sql`
      WITH reset_policy AS (
        UPDATE autonomy_policies
        SET spent_today = 0,
            reserved_today = 0,
            period_started_at = date_trunc('day', now()),
            updated_at = now()
        WHERE id = ${id}
          AND period_started_at < date_trunc('day', now())
        RETURNING id
      )
      UPDATE autonomy_execution_reservations
      SET status = 'expired', updated_at = now()
      WHERE policy_id IN (SELECT id FROM reset_policy)
        AND status = 'reserved'
    `;
  }

  async function getById(id: string): Promise<AutonomyPolicy | undefined> {
    await resetPeriod(id);
    await expireReservations(id);
    const rows = await sql`
      SELECT id, user_id, chain_id, wallet_address, daily_limit, max_per_action,
             spent_today, reserved_today, period_started_at, whitelist, scope,
             expires_at, is_active, kill_switch, mainnet_opt_in
      FROM autonomy_policies
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows[0] ? rowToPolicy(rows[0]) : undefined;
  }

  async function getReservation(actionId: string): Promise<AutonomyExecutionReservation | undefined> {
    const rows = await sql`
      SELECT id, policy_id, user_id, action_id, amount, status, proof, expires_at
      FROM autonomy_execution_reservations
      WHERE action_id = ${actionId}
      LIMIT 1
    `;
    return rows[0] ? rowToReservation(rows[0]) : undefined;
  }

  return {
    async configure(input): Promise<AutonomyPolicy> {
      validatePolicyInput(input);
      const id = policyId(input.userId, input.chainId);
      await sql`
        WITH released AS (
          UPDATE autonomy_execution_reservations
          SET status = 'released', updated_at = now()
          WHERE policy_id = ${id} AND status = 'reserved'
          RETURNING amount
        )
        INSERT INTO autonomy_policies (
          id, user_id, chain_id, wallet_address, daily_limit, max_per_action,
          spent_today, reserved_today, period_started_at, whitelist, scope,
          expires_at, is_active, kill_switch, mainnet_opt_in, created_at, updated_at
        )
        VALUES (
          ${id}, ${input.userId}, ${input.chainId}, ${input.walletAddress.toLowerCase()},
          ${input.dailyLimit}, ${input.maxPerAction}, 0, 0, date_trunc('day', now()),
          CAST(${JSON.stringify(input.whitelist.map((address) => address.toLowerCase()))} AS jsonb),
          ${input.scope}, ${new Date(input.expiresAt)}, true, false, ${input.mainnetOptIn}, now(), now()
        )
        ON CONFLICT (user_id, chain_id) DO UPDATE SET
          wallet_address = EXCLUDED.wallet_address,
          daily_limit = EXCLUDED.daily_limit,
          max_per_action = EXCLUDED.max_per_action,
          spent_today = CASE
            WHEN autonomy_policies.period_started_at < date_trunc('day', now()) THEN 0
            ELSE autonomy_policies.spent_today
          END,
          reserved_today = 0,
          period_started_at = CASE
            WHEN autonomy_policies.period_started_at < date_trunc('day', now()) THEN date_trunc('day', now())
            ELSE autonomy_policies.period_started_at
          END,
          whitelist = EXCLUDED.whitelist,
          scope = EXCLUDED.scope,
          expires_at = EXCLUDED.expires_at,
          is_active = true,
          kill_switch = false,
          mainnet_opt_in = EXCLUDED.mainnet_opt_in,
          updated_at = now()
      `;
      const configured = await getById(id);
      if (!configured) throw new Error('Autonomy policy was not persisted');
      return configured;
    },

    async getByUser(userId, chainId): Promise<AutonomyPolicy | undefined> {
      return getById(policyId(userId, chainId));
    },

    getById,

    async reserve(input): Promise<AutonomyReservationResult> {
      if (!Number.isFinite(input.amount) || input.amount < 0) {
        return { success: false, status: 'invalid_amount', error: 'Invalid autonomy reservation amount' };
      }
      if (input.ttlMs !== undefined && (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0)) {
        return { success: false, status: 'invalid_reservation_ttl', error: 'Reservation TTL must be greater than zero' };
      }
      await resetPeriod(input.policyId);
      await expireReservations(input.policyId);
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_RESERVATION_TTL_MS));
      const rows = await sql`
        WITH candidate AS (
          INSERT INTO autonomy_execution_reservations (
            id, policy_id, user_id, action_id, amount, status, expires_at, created_at, updated_at
          )
          VALUES (${id}, ${input.policyId}, ${input.userId}, ${input.actionId}, ${input.amount}, 'reserved', ${expiresAt}, now(), now())
          ON CONFLICT (action_id) DO NOTHING
          RETURNING id
        ), updated_policy AS (
          UPDATE autonomy_policies
          SET reserved_today = reserved_today + ${input.amount}, updated_at = now()
          WHERE id = ${input.policyId}
            AND user_id = ${input.userId}
            AND EXISTS (SELECT 1 FROM candidate)
            AND is_active = true
            AND kill_switch = false
            AND (chain_id <> 8453 OR mainnet_opt_in = true)
            AND expires_at > now()
            AND ${input.amount} <= max_per_action
            AND spent_today + reserved_today + ${input.amount} <= daily_limit
          RETURNING id, user_id, chain_id, wallet_address, daily_limit, max_per_action,
                    spent_today, reserved_today, period_started_at, whitelist, scope,
                    expires_at, is_active, kill_switch, mainnet_opt_in
        ), cleanup AS (
          DELETE FROM autonomy_execution_reservations
          WHERE id = ${id}
            AND EXISTS (SELECT 1 FROM candidate)
            AND NOT EXISTS (SELECT 1 FROM updated_policy)
        )
        SELECT * FROM updated_policy
      `;

      if (rows[0]) {
        const reservation = await getReservation(input.actionId);
        return {
          success: true,
          status: 'reserved',
          policy: rowToPolicy(rows[0]),
          reservation,
        };
      }

      const existing = await getReservation(input.actionId);
      if (
        existing &&
        existing.policyId === input.policyId &&
        existing.userId === input.userId &&
        existing.amount === input.amount &&
        existing.status === 'reserved' &&
        existing.expiresAt > Date.now()
      ) {
        return { success: true, status: 'reserved', policy: await getById(input.policyId), reservation: existing };
      }
      if (existing) return { success: false, status: 'reservation_conflict', error: 'Action already has a different autonomy reservation' };
      const policy = await getById(input.policyId);
      if (!policy) return { success: false, status: 'missing_policy', error: 'Autonomy policy not found' };
      const failure = policyFailure(policy, input.amount);
      return { success: false, ...(failure || { status: 'reservation_failed', error: 'Autonomy reservation failed' }), policy };
    },

    async settle(actionId, proof): Promise<AutonomyReservationResult> {
      if (!hasDurableProof(proof)) return { success: false, status: 'missing_proof', error: 'Durable settlement proof required' };
      const rows = await sql`
        WITH current_reservation AS (
          SELECT id, policy_id, amount, status
          FROM autonomy_execution_reservations
          WHERE action_id = ${actionId}
            AND status IN ('reserved', 'released', 'expired')
          FOR UPDATE
        ), settled_reservation AS (
          UPDATE autonomy_execution_reservations
          SET status = 'settled', proof = CAST(${JSON.stringify(proof)} AS jsonb), settled_at = now(), updated_at = now()
          FROM current_reservation
          WHERE autonomy_execution_reservations.id = current_reservation.id
          RETURNING current_reservation.policy_id,
                    current_reservation.amount,
                    current_reservation.status AS previous_status
        )
        UPDATE autonomy_policies
        SET reserved_today = GREATEST(
              0,
              reserved_today - CASE WHEN settled_reservation.previous_status = 'reserved' THEN settled_reservation.amount ELSE 0 END
            ),
            spent_today = spent_today + settled_reservation.amount,
            updated_at = now()
        FROM settled_reservation
        WHERE autonomy_policies.id = settled_reservation.policy_id
        RETURNING autonomy_policies.id, user_id, chain_id, wallet_address, daily_limit,
                  max_per_action, spent_today, reserved_today, period_started_at,
                  whitelist, scope, expires_at, is_active, kill_switch, mainnet_opt_in
      `;
      const reservation = await getReservation(actionId);
      if (reservation?.status === 'settled') {
        return {
          success: true,
          status: 'settled',
          policy: rows[0] ? rowToPolicy(rows[0]) : await getById(reservation.policyId),
          reservation,
        };
      }
      return { success: false, status: 'missing_reservation', error: 'Autonomy reservation not found' };
    },

    async release(actionId): Promise<AutonomyReservationResult> {
      const rows = await sql`
        WITH released_reservation AS (
          UPDATE autonomy_execution_reservations
          SET status = 'released', updated_at = now()
          WHERE action_id = ${actionId} AND status = 'reserved'
          RETURNING policy_id, amount
        )
        UPDATE autonomy_policies
        SET reserved_today = GREATEST(0, reserved_today - released_reservation.amount), updated_at = now()
        FROM released_reservation
        WHERE autonomy_policies.id = released_reservation.policy_id
        RETURNING autonomy_policies.id, user_id, chain_id, wallet_address, daily_limit,
                  max_per_action, spent_today, reserved_today, period_started_at,
                  whitelist, scope, expires_at, is_active, kill_switch, mainnet_opt_in
      `;
      const reservation = await getReservation(actionId);
      return {
        success: true,
        status: reservation?.status || 'missing_reservation',
        policy: rows[0] ? rowToPolicy(rows[0]) : reservation ? await getById(reservation.policyId) : undefined,
        reservation,
      };
    },

    async setKillSwitch(id, enabled): Promise<AutonomyPolicy | undefined> {
      const rows = await sql`
        WITH released AS (
          UPDATE autonomy_execution_reservations
          SET status = 'released', updated_at = now()
          WHERE policy_id = ${id} AND status = 'reserved'
          RETURNING amount
        ), total AS (
          SELECT COALESCE(SUM(amount), 0) AS amount FROM released
        )
        UPDATE autonomy_policies
        SET kill_switch = ${enabled},
            is_active = ${!enabled},
            reserved_today = GREATEST(0, reserved_today - total.amount),
            updated_at = now()
        FROM total
        WHERE id = ${id}
        RETURNING autonomy_policies.id, user_id, chain_id, wallet_address, daily_limit,
                  max_per_action, spent_today, reserved_today, period_started_at,
                  whitelist, scope, expires_at, is_active, kill_switch, mainnet_opt_in
      `;
      return rows[0] ? rowToPolicy(rows[0]) : undefined;
    },
  };
}

function policyFailure(policy: AutonomyPolicy, amount: number): { status: string; error: string } | null {
  if (policy.killSwitch || !policy.isActive) return { status: 'kill_switch', error: 'Autonomy kill switch is engaged' };
  if (policy.chainId === 8453 && !policy.mainnetOptIn) {
    return { status: 'mainnet_opt_in_required', error: 'Explicit mainnet autonomy opt-in is required' };
  }
  if (Date.now() >= policy.expiresAt) return { status: 'permission_expired', error: 'Autonomy policy expired' };
  if (amount > policy.maxPerAction) return { status: 'max_per_action_exceeded', error: 'Max per-action limit exceeded' };
  if (policy.spentToday + policy.reservedToday + amount > policy.dailyLimit) {
    return { status: 'daily_limit_exceeded', error: 'Daily autonomy limit exceeded' };
  }
  return null;
}

function validatePolicyInput(input: ConfigureAutonomyPolicyInput): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.walletAddress)) throw new Error('A valid policy wallet address is required');
  if (!Number.isFinite(input.dailyLimit) || input.dailyLimit <= 0) throw new Error('Daily limit must be greater than zero');
  if (!Number.isFinite(input.maxPerAction) || input.maxPerAction <= 0 || input.maxPerAction > input.dailyLimit) {
    throw new Error('Per-action limit must be greater than zero and no higher than the daily limit');
  }
  if (input.expiresAt <= Date.now()) throw new Error('Autonomy policy expiry must be in the future');
  if (input.whitelist.length === 0 || input.whitelist.some((address) => !/^0x[0-9a-fA-F]{40}$/.test(address))) {
    throw new Error('At least one valid whitelisted address is required');
  }
}

function hasDurableProof(proof: ConfirmedSettlementProof): boolean {
  return Boolean(proof.txHash || proof.batchId || proof.receiptId || proof.x402ReceiptId);
}

function numberFrom(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}

function timestampFrom(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return new Date(String(value)).getTime();
}

function rowToPolicy(row: Record<string, unknown>): AutonomyPolicy {
  const rawWhitelist = row.whitelist;
  const whitelist = Array.isArray(rawWhitelist)
    ? rawWhitelist.map(String)
    : typeof rawWhitelist === 'string'
      ? JSON.parse(rawWhitelist)
      : [];
  return {
    id: String(row.id),
    userId: String(row.user_id),
    chainId: numberFrom(row.chain_id),
    walletAddress: String(row.wallet_address).toLowerCase(),
    dailyLimit: numberFrom(row.daily_limit),
    maxPerAction: numberFrom(row.max_per_action),
    spentToday: numberFrom(row.spent_today),
    reservedToday: numberFrom(row.reserved_today),
    periodStartedAt: timestampFrom(row.period_started_at),
    whitelist,
    scope: String(row.scope || 'bounded-approval'),
    expiresAt: timestampFrom(row.expires_at),
    isActive: Boolean(row.is_active),
    killSwitch: Boolean(row.kill_switch),
    mainnetOptIn: Boolean(row.mainnet_opt_in),
  };
}

function rowToReservation(row: Record<string, unknown>): AutonomyExecutionReservation {
  const proof = row.proof && typeof row.proof === 'object' ? row.proof as ConfirmedSettlementProof : undefined;
  return {
    id: String(row.id),
    policyId: String(row.policy_id),
    userId: String(row.user_id),
    actionId: String(row.action_id),
    amount: numberFrom(row.amount),
    status: String(row.status) as AutonomyReservationStatus,
    expiresAt: timestampFrom(row.expires_at),
    ...(proof ? { proof } : {}),
  };
}
