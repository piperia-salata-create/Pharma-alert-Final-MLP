-- ============================================
-- PHARMA-ALERT PATIENT REQUESTS + NOTIFICATIONS MIGRATION
-- Safe and idempotent - can be run multiple times
-- ============================================

BEGIN;

-- Ensure pgcrypto for gen_random_uuid
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Ensure profiles role check allows patient/pharmacist
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'profiles_role_check' 
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles DROP CONSTRAINT profiles_role_check;
  END IF;
EXCEPTION WHEN undefined_table THEN
  -- profiles table may not exist in this context
  NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'profiles_role_check' 
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_role_check CHECK (role IN ('patient', 'pharmacist'));
  END IF;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

-- ============================================
-- TABLE: patient_requests
-- ============================================
CREATE TABLE IF NOT EXISTS public.patient_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  medicine_query TEXT NOT NULL,
  notes TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NULL
);

ALTER TABLE public.patient_requests
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;

-- ============================================
-- TABLE: patient_request_recipients
-- ============================================
CREATE TABLE IF NOT EXISTS public.patient_request_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.patient_requests(id) ON DELETE CASCADE,
  pharmacy_id UUID NOT NULL REFERENCES public.pharmacies(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  responded_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT patient_request_recipients_unique UNIQUE (request_id, pharmacy_id)
);

-- ============================================
-- TABLE: notifications (if missing)
-- ============================================
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NULL,
  data JSONB NULL,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_patient_requests_patient_id_created_at
  ON public.patient_requests (patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_patient_request_recipients_pharmacy_status
  ON public.patient_request_recipients (pharmacy_id, status);

CREATE INDEX IF NOT EXISTS idx_patient_request_recipients_request_id
  ON public.patient_request_recipients (request_id);

-- ============================================
-- UPDATED_AT TRIGGER
-- ============================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_patient_requests_updated_at ON public.patient_requests;
CREATE TRIGGER set_patient_requests_updated_at
BEFORE UPDATE ON public.patient_requests
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_patient_request_recipients_updated_at ON public.patient_request_recipients;
CREATE TRIGGER set_patient_request_recipients_updated_at
BEFORE UPDATE ON public.patient_request_recipients
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- ============================================
-- STATUS SYNC TRIGGER (recipients -> request)
-- ============================================
CREATE OR REPLACE FUNCTION public.sync_patient_request_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_request_id UUID;
  v_total INTEGER;
  v_accepted INTEGER;
  v_rejected INTEGER;
  v_current_status TEXT;
BEGIN
  v_request_id := COALESCE(NEW.request_id, OLD.request_id);

  SELECT status INTO v_current_status
  FROM public.patient_requests
  WHERE id = v_request_id;

  IF v_current_status IS NULL THEN
    RETURN NULL;
  END IF;

  -- Do not override accepted/closed
  IF v_current_status IN ('accepted', 'closed') THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE status = 'accepted'),
         COUNT(*) FILTER (WHERE status = 'rejected')
    INTO v_total, v_accepted, v_rejected
  FROM public.patient_request_recipients
  WHERE request_id = v_request_id;

  IF v_accepted > 0 THEN
    UPDATE public.patient_requests
      SET status = 'accepted'
    WHERE id = v_request_id;
  ELSIF v_total > 0 AND v_rejected = v_total THEN
    UPDATE public.patient_requests
      SET status = 'rejected'
    WHERE id = v_request_id;
  ELSE
    UPDATE public.patient_requests
      SET status = 'pending'
    WHERE id = v_request_id;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS patient_request_recipients_sync_status ON public.patient_request_recipients;
CREATE TRIGGER patient_request_recipients_sync_status
AFTER INSERT OR UPDATE OR DELETE ON public.patient_request_recipients
FOR EACH ROW
EXECUTE FUNCTION public.sync_patient_request_status();

-- ============================================
-- NOTIFY PATIENT ON STATUS CHANGE
-- ============================================
CREATE OR REPLACE FUNCTION public.notify_patient_request_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('accepted', 'rejected') THEN
    INSERT INTO public.notifications (user_id, type, title, body, data)
    VALUES (
      NEW.patient_id,
      'patient_request_update',
      'Request update',
      CASE
        WHEN NEW.status = 'accepted' THEN 'Your request was accepted.'
        WHEN NEW.status = 'rejected' THEN 'Your request was rejected.'
        ELSE 'Your request status changed.'
      END,
      jsonb_build_object('request_id', NEW.id, 'status', NEW.status)
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS patient_requests_notify_status ON public.patient_requests;
CREATE TRIGGER patient_requests_notify_status
AFTER UPDATE ON public.patient_requests
FOR EACH ROW
EXECUTE FUNCTION public.notify_patient_request_status_change();

-- ============================================
-- RPC: create_patient_request
-- ============================================
CREATE OR REPLACE FUNCTION public.create_patient_request(
  medicine_query TEXT,
  notes TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_patient_id UUID;
  v_request_id UUID;
  v_medicine TEXT;
  v_notes TEXT;
BEGIN
  v_patient_id := auth.uid();
  v_medicine := btrim(medicine_query);
  v_notes := NULLIF(btrim(notes), '');

  IF v_patient_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_medicine IS NULL OR v_medicine = '' THEN
    RAISE EXCEPTION 'medicine_query required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_patient_id AND role = 'patient'
  ) THEN
    RAISE EXCEPTION 'Only patients can create requests';
  END IF;

  INSERT INTO public.patient_requests (patient_id, medicine_query, notes)
  VALUES (v_patient_id, v_medicine, v_notes)
  RETURNING id INTO v_request_id;

  -- Route to on-duty pharmacies
  INSERT INTO public.patient_request_recipients (request_id, pharmacy_id)
  SELECT v_request_id, p.id
  FROM public.pharmacies p
  WHERE p.is_on_call = true
  ON CONFLICT DO NOTHING;

  -- Notify recipient pharmacists
  INSERT INTO public.notifications (user_id, type, title, body, data)
  SELECT p.owner_id,
         'patient_request',
         'New patient request',
         'Medicine: ' || v_medicine,
         jsonb_build_object('request_id', v_request_id, 'pharmacy_id', p.id)
  FROM public.pharmacies p
  WHERE p.is_on_call = true
    AND p.owner_id IS NOT NULL;

  RETURN v_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_patient_request(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_patient_request(TEXT, TEXT) TO authenticated;

-- ============================================
-- RLS POLICIES
-- ============================================
ALTER TABLE public.patient_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_request_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- patient_requests policies
DROP POLICY IF EXISTS "Patients can insert their own requests" ON public.patient_requests;
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

DROP POLICY IF EXISTS "Patients can view their own requests" ON public.patient_requests;
CREATE POLICY "Patients can view their own requests"
  ON public.patient_requests
  FOR SELECT
  TO authenticated
  USING (auth.uid() = patient_id);

DROP POLICY IF EXISTS "Pharmacists can view requests routed to their pharmacies" ON public.patient_requests;
CREATE POLICY "Pharmacists can view requests routed to their pharmacies"
  ON public.patient_requests
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.patient_request_recipients prr
      JOIN public.pharmacies p ON p.id = prr.pharmacy_id
      WHERE prr.request_id = patient_requests.id
        AND p.owner_id = auth.uid()
    )
  );

-- patient_request_recipients policies
DROP POLICY IF EXISTS "Patients can view recipients for their requests" ON public.patient_request_recipients;
CREATE POLICY "Patients can view recipients for their requests"
  ON public.patient_request_recipients
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.patient_requests pr
      WHERE pr.id = patient_request_recipients.request_id
        AND pr.patient_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Pharmacists can view recipients for their pharmacies" ON public.patient_request_recipients;
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

DROP POLICY IF EXISTS "Pharmacists can update recipient status" ON public.patient_request_recipients;
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
    AND status IN ('accepted','rejected')
  );

-- notifications policies
DROP POLICY IF EXISTS "Users can read their own notifications" ON public.notifications;
CREATE POLICY "Users can read their own notifications"
  ON public.notifications
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own notifications" ON public.notifications;
CREATE POLICY "Users can update their own notifications"
  ON public.notifications
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- REALTIME PUBLICATION
-- ============================================
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.patient_requests;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.patient_request_recipients;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
END $$;

-- ============================================
-- OPTIONAL: stock_requests table for existing UI
-- ============================================
CREATE TABLE IF NOT EXISTS public.stock_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_pharmacy_id UUID NOT NULL REFERENCES public.pharmacies(id) ON DELETE CASCADE,
  to_pharmacy_id UUID NOT NULL REFERENCES public.pharmacies(id) ON DELETE CASCADE,
  medicine_name TEXT NOT NULL,
  message TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ NULL
);

ALTER TABLE public.stock_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Pharmacists can view their stock requests" ON public.stock_requests;
CREATE POLICY "Pharmacists can view their stock requests"
  ON public.stock_requests
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.pharmacies p WHERE p.id = stock_requests.from_pharmacy_id AND p.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.pharmacies p WHERE p.id = stock_requests.to_pharmacy_id AND p.owner_id = auth.uid())
  );

DROP POLICY IF EXISTS "Pharmacists can create stock requests" ON public.stock_requests;
CREATE POLICY "Pharmacists can create stock requests"
  ON public.stock_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.pharmacies p WHERE p.id = stock_requests.from_pharmacy_id AND p.owner_id = auth.uid())
  );

DROP POLICY IF EXISTS "Pharmacists can update incoming stock requests" ON public.stock_requests;
CREATE POLICY "Pharmacists can update incoming stock requests"
  ON public.stock_requests
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.pharmacies p WHERE p.id = stock_requests.to_pharmacy_id AND p.owner_id = auth.uid())
  )
  WITH CHECK (
    status IN ('accepted','declined')
  );

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_requests;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
END $$;

COMMIT;

-- ============================================
-- END OF MIGRATION
-- ============================================
