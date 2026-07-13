\set ON_ERROR_STOP on
\pset pager off

-- REVIEW-ONLY TEMPLATE. It contains no default candidates and ends in
-- ROLLBACK. Never populate it from pattern matching alone. Copy identifiers
-- from the read-only audit after confirming each record is a test fixture.
--
-- To enter review mode:
--   psql "$DATABASE_URL" \
--     --set=T46_CLEANUP_CONFIRMATION=reviewed-t46-production-candidates \
--     --file=ops/t46/production-db-cleanup-review.sql

\if :{?T46_CLEANUP_CONFIRMATION}
select :'T46_CLEANUP_CONFIRMATION' = 'reviewed-t46-production-candidates' as t46_confirmed \gset
\else
\echo 'T46_CLEANUP_CONFIRMATION is required; nothing was executed.'
\quit
\endif

\if :t46_confirmed
\else
\echo 'Invalid T46 cleanup confirmation; nothing was executed.'
\quit
\endif

begin;
set local statement_timeout = '15s';
set local lock_timeout = '2s';

create temporary table t46_cleanup_users (
  user_id text primary key
) on commit drop;

create temporary table t46_cleanup_actions (
  action_id text primary key
) on commit drop;

-- Intentionally empty. Add only individually reviewed identifiers, for example:
-- insert into t46_cleanup_users(user_id) values ('mio-test:REVIEWED-RUN:user');
-- insert into t46_cleanup_actions(action_id) values ('REVIEWED-ORPHAN-ACTION-ID');

do $$
begin
  if not exists (select 1 from t46_cleanup_users)
     and not exists (select 1 from t46_cleanup_actions) then
    raise exception 'No reviewed cleanup candidates were supplied';
  end if;
end $$;

-- Preview the exact scoped rows before considering deletion.
select 'users' as table_name, count(*) from users u join t46_cleanup_users c on c.user_id = u.id
union all
select 'actions', count(*) from actions a join t46_cleanup_users c on c.user_id = a.user_id
union all
select 'prepared_transaction_intents', count(*) from prepared_transaction_intents p
where p.user_id in (select user_id from t46_cleanup_users)
   or p.action_id in (select action_id from t46_cleanup_actions)
union all
select 'autonomy_execution_reservations', count(*) from autonomy_execution_reservations r
where r.user_id in (select user_id from t46_cleanup_users)
   or r.action_id in (select action_id from t46_cleanup_actions);

-- Deletion order is foreign-key safe and every statement is explicitly scoped
-- to the reviewed temporary candidate tables. No DROP, TRUNCATE, or unscoped
-- DELETE is present.
delete from spend_permission_proofs where permission_id in (
  select id from spend_permissions where user_id in (select user_id from t46_cleanup_users)
);
delete from autonomy_execution_reservations
where user_id in (select user_id from t46_cleanup_users)
   or action_id in (select action_id from t46_cleanup_actions);
delete from prepared_transaction_intents
where user_id in (select user_id from t46_cleanup_users)
   or action_id in (select action_id from t46_cleanup_actions);
delete from base_mcp_oauth_states where user_id in (select user_id from t46_cleanup_users);
delete from base_mcp_oauth_tokens where user_id in (select user_id from t46_cleanup_users);
delete from user_settings where user_id in (select user_id from t46_cleanup_users);
delete from audit_logs where user_id in (select user_id from t46_cleanup_users);
delete from x402_receipts where user_id in (select user_id from t46_cleanup_users);
delete from chats where user_id in (select user_id from t46_cleanup_users);
delete from actions
where user_id in (select user_id from t46_cleanup_users)
   or id in (select action_id from t46_cleanup_actions);
delete from workflows where user_id in (select user_id from t46_cleanup_users);
delete from spend_permissions where user_id in (select user_id from t46_cleanup_users);
delete from autonomy_policies where user_id in (select user_id from t46_cleanup_users);
delete from users where id in (select user_id from t46_cleanup_users);

-- Safe default. Review counts/output, take a fresh backup, then replace this
-- single ROLLBACK with COMMIT in an operator-reviewed copy.
rollback;
