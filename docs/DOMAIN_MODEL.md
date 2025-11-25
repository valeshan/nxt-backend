# Authentication & Tokens

## User Model
(No changes required, assume existing model fits)

## Token Types

| Step | Access Token | Refresh Token |
| :--- | :--- | :--- |
| Login | `access_token_login` | `refresh_token_login` |
| Org | `access_token_company` | `refresh_token_company` |
| Location | `access_token` | `refresh_token` |

- **Login Level**: Returned by `/auth/login`. Used to select organisation.
- **Organisation Level**: Returned by `/auth/select-organisation`. Used to select location.
- **Location Level (Final)**: Returned by `/auth/select-location`. Used for all operational API calls.

## Claims
(Standard JWT claims: `sub` (user_id), `exp`, `iat`, `type` (access/refresh + level), `orgId`, `locId` as applicable)
