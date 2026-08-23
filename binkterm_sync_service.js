/*
 * binkterm_sync_service.js
 *
 * Synchronet "Service" (see services.ini) that BinktermPHP calls to create
 * or verify a Synchronet user account for door-launch purposes, and to list
 * installed external programs (doors) so BinktermPHP can offer a
 * one-click import into its own RLogin door configuration.
 *
 * PROTOCOL
 * --------
 * One connection = one request/response. Client sends a single line of JSON,
 * server replies with a single line of JSON, then the connection closes.
 *
 * All requests carry an "action" field ("provision" or "list_doors").
 * "action" may be omitted for backward compatibility -- it then defaults to
 * "provision" (the only action this protocol had before list_doors existed).
 *
 * --- action: "provision" (default) ---
 *
 * Request:
 *   {"action":"provision","api_key":"<shared secret>","username":"awehttam","real_name":"...","location":"..."}
 *
 *   "real_name" and "location" are optional. When present they are applied
 *   to the account (both on creation and on an existing-account sync call).
 *
 * Response (success):
 *   {"success":true,"username":"awehttam","user_number":42,"created":true}
 *
 *   "created" is false if the account already existed and this call was a
 *   no-op sync check.
 *
 * Response (failure):
 *   {"success":false,"error":"reason"}
 *
 * --- action: "list_doors" ---
 *
 * Request:
 *   {"action":"list_doors","api_key":"<shared secret>"}
 *
 * Response (success):
 *   {"success":true,"doors":[{"code":"lord","name":"Legend of the Red Dragon","sec_code":"games","sec_name":"Games"}, ...]}
 *
 *   "code" is the door's internal xtrn program code -- the value BinktermPHP
 *   needs for the rlogin door's Terminal Type field ("xtrn=<code>") so
 *   Synchronet's door server routes straight into that program.
 *
 * Response (failure):
 *   {"success":false,"error":"reason"}
 *
 * SETUP
 * -----
 * 1. Copy this file to your Synchronet exec/ or mods/ directory.
 * 2. Change API_KEY below to a long random value (shared with BinktermPHP).
 * 3. In ctrl/services.ini add a section, e.g.:
 *
 *      [binkterm_sync]
 *      Port = 24512
 *      Command = binkterm_sync_service.js
 *      MaxClients = 5
 *
 *    No Options flags are needed -- the default (per-connection thread,
 *    handles one request then exits) is what this script expects. Do NOT
 *    set STATIC/LOOP; those are for long-running single-instance services
 *    (e.g. ircd.js) that manage their own client loop.
 * 4. Add BinktermPHP's IP address(es) to TRUSTED_IPS below. Connections
 *    from any other address are rejected before the request body is even
 *    parsed. Still bind the listening port to localhost or firewall it
 *    where practical -- the IP allowlist and API key are defense-in-depth,
 *    not a substitute for network restriction (spoofing/NAT edge cases,
 *    compromised hosts on the same LAN, etc.).
 * 5. Restart (or reload) the Services server.
 */

// ---- Configuration -------------------------------------------------------

var API_KEY = "CHANGE_ME_TO_A_LONG_RANDOM_SECRET";
var NEW_USER_PASSWORD_LENGTH = 24; // random password; trusted RLogin bypasses it anyway
var DEFAULT_SECURITY_LEVEL = 50; // User.level assigned to newly created accounts

// Only these IPs/subnets may call this service. Entries are either an exact
// address ("203.0.113.10", "::1") or CIDR notation ("203.0.113.0/24",
// "2001:db8::/32"). No hostname lookups are performed -- IP/CIDR only.
var TRUSTED_IPS = [
	"127.0.0.1",
	"::1"
	// "203.0.113.0/24",
	// "2001:db8:1::/64",
];

// ---- Helpers ---------------------------------------------------------

function ipv4ToInt(ip) {
	var parts = ip.split(".");
	if (parts.length !== 4) {
		return null;
	}
	var n = 0;
	for (var i = 0; i < 4; i++) {
		var octet = parseInt(parts[i], 10);
		if (isNaN(octet) || octet < 0 || octet > 255 || String(octet) !== parts[i].replace(/^0+(?=\d)/, "")) {
			return null;
		}
		n = (n * 256) + octet;
	}
	return n >>> 0;
}

function ipv6ToHextets(ip) {
	// Strip a zone index (e.g. "%eth0") if present.
	ip = ip.split("%")[0];

	var halves = ip.split("::");
	if (halves.length > 2) {
		return null; // malformed
	}

	var head = halves[0].length ? halves[0].split(":") : [];
	var tail = (halves.length === 2 && halves[1].length) ? halves[1].split(":") : [];

	if (halves.length === 1) {
		if (head.length !== 8) {
			return null;
		}
	} else {
		var missing = 8 - (head.length + tail.length);
		if (missing < 0) {
			return null;
		}
		var zeros = [];
		for (var i = 0; i < missing; i++) {
			zeros.push("0");
		}
		head = head.concat(zeros, tail);
	}

	if (head.length !== 8) {
		return null;
	}

	var hextets = [];
	for (var j = 0; j < 8; j++) {
		var v = parseInt(head[j], 16);
		if (isNaN(v) || v < 0 || v > 0xffff) {
			return null;
		}
		hextets.push(v);
	}
	return hextets;
}

function isIPv6(ip) {
	return ip.indexOf(":") !== -1;
}

function ipv4InCidr(ip, base, prefixLen) {
	var ipInt = ipv4ToInt(ip);
	var baseInt = ipv4ToInt(base);
	if (ipInt === null || baseInt === null || prefixLen < 0 || prefixLen > 32) {
		return false;
	}
	if (prefixLen === 0) {
		return true;
	}
	var mask = (0xffffffff << (32 - prefixLen)) >>> 0;
	return (ipInt & mask) === (baseInt & mask);
}

function ipv6InCidr(ip, base, prefixLen) {
	var ipHex = ipv6ToHextets(ip);
	var baseHex = ipv6ToHextets(base);
	if (ipHex === null || baseHex === null || prefixLen < 0 || prefixLen > 128) {
		return false;
	}
	var remaining = prefixLen;
	for (var i = 0; i < 8; i++) {
		if (remaining <= 0) {
			break;
		}
		var bits = Math.min(16, remaining);
		var mask = (0xffff << (16 - bits)) & 0xffff;
		if ((ipHex[i] & mask) !== (baseHex[i] & mask)) {
			return false;
		}
		remaining -= bits;
	}
	return true;
}

function isTrustedIp(ip) {
	for (var i = 0; i < TRUSTED_IPS.length; i++) {
		var entry = TRUSTED_IPS[i];

		if (entry.indexOf("/") === -1) {
			// Exact match entry.
			if (entry === ip) {
				return true;
			}
			continue;
		}

		// CIDR entry.
		var slash = entry.split("/");
		var base = slash[0];
		var prefixLen = parseInt(slash[1], 10);
		if (isNaN(prefixLen)) {
			continue;
		}

		if (isIPv6(ip) && isIPv6(base)) {
			if (ipv6InCidr(ip, base, prefixLen)) {
				return true;
			}
		} else if (!isIPv6(ip) && !isIPv6(base)) {
			if (ipv4InCidr(ip, base, prefixLen)) {
				return true;
			}
		}
		// Mixed families never match each other.
	}
	return false;
}

function randomPassword(length) {
	var chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
	var pw = "";
	for (var i = 0; i < length; i++) {
		pw += chars.charAt(random(chars.length));
	}
	return pw;
}

function sendResponse(obj) {
	writeln(JSON.stringify(obj));
}

// Strip control characters and clamp to maxLen (Synchronet's LEN_NAME /
// LEN_LOCATION fixed-width record fields). Returns null if the field was
// present but not a string.
function sanitizeField(value, maxLen) {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		return null;
	}
	return value.replace(/[\x00-\x1f\x7f]/g, "").substring(0, maxLen);
}

// List installed external programs (doors) from xtrn_area, grouped by
// section, flattened into one array. Each entry's "code" is what
// BinktermPHP needs for the rlogin Terminal Type "xtrn=<code>" handoff.
//
// NOTE: xtrn_area.sec_list / .prog_list property names are per Synchronet's
// documented JSObjects (XtrnSection / XtrnProgram). Not yet exercised
// against a live install for this action specifically -- verify the field
// names still match your Synchronet version if this comes back empty or
// throws, and check the Services server log for the caught exception.
function listDoors() {
	if (typeof xtrn_area === "undefined" || !xtrn_area || !xtrn_area.sec_list) {
		sendResponse({ success: false, error: "xtrn_area not available in this context" });
		return;
	}

	var doors = [];
	try {
		for (var i = 0; i < xtrn_area.sec_list.length; i++) {
			var sec = xtrn_area.sec_list[i];
			var progList = sec.prog_list || [];
			for (var j = 0; j < progList.length; j++) {
				var prog = progList[j];
				doors.push({
					code: prog.code,
					name: prog.name,
					sec_code: sec.code,
					sec_name: sec.name
				});
			}
		}
	} catch (e) {
		log(LOG_ERR, "binkterm_sync: list_doors failed: " + e);
		sendResponse({ success: false, error: "failed to enumerate xtrn_area: " + e });
		return;
	}

	sendResponse({ success: true, doors: doors });
}

// ---- Main ------------------------------------------------------------

if (!isTrustedIp(client.ip_address)) {
	log(LOG_WARNING, "binkterm_sync: rejected connection from untrusted IP " + client.ip_address);
	sendResponse({ success: false, error: "connection not permitted from this address" });
	exit();
}

var requestLine = readln(4096);

if (requestLine === undefined || requestLine === null || requestLine === "") {
	sendResponse({ success: false, error: "empty request" });
	exit();
}

var req;
try {
	req = JSON.parse(requestLine);
} catch (e) {
	sendResponse({ success: false, error: "invalid JSON: " + e });
	exit();
}

if (req.api_key !== API_KEY) {
	log(LOG_WARNING, "binkterm_sync: rejected request with bad api_key from trusted IP " + client.ip_address);
	sendResponse({ success: false, error: "unauthorized" });
	exit();
}

var action = req.action || "provision";

if (action === "list_doors") {
	listDoors();
	exit();
}

if (action !== "provision") {
	sendResponse({ success: false, error: "unknown action: " + action });
	exit();
}

if (!req.username || typeof req.username !== "string") {
	sendResponse({ success: false, error: "missing username" });
	exit();
}

// Strip anything unsafe out of the incoming username.
var fullUsername = req.username.replace(/[^A-Za-z0-9_\-\.]/g, "");
if (fullUsername.length === 0) {
	sendResponse({ success: false, error: "username invalid after sanitization" });
	exit();
}

// Truncate to Synchronet's alias length limit (25 chars) if needed.
if (fullUsername.length > 25) {
	fullUsername = fullUsername.substring(0, 25);
}

// LEN_NAME=25, LEN_LOCATION=30 (see sbbsdefs.h). Both optional.
var realName = sanitizeField(req.real_name, 25);
if (realName === null) {
	sendResponse({ success: false, error: "real_name must be a string" });
	exit();
}
var location = sanitizeField(req.location, 30);
if (location === null) {
	sendResponse({ success: false, error: "location must be a string" });
	exit();
}

// ---- Check for existing account ---------------------------------------

var existingNum = system.matchuser(fullUsername, false);

if (existingNum > 0) {
	if (realName !== undefined || location !== undefined) {
		var existingUser = new User(existingNum);
		if (realName !== undefined) {
			existingUser.name = realName;
		}
		if (location !== undefined) {
			existingUser.location = location;
		}
	}

	sendResponse({
		success: true,
		username: fullUsername,
		user_number: existingNum,
		created: false
	});
	exit();
}

// ---- Create new account -------------------------------------------------

if (!system.check_name(fullUsername, true)) {
	sendResponse({ success: false, error: "username rejected by system.check_name (invalid or not unique)" });
	exit();
}

var newUser;
try {
	// new_user() throws a JS exception (rather than returning an error code)
	// when check_name() would have rejected the name -- we already checked
	// that above, but a race with another connection could still hit it.
	newUser = system.new_user(fullUsername);
} catch (e) {
	log(LOG_ERR, "binkterm_sync: system.new_user() threw for " + fullUsername + ": " + e);
	sendResponse({ success: false, error: "account creation failed: " + e });
	exit();
}

if (typeof newUser !== "object") {
	log(LOG_ERR, "binkterm_sync: system.new_user() failed with code " + newUser + " for " + fullUsername);
	sendResponse({ success: false, error: "account creation failed (code " + newUser + ")" });
	exit();
}

// Set a random password. Real auth for this account is expected to happen
// via a trusted RLogin relationship configured for BinktermPHP's IP, not
// this password -- see project notes on the RLogin xtrn= handoff.
newUser.password = randomPassword(NEW_USER_PASSWORD_LENGTH);
newUser.level = DEFAULT_SECURITY_LEVEL;

if (realName !== undefined) {
	newUser.name = realName;
}
if (location !== undefined) {
	newUser.location = location;
}

log(LOG_INFO, "binkterm_sync: created user #" + newUser.number + " (" + fullUsername + ")");

sendResponse({
	success: true,
	username: fullUsername,
	user_number: newUser.number,
	created: true
});

exit();