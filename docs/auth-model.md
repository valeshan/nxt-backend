# Authentication & Authorisation Model

The backend (`nxt-backend`) enforces strict authentication and authorisation using JWTs (JSON Web Tokens) as the single source of truth. Client-supplied headers (`x-org-id`, `x-location-id`, `x-user-id`) are **ignored** for access control decisions.

## Token Types

The system uses three distinct types of access tokens, differentiated by the `tokenType` claim and the presence of context IDs.

### 1. Login Token (`tokenType: 'login'`)
- **Purpose**: Initial authentication. Allows listing organisations and creating new ones.
- **Claims**:
  - `sub`: User ID
  - `tokenType`: `'login'`
  - `roles`: `[]` (Empty, as roles are org-specific)
- **Allowed Endpoints**:
  - `/organisations` (List/Create)
  - `/auth/select-organisation`
  - `/auth/select-location`

### 2. Organisation Token (`tokenType: 'organisation'`)
- **Purpose**: Access organisation-level resources (e.g., Suppliers, Settings).
- **Claims**:
  - `sub`: User ID
  - `orgId`: Organisation ID
  - `tokenType`: `'organisation'`
  - `roles`: `['owner', 'member', ...]` (Role within this organisation)
- **Allowed Endpoints**:
  - All endpoints requiring organisation context.
  - `/suppliers` (Read/Write)
  - `/organisations/:id` details

### 3. Location Token (`tokenType: 'location'`)
- **Purpose**: Access location-specific data (e.g., Supplier Insights, Spend Analysis).
- **Claims**:
  - `sub`: User ID
  - `orgId`: Organisation ID
  - `locId`: Location ID
  - `tokenType`: `'location'`
  - `roles`: `['owner', 'member', ...]` (Inherited from Org)
- **Allowed Endpoints**:
  - All endpoints requiring location context.
  - `/supplier-insights/*`
  - Can also access organisation-level endpoints (inherits access).

## AuthContext

The `AuthContext` plugin runs on all protected routes. It verifies the JWT and attaches a strongly-typed `authContext` object to the request.

```typescript
interface AuthContext {
  userId: string;
  organisationId?: string | null;
  locationId?: string | null;
  tokenType: 'login' | 'organisation' | 'location';
  roles: string[];
}
```

**Usage in Controllers:**
Controllers MUST read context from `request.authContext`.

```typescript
const { organisationId, locationId } = request.authContext;
// Use these IDs for DB queries. NEVER use request.headers['x-org-id'].
```

## Authorization Rules

1.  **Single Source of Truth**: The JWT is the only trusted source for `userId`, `organisationId`, and `locationId`.
2.  **Strict Header Policy**: Client-supplied headers like `x-org-id` and `x-location-id` are ignored for authorisation. They must not be used for deciding which tenant’s data to query. They may be logged for debugging purposes only.
3.  **Context Guards**:
    - **Org-Level Routes**: Must verify `authContext.organisationId` exists and `tokenType` is `'organisation'` or `'location'`. Return `403` otherwise.
    - **Location-Level Routes**: Must verify `authContext.locationId` exists and `tokenType` is `'location'`. Return `403` otherwise.

## Xero Webhooks Exception

Public webhooks (e.g., Xero) are exempt from JWT checks as they use signature verification. These endpoints are explicitly excluded from the `AuthContext` plugin registration.


