# Auth, Organisation & Location API

## Authentication Flow (Standard Login)

1. **Login** -> Receive `access_token_login` & `refresh_token_login`
2. **Select Organisation** -> Receive `access_token_company` & `refresh_token_company`
3. **Select Location** -> Receive final `access_token` & `refresh_token`

All operational endpoints (Xero, etc.) require the final `access_token` (or `access_token_company` for org-level ops).

## Onboarding Flow (New User)

The onboarding flow decouples user creation from the initial steps. A User record is ONLY created after a venue (Organisation + Location) is established.

1. **Start Onboarding (Step 1)**: User enters account details (stored in FE state).
2. **Establish Venue (Step 2)**:
    - **Option A (Xero)**: `GET /xero/authorise/start` -> Redirect -> `GET /xero/authorise`. Creates `OnboardingSession` (mode: xero) -> Org -> Location(s).
    - **Option B (Manual)**: `POST /organisations/onboard/manual`. Creates `OnboardingSession` (mode: manual) -> Org -> Location.
3. **Final Registration (Step 3)**: `POST /auth/register-onboard`.
    - Input: User details + `onboardingSessionId` + `selectedLocationId`.
    - Action: Creates User, UserSettings, UserOrganisation (Owner). Completes Session.
    - Output: Final `access_token` & `refresh_token` for the selected location.

## Endpoints

### POST /auth/register-onboard
Final step of the onboarding flow. Registers the user and links them to the onboarded venue.
**Body:**
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@example.com",
  "password": "secret_password",
  "confirmPassword": "secret_password",
  "acceptedTerms": true,
  "acceptedPrivacy": true,
  "onboardingSessionId": "uuid-of-session",
  "selectedLocationId": "uuid-of-location"
}
```
**Response:**
```json
{
  "user_id": "user-uuid",
  "profile_picture": null,
  "organisation": { "id": "org-uuid", "name": "My Cafe Group" },
  "location": { "id": "loc-uuid", "name": "Main Store" },
  "access_token": "jwt_final_access...",
  "refresh_token": "jwt_final_refresh...",
  "type": "bearer",
  "expires_in": 900
}
```

### POST /organisations/onboard/manual
Creates an Organisation and Location *without* a User, linked to an Onboarding Session.
**Body:**
```json
{
  "venueName": "My Manual Cafe",
  "onboardingSessionId": "optional-uuid" 
}
```
**Response:**
```json
{
  "onboardingSessionId": "session-uuid",
  "organisationId": "org-uuid",
  "locationId": "loc-uuid",
  "organisationName": "My Manual Cafe",
  "locationName": "My Manual Cafe"
}
```

### GET /xero/authorise/start
Starts Xero OAuth flow.
**Query:** `?onboardingSessionId=optional-uuid`
**Response:** `{ "redirectUrl": "https://login.xero.com/..." }`

### GET /xero/authorise
Callback from Xero. Creates Org & Locations from Xero data, linked to session.
**Query:** `?code=...&state=...`
**Response:**
```json
{
  "onboardingSessionId": "session-uuid",
  "organisationId": "org-uuid",
  "organisationName": "Xero Imported Org",
  "locations": [
    { "id": "loc-1", "name": "Main Branch" },
    { "id": "loc-2", "name": "Second Branch" }
  ]
}
```

### POST /auth/login
Authenticate user (Standard Flow).
**Body:** `{ "email": "...", "password": "..." }`
**Response:**
```json
{
  "user_id": "uuid",
  "profile_picture": "url_or_null",
  "companies": [
    { "id": "org_uuid", "name": "Org Name" }
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
    { "id": "loc_uuid", "name": "Location Name" }
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
