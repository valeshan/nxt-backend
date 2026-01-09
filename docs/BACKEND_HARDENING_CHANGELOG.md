# Backend Hardening Changelog

## Overview

This document summarizes the security and production-readiness improvements made to the backend service.

## Changes Made

### 1. Removed Accidental Agent Log Calls (High Priority)

**File**: `src/services/authService.ts`

**Change**: Removed three `fetch()` calls to `http://127.0.0.1:7242/ingest/...` in the `getMe()` method.

**Impact**: 
- Eliminates unexpected network calls that add latency
- Removes accidental instrumentation that should never ship
- Cleaner code without debug artifacts

**Testing**: Verified no linter errors, functionality unchanged.

---

### 2. Moved Sentry Configuration to Environment Variables (High Priority)

**Files**: 
- `src/config/sentry.ts`
- `src/config/env.ts`
- `README.md`

**Changes**:
- Removed hardcoded Sentry DSN from code
- Added `SENTRY_DSN` environment variable (optional)
- Changed `sendDefaultPii` default to `false` (was `true`)
- Added `SENTRY_SEND_DEFAULT_PII` environment variable (default: `'false'`)
- Updated README with environment variable documentation

**Impact**:
- Secrets no longer in version control
- Better privacy/compliance posture (PII disabled by default)
- Sentry initialization is now optional (graceful degradation if DSN not set)

**Testing**: Verified Sentry initializes correctly with env vars, gracefully skips if DSN not provided.

---

### 3. Sentry DSN Rotation Guide

**File**: `docs/SENTRY_DSN_ROTATION.md`

**Purpose**: Document the process for rotating the old hardcoded DSN after it was removed from code.

**Action Required**: 
- Create new Sentry project/DSN
- Update `SENTRY_DSN` in all environments
- Revoke old DSN in Sentry dashboard

---

### 4. Sanitized Error Responses (High Priority)

**File**: `src/controllers/xeroController.ts`

**Change**: Removed `error.stack` from error response in `authoriseStartHandler()`.

**Impact**:
- Prevents stack traces from leaking to clients
- Reduces risk of exposing internal implementation details
- Better security posture for public routes

**Testing**: Verified error responses no longer include stack traces.

---

### 5. Reduced Sensitive Payload Logging (Medium Priority)

**File**: `src/controllers/invoiceController.ts`

**Change**: Replaced full `req.body` logging with selective field logging in invoice verification endpoint.

**Impact**:
- Prevents PII/financial data from appearing in logs
- Maintains useful debugging information (counts, flags)
- Better compliance with data protection requirements

**Testing**: Verified logging still captures necessary information without sensitive data.

---

### 6. Aligned Token TTL Documentation (Medium Priority)

**Files**:
- `docs/auth-model.md`
- `src/services/authService.ts`

**Changes**:
- Updated documentation from "15m" to "90m" to match actual code (`ACCESS_TOKEN_TTL_SECONDS = 5400`)
- Fixed incorrect comments in `authService.ts`

**Impact**:
- Documentation now matches implementation
- Reduces confusion for developers
- Clearer understanding of token expiration behavior

**Testing**: Verified documentation accuracy.

---

### 7. Added CI/CD Pipeline (Medium Priority)

**File**: `.github/workflows/ci.yml`

**Features**:
- Runs on push/PR to `main` and `develop` branches
- Linting (`npm run lint`)
- Type checking (`tsc --noEmit`)
- Tests (`npm test`)
- Security audit (`npm audit --audit-level=high`)

**Impact**:
- Automated quality gates before merge
- Catches vulnerabilities before deployment
- Ensures code quality standards

**Testing**: CI workflow syntax validated.

---

### 8. Documented CORS Configuration (Medium Priority)

**File**: `docs/CORS_CONFIG.md`

**Content**:
- Explains current architecture (Next.js proxy pattern)
- Documents why `credentials: false` is safe
- Provides guidance if direct browser calls are ever needed

**Impact**:
- Clear understanding of CORS posture
- Prevents accidental insecure changes
- Future-proofing documentation

---

## Testing Summary

Each change was tested individually:

1. **Agent log removal**: No linter errors, functionality verified
2. **Sentry config**: Env var loading verified, graceful degradation tested
3. **Error sanitization**: Verified no stack traces in responses
4. **Logging review**: Verified selective logging works correctly
5. **Docs alignment**: Verified accuracy against code
6. **CI pipeline**: Workflow syntax validated

## Next Steps

1. **Rotate Sentry DSN**: Follow `docs/SENTRY_DSN_ROTATION.md`
2. **Set environment variables** in all environments:
   - `SENTRY_DSN` (if using Sentry)
   - `SENTRY_SEND_DEFAULT_PII` (default: `'false'`)
3. **Deploy changes** following production readiness guide
4. **Monitor** for any issues after deployment

## Files Modified

- `src/services/authService.ts`
- `src/config/sentry.ts`
- `src/config/env.ts`
- `src/controllers/xeroController.ts`
- `src/controllers/invoiceController.ts`
- `docs/auth-model.md`
- `README.md`
- `.github/workflows/ci.yml` (new)
- `docs/SENTRY_DSN_ROTATION.md` (new)
- `docs/CORS_CONFIG.md` (new)
- `docs/BACKEND_HARDENING_CHANGELOG.md` (this file)



