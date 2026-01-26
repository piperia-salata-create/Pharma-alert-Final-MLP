# Pharma-Alert - Fixed Version

## Quick Start

```bash
cd frontend
yarn install
yarn start
```

## SQL Migration (Required)

Run `supabase_migration.sql` in your Supabase SQL Editor to:
- Normalize existing roles
- Create `pharmacist_connections` table

## Changes Made

See `CHANGES_DOCUMENTATION.md` for:
- Pre-fix audit report
- Files changed and why
- Manual test checklist

## Build

```bash
cd frontend
yarn build
```
