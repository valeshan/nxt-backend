# Auth, Organisation & Location API

## Authentication Flow

1. **Login** -> Receive `access_token_login` & `refresh_token_login`
2. **Select Organisation** -> Receive `access_token_company` & `refresh_token_company`
3. **Select Location** -> Receive final `access_token` & `refresh_token`

All operational endpoints (Xero, etc.) require the final `access_token` (or `access_token_company` for org-level ops).

## Endpoints

### POST /auth/register
Register a new user.
**Body:** `{ "email": "...", "password": "...", "name": "..." }`
**Response:** User object (no password).

### POST /auth/login
Authenticate user.
**Body:** `{ "email": "...", "password": "..." }`
**Response:**
```json
{
  "user_id": "uuid",
  "profile_picture": "url_or_null",
  "companies": [
    { "uuid": "org_uuid", "name": "Org Name" }
  ],
  "access_token": "jwt_login_access...",
  "refresh_token": "jwt_login_refresh...",
  "type": "bearer",
  "expires_in": 900
}
```

### POST /auth/refresh
Refresh an expired access token using a valid refresh token. Returns same-level tokens.
**Body:** `{ "refresh_token": "..." }`
**Response:**
```json
{
  "access_token": "new_jwt_access...",
  "refresh_token": "new_jwt_refresh...",
  "type": "bearer",
  "expires_in": 900
}
```

### POST /auth/select-organisation
**Headers:** `Authorization: Bearer <login_access_token>`
**Body:** `{ "organisationId": "..." }`
**Response:**
```json
{
  "user_id": "uuid",
  "profile_picture": "url_or_null",
  "locations": [
    { "uuid": "loc_uuid", "name": "Location Name" }
  ],
  "access_token": "jwt_company_access...",
  "refresh_token": "jwt_company_refresh...",
  "type": "bearer",
  "expires_in": 900
}
```

### POST /auth/select-location
**Headers:** `Authorization: Bearer <company_access_token>`
**Body:** `{ "locationId": "..." }`
**Response:**
```json
{
  "user_id": "uuid",
  "profile_picture": "url_or_null",
  "access_token": "jwt_final_access...",
  "refresh_token": "jwt_final_refresh...",
  "type": "bearer",
  "expires_in": 900,
  "user_settings": {}
}
```
