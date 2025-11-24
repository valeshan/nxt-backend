# Domain Model

## Entities

### XeroConnection
Represents a link between an external Organisation (from BE1) and a Xero Tenant.

**Fields:**
- `id`: Unique identifier (CUID).
- `organisationId`: The external ID of the organisation in BE1.
- `xeroTenantId`: The ID of the tenant in Xero.
- `accessTokenEncrypted`: Encrypted OAuth2 access token.
- `refreshTokenEncrypted`: Encrypted OAuth2 refresh token.
- `accessTokenExpiresAt`: Timestamp when the current access token expires.
- `status`: Current status (`active`, `revoked`, `error`).
- `createdAt`, `updatedAt`: Timestamps.

**Invariants:**
- An organisation can have multiple connections (though typically one per tenant).
- Tokens are always stored encrypted.

### XeroLocationLink
Represents a link between a Xero Connection and an external Location (from BE1). This allows mapping specific locations in the main system to the connected Xero account (e.g., for payroll or accounting purposes).

**Fields:**
- `id`: Unique identifier (CUID).
- `xeroConnectionId`: Foreign key to `XeroConnection`.
- `locationId`: The external ID of the location in BE1.
- `createdAt`, `updatedAt`: Timestamps.

**Invariants:**
- A location link must belong to a valid `XeroConnection`.
- The pair `[xeroConnectionId, locationId]` is unique (no duplicate links).
- **Business Rule**: A location should only be linked if it belongs to the same organisation as the connection (verified at application level during creation).

