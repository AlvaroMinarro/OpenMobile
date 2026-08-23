# Bridge Auth Specification

## Purpose

Opt-in authentication for the localhost bridge: issued short-lived bearer tokens seeded from the existing secret knob, carried on REST via `Authorization` and in browsers via WS subprotocol (custom WS headers do not exist), with timing-safe validation, credential hygiene, and CORS narrowing while enabled. Off by default — with no seed configured, the bridge behaves byte-identically to the legacy loopback-trust surface.

## Requirements

### Requirement: Opt-In Authentication Gate

Bridge authentication MUST be opt-in, enabled solely by a seed secret supplied through environment or config (the existing secret knob). With no seed configured, every REST route and WS upgrade MUST behave byte-identically to the legacy unauthenticated bridge (same statuses, bodies, headers; no 401s). With a seed configured, EVERY `/v1` route — pre-existing and newly added — and every WS upgrade MUST require valid credentials. Sole sanctioned exception: CORS `OPTIONS` preflight requests are answered `204` without credentials while auth is on — browser preflights cannot carry custom headers (the same constraint that motivates subprotocol WS carry); the narrowed `Access-Control-Allow-Origin` rules apply to these preflights and are tested.

#### Scenario: Auth unset keeps legacy behavior

- GIVEN the bridge started with no seed secret configured
- WHEN any REST route is called without an Authorization header
- THEN it responds byte-for-byte as the legacy unauthenticated bridge

#### Scenario: Auth enabled rejects anonymous access

- GIVEN the bridge started with a seed secret configured
- WHEN a protected REST route is called without credentials
- THEN it responds 401 with an `application/json` body shaped `{error:{code,message}}`

### Requirement: Token Issuance Endpoint

The bridge MUST expose `POST /v1/auth/token`, authenticated by the seed secret presented as bearer credential. On success it MUST return JSON `{token, expiresAt, ttlSeconds}` where `expiresAt` is an absolute ISO-8601 timestamp. The token TTL MUST be bounded — default 3600 seconds, configurable, with a server-enforced upper cap. Issued tokens MUST be honored on protected REST routes and WS upgrades until expiry; the seed secret MUST remain valid as a long-lived admin credential on those same routes.

#### Scenario: Issue token with valid seed

- GIVEN auth is enabled with seed secret S
- WHEN `POST /v1/auth/token` carries `Authorization: Bearer S`
- THEN it responds 200 with a token string and a future `expiresAt` timestamp

#### Scenario: Issue rejected without seed

- GIVEN auth is enabled
- WHEN `POST /v1/auth/token` is called with a wrong or missing bearer credential
- THEN it responds 401 with code `unauthorized` and issues no token

### Requirement: Token Expiry Validation

Protected routes MUST validate presented credentials in timing-safe fashion, accepting the seed secret or an issued token whose expiry has not passed. An expired token MUST yield 401 with code `token_expired`; an unknown credential MUST yield 401 with code `unauthorized`. Expired tokens MUST NOT authenticate any route or WS upgrade.

#### Scenario: Fresh token accepted

- GIVEN a freshly issued token
- WHEN it is used as bearer on a protected route such as `GET /v1/state`
- THEN the route returns its normal authenticated result

#### Scenario: Expired token rejected

- GIVEN an issued token whose expiry has passed (minted with minimal TTL via test config)
- WHEN it is used as bearer on a protected route
- THEN the response is 401 with code `token_expired`

### Requirement: WebSocket Subprotocol Authentication

Browser WS handshakes MUST authenticate by carrying the credential as requested subprotocol `openmobile.bearer.<credential>`, validated during the upgrade itself. Handshakes bearing a malformed, unknown, or expired subprotocol credential MUST fail the upgrade — the client observes a failed handshake or immediate server close, never an open socket. Passing credentials in the URL query string MUST be treated as presenting no credential.

#### Scenario: Valid subprotocol upgrade

- GIVEN auth is enabled and a freshly issued token T
- WHEN a client requests `WS /v1/logcat/ws` with subprotocol `openmobile.bearer.T`
- THEN the upgrade succeeds and the socket opens

#### Scenario: Wrong subprotocol rejected

- GIVEN auth is enabled
- WHEN a client requests the upgrade with subprotocol `openmobile.bearer.wrong`, or none at all
- THEN the handshake fails with a 401-class response and no open socket results

#### Scenario: Query-param credential refused

- GIVEN auth is enabled and a valid token T
- WHEN a client requests `WS /v1/logcat/ws?token=T`
- THEN the upgrade is rejected exactly as when no credential is presented

### Requirement: Credential Hygiene

Seed secrets and issued tokens MUST NOT appear in logs, error response bodies, or URLs, and error messages MUST NOT echo presented credentials. Credential comparison MUST be timing-safe. Redaction applies to request logging and error serialization alike.

#### Scenario: Failed auth leaks nothing

- GIVEN auth is enabled
- WHEN a request presents an invalid bearer credential
- THEN the 401 body contains no echo of the credential and bridge logs contain no credential material

### Requirement: CORS Narrowing While Authenticated

While authentication is enabled, the bridge MUST NOT reflect arbitrary Origins as `Access-Control-Allow-Origin`: only explicitly allow-listed origins (default: none) are reflected. Unsetting the seed restores legacy permissive CORS behavior unchanged.

#### Scenario: Cross-origin blocked while auth on

- GIVEN auth is enabled with an empty origin allow-list
- WHEN a request arrives with `Origin: https://evil.example`
- THEN the response carries no matching `Access-Control-Allow-Origin` reflection
