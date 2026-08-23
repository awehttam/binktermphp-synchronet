# binktermphp-synchronet

A Synchronet `services.ini` service that lets [BinktermPHP](https://github.com/) remotely
provision (or verify) Synchronet user accounts, so BinktermPHP users can be handed off into
Synchronet doors/games without a manual signup step.

## Status

Early scaffolding. The JS service (`binktermphp-api.js`) is drafted but **untested** -- it
has not been run against a live Synchronet install yet. Testing happens on a remote
Synchronet system, not locally.

## How it works

One TCP connection = one request/response, then the connection closes.

Request:

```json
{"api_key":"<shared secret>","username":"awehttam","real_name":"...","location":"..."}
```

`real_name` and `location` are optional. When present they're applied to the account, both
on creation and on an existing-account sync call.

Response (success):

```json
{"success":true,"username":"awehttam","user_number":42,"created":true}
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
   Command = binkterm_sync_service.js
   MaxClients = 5
   ```

   No `Options` flags are needed -- the default (one thread per connection, handles a
   single request then exits) is what this script expects. Do not set `STATIC`/`LOOP`;
   those are for long-running single-instance services (e.g. `ircd.js`) that manage
   their own client loop.

4. Add BinktermPHP's IP address(es) to `TRUSTED_IPS` in the file. Connections from any other
   address are rejected before the request body is parsed. The IP allowlist and API key are
   defense-in-depth, not a substitute for firewalling the port.
5. Restart (or reload) the Services server.

## Before trusting this in production

- Decide whether provisioned accounts need an explicit `User.security.level`.
- Run an end-to-end test against a real Synchronet system (create, then re-sync an existing
  user) before wiring BinktermPHP to call this in production.

## License

MIT -- see [LICENSE](LICENSE).
