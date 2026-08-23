# binktermphp-synchronet

A Synchronet `services.ini` service that lets [BinktermPHP](https://github.com/) remotely
provision (or verify) Synchronet user accounts, so BinktermPHP users can be handed off into
Synchronet doors/games without a manual signup step.

## Status

Tested against a live Synchronet install (create and re-sync of an existing user), on a
remote Synchronet system -- not locally.

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

1. Copy `binkterm_sync_service.js` to your Synchronet `exec/` or `mods/` directory.
2. Change `API_KEY` in the file to a long random value, shared with BinktermPHP. Also
   review `DEFAULT_SECURITY_LEVEL` (defaults to `50`), the `User.level` assigned to
   newly created accounts.
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

## RLogin security

Accounts provisioned by this service are meant to be reached via a trusted RLogin
handoff from BinktermPHP, since RLogin itself does no authentication -- whoever can
connect as a given username is logged in as that user, no password required.

Restrict `ctrl/rlogin.cfg` to only the IP address(es) BinktermPHP connects from (one
per line; wildcards `*` are allowed). Any address not listed there must not be able to
reach your BBS's RLogin port at all -- firewall it in addition to the allowlist. Treat
this the same way as `TRUSTED_IPS` above: both lists need to be kept in sync and both
are defense-in-depth around network restriction, not a replacement for it.

## License

MIT -- see [LICENSE](LICENSE).
