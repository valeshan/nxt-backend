# CORS Configuration

## Current Architecture

The backend API is **not** called directly from browsers. All requests go through a Next.js proxy (`/api/be/[...path]`) running on the same origin as the frontend.

**Request Flow:**
```
Browser → Next.js Proxy (/api/be/...) → Backend API
```

## Current CORS Settings

- **Development**: Allows `http://localhost:3000` (Next.js dev server)
- **Production**: Allows `FRONTEND_URL` environment variable (default: `https://app.thenxt.ai`)
- **Credentials**: `false` (not needed since requests go through proxy)
- **Methods**: `GET, POST, PUT, PATCH, DELETE, OPTIONS`
- **Headers**: `Content-Type`, `Authorization`, `x-xero-signature`, `x-request-id`

## Why `credentials: false` is Safe

Since all requests go through the Next.js proxy:
1. The browser never directly calls the backend
2. Cookies are handled server-side by the Next.js proxy
3. No CORS preflight with credentials is needed
4. This reduces attack surface (no CSRF concerns from CORS)

## If Direct Browser Calls Are Needed

If you ever need to call the backend directly from the browser (not recommended), you would need to:

1. **Update CORS config** (`src/app.ts`):
   ```typescript
   app.register(cors, {
     origin: config.FRONTEND_URL ? [config.FRONTEND_URL] : false,
     credentials: true, // Enable credentials
     allowedHeaders: corsAllowedHeaders,
   });
   ```

2. **Ensure secure cookies**:
   - Backend must set cookies with `Secure`, `SameSite=None` (for cross-origin)
   - Or use `SameSite=Lax` if same-site

3. **Update frontend**:
   - Set `credentials: 'include'` in fetch requests
   - Handle CORS preflight (OPTIONS) requests

4. **Security considerations**:
   - CSRF protection becomes critical
   - Consider CSRF tokens or SameSite cookie policies
   - Validate `Origin` header server-side

## Configuration Location

CORS is configured in `src/app.ts` lines 104-125.



