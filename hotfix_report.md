# Hotfix Report ? Notifications Schema + RLS Recursion

## Summary
This hotfix aligns `public.notifications` with the frontend/RPC schema and replaces recursive RLS policies on `patient_requests`/`patient_request_recipients` to eliminate the 500 ?infinite recursion? error.

## A) Repo inspection (RPC/trigger references)
Found notification writes in:
- `supabase_patient_requests_migration.sql`
  - `create_patient_request` inserts into `public.notifications` (uses `body`/`data`).
  - `notify_patient_request_status_change` trigger inserts into `public.notifications` (uses `body`/`data`).

## B) SQL patch added
- `supabase_hotfix_notifications_and_rls.sql`
  - Adds `body`, `is_read`, `data` to `public.notifications` if missing.
  - Backfills `body` from `message` and `is_read` from `read`.
  - Adds `notifications_sync_columns` trigger to keep legacy/new columns in sync.
  - Drops and recreates **non-recursive** RLS policies for `patient_requests` and `patient_request_recipients`.
  - Adds helper functions `is_request_owner` and `is_request_routed_to_pharmacist` and disable RLS inside the function with `set_config('row_security', 'off', true)` to avoid recursion.

## C) Policy fix (non-recursive)
New policy logic:
- **patient_requests**
  - Patient: insert/select/update where `patient_id = auth.uid()`.
  - Pharmacist: select only if request routed to a pharmacy they own.
- **patient_request_recipients**
  - Patient: select recipients if they own the request (via `is_request_owner`).
  - Pharmacist: select/update recipients for their pharmacy rows.

## D) Frontend alignment
No code changes required beyond existing `body/is_read/data` usage. The DB patch ensures compatibility with legacy `message/read` columns.

## Files changed/added
- `supabase_hotfix_notifications_and_rls.sql` (new)

### Line-level notes
- Notifications columns/backfill/trigger: `supabase_hotfix_notifications_and_rls.sql#L9`
- Sync trigger function: `supabase_hotfix_notifications_and_rls.sql#L64`
- Helper function (request owner): `supabase_hotfix_notifications_and_rls.sql#L98`
- Helper function (pharmacist routing): `supabase_hotfix_notifications_and_rls.sql#L111`
- Policy (patient insert): `supabase_hotfix_notifications_and_rls.sql#L162`
- Policy (pharmacist select): `supabase_hotfix_notifications_and_rls.sql#L187`
- Policy (patient recipients select): `supabase_hotfix_notifications_and_rls.sql#L194`
- Policy (pharmacist recipients update): `supabase_hotfix_notifications_and_rls.sql#L213`

## Quick verification checklist
### SQL checks
```sql
-- Columns exist
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'notifications'
  AND column_name IN ('body', 'is_read', 'data');

-- Policies are present and non-recursive
SELECT policyname, tablename, cmd, qual
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('patient_requests', 'patient_request_recipients');
```

### UI checks
1) Patient creates a request (RPC `create_patient_request`)
   - Expect **no 400** from `notifications` insert.
2) Patient sees own request list (no 500 recursion).
3) Pharmacist sees incoming requests and can accept/reject.
4) Notifications page loads without schema errors.
