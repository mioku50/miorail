\set ON_ERROR_STOP on
\pset pager off

begin transaction read only;
set local statement_timeout = '15s';
set local lock_timeout = '2s';

select current_database() as database_name, current_timestamp as audited_at_utc;

with findings as (
  select 'default_user' as category, 'users' as table_name, count(*)::bigint as row_count
  from users where id = 'default-user'
  union all
  select 'test_tenant', 'users', count(*) from users
  where lower(id) ~ '(^|[:_-])(test|smoke)([:_-]|$)' or lower(id) like 'mio-test:%'
  union all
  select 'test_tenant', 'chats', count(*) from chats
  where lower(user_id) ~ '(^|[:_-])(test|smoke)([:_-]|$)' or lower(user_id) like 'mio-test:%'
  union all
  select 'test_tenant', 'actions', count(*) from actions
  where lower(user_id) ~ '(^|[:_-])(test|smoke)([:_-]|$)' or lower(user_id) like 'mio-test:%'
  union all
  select 'test_tenant', 'workflows', count(*) from workflows
  where lower(user_id) ~ '(^|[:_-])(test|smoke)([:_-]|$)' or lower(user_id) like 'mio-test:%'
  union all
  select 'test_tenant', 'user_settings', count(*) from user_settings
  where lower(user_id) ~ '(^|[:_-])(test|smoke)([:_-]|$)' or lower(user_id) like 'mio-test:%'
  union all
  select 'test_tenant', 'autonomy_policies', count(*) from autonomy_policies
  where lower(user_id) ~ '(^|[:_-])(test|smoke)([:_-]|$)' or lower(user_id) like 'mio-test:%'
  union all
  select 'test_tenant', 'x402_receipts', count(*) from x402_receipts
  where lower(coalesce(user_id, '')) ~ '(^|[:_-])(test|smoke)([:_-]|$)'
     or lower(coalesce(user_id, '')) like 'mio-test:%'
     or lower(id) ~ '(^|[:_-])(test|smoke)([:_-]|$)'
  union all
  select 'smoke_or_test_identifier', 'actions', count(*) from actions
  where lower(id) ~ '(smoke|test[-_:]?run|mio-test)'
     or lower(coalesce(suggested_prompt, '')) ~ '(smoke|test[-_:]?run|mio-test)'
     or lower(coalesce(metadata::text, '')) ~ '(smoke|test[-_:]?run|mio-test)'
  union all
  select 'smoke_or_test_identifier', 'audit_logs', count(*) from audit_logs
  where lower(id) ~ '(smoke|test[-_:]?run|mio-test)'
     or lower(action_id) ~ '(smoke|test[-_:]?run|mio-test)'
     or lower(coalesce(details::text, '')) ~ '(smoke|test[-_:]?run|mio-test)'
  union all
  select 'smoke_or_test_identifier', 'prepared_transaction_intents', count(*) from prepared_transaction_intents
  where lower(action_id) ~ '(smoke|test[-_:]?run|mio-test)'
     or lower(user_id) ~ '(smoke|test[-_:]?run|mio-test)'
  union all
  select 'orphan_prepared_missing_user', 'prepared_transaction_intents', count(*)
  from prepared_transaction_intents p left join users u on u.id = p.user_id where u.id is null
  union all
  select 'orphan_prepared_missing_action', 'prepared_transaction_intents', count(*)
  from prepared_transaction_intents p left join actions a on a.id = p.action_id where a.id is null
  union all
  select 'reservation_missing_user', 'autonomy_execution_reservations', count(*)
  from autonomy_execution_reservations r left join users u on u.id = r.user_id where u.id is null
  union all
  select 'reservation_missing_policy', 'autonomy_execution_reservations', count(*)
  from autonomy_execution_reservations r left join autonomy_policies p on p.id = r.policy_id where p.id is null
  union all
  select 'reservation_missing_action', 'autonomy_execution_reservations', count(*)
  from autonomy_execution_reservations r left join actions a on a.id = r.action_id where a.id is null
  union all
  select 'oauth_test_fixture', 'base_mcp_oauth_tokens', count(*) from base_mcp_oauth_tokens
  where lower(id) ~ '(smoke|test|mio-test)' or lower(user_id) ~ '(smoke|test|mio-test)'
  union all
  select 'oauth_test_fixture', 'base_mcp_oauth_states', count(*) from base_mcp_oauth_states
  where lower(user_id) ~ '(smoke|test|mio-test)' or lower(return_to) ~ '(smoke|test)'
)
select category, table_name, row_count from findings order by category, table_name;

-- Candidate identifiers only. Encrypted OAuth payloads, receipt payloads, and
-- secrets are deliberately excluded from this report.
select 'user' as candidate_type, id as candidate_id, created_at
from users
where id = 'default-user'
   or lower(id) ~ '(^|[:_-])(test|smoke)([:_-]|$)'
   or lower(id) like 'mio-test:%'
order by created_at;

select 'prepared_intent' as candidate_type, p.action_id as candidate_id, p.user_id, p.status, p.created_at
from prepared_transaction_intents p
left join users u on u.id = p.user_id
left join actions a on a.id = p.action_id
where u.id is null or a.id is null
order by p.created_at;

select 'action_identifier' as candidate_type, id as candidate_id, user_id, kind, status, created_at
from actions
where lower(id) ~ '(smoke|test[-_:]?run|mio-test)'
   or lower(coalesce(suggested_prompt, '')) ~ '(smoke|test[-_:]?run|mio-test)'
   or lower(coalesce(metadata::text, '')) ~ '(smoke|test[-_:]?run|mio-test)'
order by created_at;

select 'reservation' as candidate_type, r.id as candidate_id, r.user_id, r.action_id, r.status, r.created_at
from autonomy_execution_reservations r
left join users u on u.id = r.user_id
left join autonomy_policies p on p.id = r.policy_id
left join actions a on a.id = r.action_id
where u.id is null or p.id is null or a.id is null
order by r.created_at;

rollback;
