# Pharma-Alert PRD

## Original Problem Statement

Fix Pharma-Alert React web app (localhost:3000) using Supabase with the following issues:
1. After login the UI frequently gets stuck in perpetual loading across pages
2. Role logic is broken: selecting pharmacist on signup results in a patient account
3. Need pharmacist connections invite/accept system

### Hard Constraints
- Remove ALL Emergent-specific runtime tooling/artifacts
- No service worker registration on localhost/dev
- Do not refactor unrelated UI

---

## User Personas

### Patient
- Searches for medicine availability at nearby pharmacies
- Saves favorite pharmacies
- Sets medication reminders

### Pharmacist
- Manages pharmacy inventory/stock
- Updates medicine availability status
- Connects with other pharmacists for stock requests

---

## Core Requirements (Static)

1. **Authentication Flow**
   - Email/password signup with OTP verification
   - Two roles: `patient` and `pharmacist`
   - Role-based routing after login

2. **Patient Features**
   - Dashboard with nearby pharmacies
   - Medicine search
   - Favorites and reminders

3. **Pharmacist Features**
   - Dashboard with stock management
   - Inter-pharmacy stock requests
   - Pharmacist connections (invite/accept)

---

## What's Been Implemented (Jan 26, 2026)

### Part A - Loading Hang Fix
- [x] Added 10-second global loading timeout safeguard in AuthContext
- [x] Added `loadingTimedOut` state for recoverable error UI
- [x] Removed service worker registration (production and dev)
- [x] Deleted sw.js from public folder

### Part B - Role Model Fix
- [x] Simplified roles to `patient` and `pharmacist` only
- [x] Fixed SignUpPage to store role exactly as selected
- [x] Fixed AuthContext createProfile to not transform role
- [x] Fixed SignInPage to rely on DB profile, not user_metadata
- [x] Fixed VerifyOtpPage to use exact role match for routing
- [x] Added centralized `getRole()` function

### Part C - Pharmacist Connections
- [x] Created `pharmacist_connections` table schema
- [x] Created RLS policies for connections
- [x] Created PharmacistConnectionsPage.jsx
- [x] Email-based pharmacist lookup for invites
- [x] Accept/reject/cancel invite functionality
- [x] Added Connections link to pharmacist navigation

### Emergent Artifact Removal
- [x] Deleted analytics.js (badge, posthog, debug monitor)
- [x] Deleted sw.js service worker
- [x] Removed analytics import from App.js

---

## Prioritized Backlog

### P0 (Blocking)
- [x] Loading hang fix
- [x] Role bug fix

### P1 (High Priority)
- [x] Pharmacist connections system
- [ ] Run SQL migration in Supabase

### P2 (Nice to Have)
- [ ] Pharmacist verification workflow
- [ ] Push notifications
- [ ] Offline support (PWA)

---

## Next Tasks

1. **User must run SQL migration**: Copy `supabase_migration.sql` to Supabase SQL Editor and execute
2. **Test with real users**: Create patient and pharmacist accounts to verify role routing
3. **Test connections flow**: Two pharmacist accounts needed to test invite/accept
4. **Production deployment**: After verifying all fixes work correctly

---

## Files of Reference

- `/app/frontend/src/contexts/AuthContext.js` - Auth state and role management
- `/app/frontend/src/App.js` - Routes and protection
- `/app/frontend/src/pages/pharmacist/PharmacistConnectionsPage.jsx` - Connections UI
- `/app/supabase_migration.sql` - Database schema for connections
- `/app/CHANGES_DOCUMENTATION.md` - Detailed change log and test checklist
