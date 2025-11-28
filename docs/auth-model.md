# Authentication & Authorization Model

## Overview

The system uses a secure, stateful-frontend / stateless-backend authentication model powered by JWTs and HttpOnly cookies.

## Authentication Flow

1.  **Login**:
    *   Frontend sends credentials to Next.js Proxy (`/api/auth/login`).
    *   Proxy forwards to Backend (`/auth/login`).
    *   Backend validates and returns `access_token` (15m) and `refresh_token` (7d).
    *   Proxy sets these tokens as **HttpOnly, Secure, SameSite=Lax** cookies.
    *   Client JS **never** sees the raw tokens.

2.  **Authenticated Requests**:
    *   Client makes requests to Next.js Proxy (`/api/be/...`).
    *   Proxy automatically attaches the cookies to the request forwarded to Backend.
    *   Backend validates `access_token` via `authContextPlugin`.

3.  **Silent Refresh**:
    *   When an API call fails with `401 Unauthorized`:
    *   Frontend Axios interceptor catches the error.
    *   It pauses all outgoing requests (Mutex).
    *   It calls Next.js Proxy (`/api/auth/refresh`).
    *   Proxy reads `refresh_token` cookie and calls Backend (`/auth/refresh`).
    *   Backend validates and rotates tokens.
    *   Proxy updates the HttpOnly cookies with new values (and new Max-Age).
    *   Frontend retries the original failed request.

## Xero Integration

*   **Just-in-Time Refresh**:
    *   We do **not** rely on background cron jobs to keep Xero tokens alive.
    *   Before any Xero API call, the backend service calls `XeroService.getValidConnection(id)`.
    *   This method checks if the stored token is expired or expiring in < 5 minutes.
    *   If expiring, it synchronously refreshes the token with Xero and updates the DB.
    *   It returns a valid, decrypted access token for immediate use.

## Security Measures

*   **CORS**: strictly limited to Frontend URL in production.
*   **Cookies**: HttpOnly to prevent XSS token theft.
*   **CSRF**: Mitigated by SameSite=Lax (sufficient for this architecture).
*   **Database**: Connection pooling configured to prevent exhaustion.
