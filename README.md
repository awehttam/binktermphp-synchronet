# binktermphp-synchronet

A Synchronet `services.ini` service that lets [BinktermPHP](https://github.com/) remotely
provision (or verify) Synchronet user accounts, so BinktermPHP users can be handed off into
Synchronet doors/games without a manual signup step.

Accounts created by this service are prefixed `bt-` so they're always identifiable in the
Synchronet user list as BinktermPHP-provisioned.

## Status

Early scaffolding. The JS service (`binktermphp-api.js`) is drafted but **untested** -- it
has not been run against a live Synchronet install yet. Testing happens on a remote
Synchronet system, not locally.

## How it works

One TCP connection = one request/response, then the connection closes.

Request:

```json
{"api_key":"<shared secret>","username":"awehttam"}
```

Response (success):

```json
{"success":true,"username":"bt-awehttam","user_number":42,"created":true}
```

`created` is `false` if the account already existed and the call was just a sync/lookup.

Response (failure):

```json
{"success":false,"error":"reason"}
```

## Setup

1. Copy `binktermphp-api.js` to your Synchronet `exec/` or `mods/` directory.
2. Change `API_KEY` in the file to a long random value, shared with BinktermPHP.
3. Add a section to `ctrl/services.ini`, e.g.:

   ```ini
   [binkterm_sync]
   Port = 24512
   Protocol = tcp
   Command = binkterm_sync_service.js
   MaxClients = 5
   Options = STATIC_OUT
   ```

   Cross-check directive names/casing against an existing `[service]` block in your own
   `services.ini` -- these vary a bit by Synchronet version.

4. Add BinktermPHP's IP address(es) to `TRUSTED_IPS` in the file. Connections from any other
   address are rejected before the request body is parsed. The IP allowlist and API key are
   defense-in-depth, not a substitute for firewalling the port.
5. Restart (or reload) the Services server.

## Before trusting this in production

- Confirm `newUser.password` is the correct property name for your installed Synchronet
  version (check `jsobjs.html` shipped with your install, "User class" section).
- Decide whether `bt-` accounts need an explicit `User.security.level`.
- Run an end-to-end test against a real Synchronet system (create, then re-sync an existing
  user) before wiring BinktermPHP to call this in production.

## License

MIT -- see [LICENSE](LICENSE).
