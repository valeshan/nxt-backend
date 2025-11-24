# API: Xero Integrations

**Base URL**: `/`

## Authentication
All endpoints require a Bearer Token in the `Authorization` header.
`Authorization: Bearer <JWT>`

---

## 1. Create Connection
Creates a new Xero connection record with encrypted tokens.

- **Method**: `POST`
- **Path**: `/xero/connections`
- **Request Body**: `application/json`
  ```json
  {
    "organisationId": "string",
    "xeroTenantId": "string",
    "accessToken": "string",
    "refreshToken": "string",
    "accessTokenExpiresAt": "string (ISO 8601)"
  }
  ```
- **Response**: `200 OK`
  - Returns the created `XeroConnection` object (excluding sensitive tokens in the DTO/Response typically, but currently returns full object for simplicity).

## 2. Link Locations
Links one or more locations to an existing Xero connection.

- **Method**: `POST`
- **Path**: `/xero/connections/:connectionId/locations`
- **Request Body**: `application/json`
  ```json
  {
    "organisationId": "string", // Must match the connection's organisationId
    "locationIds": ["string", "string"]
  }
  ```
- **Response**: `200 OK`
  - Returns the updated connection with `locationLinks`.
- **Errors**:
  - `403 Forbidden`: If `organisationId` does not match the connection's owner.
  - `404 Not Found`: If connection does not exist.

## 3. List Connections
Retrieves all connections for a given organisation.

- **Method**: `GET`
- **Path**: `/xero/connections`
- **Query Parameters**:
  - `organisationId` (required): The external organisation ID.
- **Response**: `200 OK`
  - Array of `XeroConnection` objects, including their `locationLinks`.

