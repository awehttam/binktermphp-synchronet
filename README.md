# binktermphp-synchronet

A Synchronet `services.ini` service that lets [BinktermPHP](https://github.com/) remotely
provision (or verify) Synchronet user accounts, so BinktermPHP users can be handed off into
Synchronet doors/games via RLogin, without a manual signup step.

## Status

Tested against a live Synchronet install (create and re-sync of an existing user), on a
remote Synchronet system -- not locally.

## How it works

One TCP connection = one request/response, then the connection closes. Every request carries
an `action` field; it may be omitted, in which case it defaults to `provision` (the only
action this protocol had before `list_doors` was added).

### `action: "provision"` (default)

Request:

```json
{"action":"provision","api_key":"<shared secret>","username":"awehttam","real_name":"...","location":"..."}
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

### `action: "list_doors"`

Lists installed external programs (doors) so BinktermPHP can offer a one-click import into
its own RLogin door configuration.

Request:

```json
{"action":"list_doors","api_key":"<shared secret>"}
```

Response (success):

```json
{"success":true,"doors":[{"code":"lord","name":"Legend of the Red Dragon","sec_code":"games","sec_name":"Games","description":"...","author":"...","categories":["Games","RPG"]}]}
```

`code` is the door's internal xtrn program code -- the value BinktermPHP needs for the rlogin
door's Terminal Type field (`xtrn=<code>`) so Synchronet's door server routes straight into
that program. Not yet exercised against a live install; see the note in
`binkterm_sync_service.js` if this comes back empty.

`description`, `author`, and `categories` are best-effort: Synchronet's own `xtrn.ini` record
has no such fields, so the service opportunistically re-reads the door's `install-xtrn.ini`
(the `Desc:`/`By:`/`Cats:`/`Subs:` header lines most doors were installed from) and includes
whatever it finds. They're simply omitted for doors with no `install-xtrn.ini` on disk.

Response (failure):

```json
{"success":false,"error":"reason"}
```

## Setup

1. Copy `binkterm_sync_service.js` to your Synchronet `exec/` or `mods/` directory.
2. Copy `binkterm_sync_service.ini.example` to `ctrl/binkterm_sync_service.ini` and edit it --
   at minimum, set `api_key` to a long random value shared with BinktermPHP, and add
   BinktermPHP's IP address(es) to `trusted_ips`. Also review `default_security_level`
   (defaults to `50`), the `User.level` assigned to newly created accounts. Keeping these
   settings in `ctrl/binkterm_sync_service.ini` instead of hand-editing the script means a
   later update to `binkterm_sync_service.js` (e.g. a `git pull`) never loses your
   configuration -- see the comments in the `.ini.example` file for the full key list.
3. Add a section to `ctrl/services.ini`, e.g.:

   ```ini
   [binkterm_sync]
   Port = 24512
   Command = binkterm_sync_service.js
   MaxClients = 5
   ```

   Do not set `STATIC`/`LOOP` in `Options`; those are for long-running single-instance
   services (e.g. `ircd.js`) that manage their own client loop, not the
   one-thread-per-connection model this script expects.

4. Connections from any IP not listed in `trusted_ips` are rejected before the request body
   is parsed. The IP allowlist and API key are defense-in-depth, not a substitute for
   firewalling the port.
5. Restart (or reload) the Services server. `ctrl/binkterm_sync_service.ini` itself, once step 2
   is done, is re-read on every connection -- only changes to the script's own code require a
   Services server restart, not config-only changes.

## TLS

BinktermPHP's client defaults to requiring TLS on this connection. To match, add
`Options = TLS` to the `services.ini` section:

```ini
[binkterm_sync]
Port = 24512
Command = binkterm_sync_service.js
MaxClients = 5
Options = TLS
```

The Services server terminates TLS before `binkterm_sync_service.js` ever sees the socket, so
no changes to the script itself are needed. It uses the same certificate/key as every other
TLS-enabled Synchronet service (`ctrl/ssl.cert`), configured under SCFG -> System -> Security
-- generate a self-signed certificate there if you don't already have one.

On the BinktermPHP side, `"tls": true` in `config/rlogin_synchronet_service.json` is the default
(it applies even if the key is left out of the file entirely) -- no changes are needed there
unless you're deliberately running without TLS, in which case set `"tls": false` explicitly and
leave `Options = TLS` off here too. BinktermPHP's client accepts a self-signed certificate by
default (`"tls_verify_peer": false`), since this is typically a LAN/localhost link between two
systems the same sysop controls; set `"tls_verify_peer": true` (and optionally `"tls_cafile"`)
for strict verification against a CA-signed certificate instead. Whichever you choose, `Options`
here and BinktermPHP's `tls` setting must agree -- a TLS client cannot reach a plaintext-only
service, or vice versa.

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
