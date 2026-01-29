-- ============================================
-- PHARMA-ALERT HOTFIX: NOTIFICATIONS SCHEMA + RLS RECURSION
-- Idempotent patch
-- ============================================

BEGIN;

-- ============================================
-- A) NOTIFICATIONS SCHEMA ALIGNMENT
-- ============================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notifications'
      AND column_name = 'body'
  ) THEN
    ALTER TABLE public.notifications ADD COLUMN body TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notifications'
      AND column_name = 'is_read'
  ) THEN
    ALTER TABLE public.notifications ADD COLUMN is_read BOOLEAN NOT NULL DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notifications'
      AND column_name = 'data'
  ) THEN
    ALTER TABLE public.notifications ADD COLUMN data JSONB;
  END IF;
END $$;

-- Backfill new columns from legacy columns
UPDATE public.notifications
SET body = message
WHERE body IS NULL
  AND message IS NOT NULL;

UPDATE public.notifications
SET is_read = read
WHERE is_read IS NULL
  AND read IS NOT NULL;

-- Backfill legacy columns from new columns (if needed)
UPDATE public.notifications
SET message = body
WHERE message IS NULL
  AND body IS NOT NULL;

UPDATE public.notifications
SET read = is_read
WHERE read IS NULL
  AND is_read IS NOT NULL;

-- Keep legacy/new columns in sync on write
CREATE OR REPLACE FUNCTION public.sync_notifications_columns()
RETURNS TRIGGER AS $$
DECLARE
  v_body TEXT;
  v_read BOOLEAN;
BEGIN
  v_body := COALESCE(NEW.body, NEW.message);
  NEW.body := v_body;
  NEW.message := v_body;

  v_read := COALESCE(NEW.is_read, NEW.read, false);
  NEW.is_read := v_read;
  NEW.read := v_read;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notifications_sync_columns ON public.notifications;
CREATE TRIGGER notifications_sync_columns
BEFORE INSERT OR UPDATE ON public.notifications
FOR EACH ROW
EXECUTE FUNCTION public.sync_notifications_columns();

-- ============================================
-- B) RLS RECURSION FIX FOR patient_requests
-- ============================================
-- Existing policies (for reference):
-- SELECT policyname, cmd, roles, qual
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN ('patient_requests', 'patient_request_recipients');

-- Helper functions avoid recursive policy evaluation
CREATE OR REPLACE FUNCTION public.is_request_owner(request_id UUID, user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  PERFORM set_config('row_security', 'off', true);
  RETURN EXISTS (
    SELECT 1
    FROM public.patient_requests pr
    WHERE pr.id = request_id
      AND pr.patient_id = user_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_request_routed_to_pharmacist(request_id UUID, user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  PERFORM set_config('row_security', 'off', true);
  RETURN EXISTS (
    SELECT 1
    FROM public.patient_request_recipients prr
    JOIN public.pharmacies p ON p.id = prr.pharmacy_id
    WHERE prr.request_id = request_id
      AND p.owner_id = user_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.is_request_owner(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_request_routed_to_pharmacist(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_request_owner(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_request_routed_to_pharmacist(UUID, UUID) TO authenticated;

-- Drop all existing policies on patient_requests
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN (
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'patient_requests'
  ) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.patient_requests', pol.policyname);
  END LOOP;
END $$;

-- Drop all existing policies on patient_request_recipients
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN (
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'patient_request_recipients'
  ) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.patient_request_recipients', pol.policyname);
  END LOOP;
END $$;

ALTER TABLE public.patient_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_request_recipients ENABLE ROW LEVEL SECURITY;

-- patient_requests policies (non-recursive)
CREATE POLICY "Patients can insert their own requests"
  ON public.patient_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = patient_id
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'patient'
    )
  );

CREATE POLICY "Patients can view their own requests"
  ON public.patient_requests
  FOR SELECT
  TO authenticated
  USING (auth.uid() = patient_id);

CREATE POLICY "Patients can update their own requests"
  ON public.patient_requests
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = patient_id)
  WITH CHECK (auth.uid() = patient_id);

CREATE POLICY "Pharmacists can view routed requests"
  ON public.patient_requests
  FOR SELECT
  TO authenticated
  USING (public.is_request_routed_to_pharmacist(patient_requests.id, auth.uid()));

-- patient_request_recipients policies (non-recursive)
CREATE POLICY "Patients can view recipients for their requests"
  ON public.patient_request_recipients
  FOR SELECT
  TO authenticated
  USING (public.is_request_owner(patient_request_recipients.request_id, auth.uid()));

CREATE POLICY "Pharmacists can view recipients for their pharmacies"
  ON public.patient_request_recipients
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.pharmacies p
      WHERE p.id = patient_request_recipients.pharmacy_id
        AND p.owner_id = auth.uid()
    )
  );

CREATE POLICY "Pharmacists can update recipient status"
  ON public.patient_request_recipients
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.pharmacies p
      WHERE p.id = patient_request_recipients.pharmacy_id
        AND p.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.pharmacies p
      WHERE p.id = patient_request_recipients.pharmacy_id
        AND p.owner_id = auth.uid()
    )
    AND status IN ('accepted', 'rejected')
  );

COMMIT;

-- ============================================
-- END OF HOTFIX
-- ============================================
