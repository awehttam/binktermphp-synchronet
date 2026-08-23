/*
 * binkterm_sync_service.js
 *
 * Synchronet "Service" (see services.ini) that BinktermPHP calls to create
 * or verify a Synchronet user account for door-launch purposes.
 *
 * PROTOCOL
 * --------
 * One connection = one request/response. Client sends a single line of JSON,
 * server replies with a single line of JSON, then the connection closes.
 *
 * Request:
 *   {"api_key":"<shared secret>","username":"awehttam"}
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
 * SETUP
 * -----
 * 1. Copy this file to your Synchronet exec/ or mods/ directory.
 * 2. Change API_KEY below to a long random value (shared with BinktermPHP).
 * 3. In ctrl/services.ini add a section, e.g.:
 *
 *      [binkterm_sync]
 *      Port = 24512
 *      Protocol = tcp
 *      Command = binkterm_sync_service.js
 *      MaxClients = 5
 *      Options = STATIC_OUT
 *
 *    (Adjust to match your existing services.ini entries -- exact directive
 *    names/casing vary a bit by Synchronet version, so cross-check an
 *    existing [service] block in your own ctrl/services.ini rather than
 *    trusting this verbatim.)
 * 4. Add BinktermPHP's IP address(es) to TRUSTED_IPS below. Connections
 *    from any other address are rejected before the request body is even
 *    parsed. Still bind the listening port to localhost or firewall it
 *    where practical -- the IP allowlist and API key are defense-in-depth,
 *    not a substitute for network restriction (spoofing/NAT edge cases,
 *    compromised hosts on the same LAN, etc.).
 * 5. Restart (or reload) the Services server.
 *
 * VERIFY BEFORE TRUSTING IN PRODUCTION
 * -------------------------------------
 * The User object property used below to set the password (`newUser.password`)
 * is standard in community Synchronet SSJS but I could not cross-check it
 * against your installed version's jsobjs.html in this session. Confirm it
 * (and the User.security.level property, if you decide to set an explicit
 * security level for these accounts) against:
 *   http://your-bbs/docs/jsobjs.html  -- or the copy shipped with your install
 * search for the "User class" section.
 */

// ---- Configuration -------------------------------------------------------

var API_KEY = "CHANGE_ME_TO_A_LONG_RANDOM_SECRET";
var NEW_USER_PASSWORD_LENGTH = 24; // random password; trusted RLogin bypasses it anyway

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

// ---- Check for existing account ---------------------------------------

var existingNum = system.matchuser(fullUsername, false);

if (existingNum > 0) {
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

var newUser = system.new_user(fullUsername);

if (typeof newUser !== "object") {
	// system.new_user() returns a numeric error code on failure
	log(LOG_ERR, "binkterm_sync: system.new_user() failed with code " + newUser + " for " + fullUsername);
	sendResponse({ success: false, error: "account creation failed (code " + newUser + ")" });
	exit();
}

// Set a random password. Real auth for this account is expected to happen
// via a trusted RLogin relationship configured for BinktermPHP's IP, not
// this password -- see project notes on the RLogin xtrn= handoff.
// NOTE: verify `.password` is correct for your Synchronet version -- see
// header comment above.
newUser.password = randomPassword(NEW_USER_PASSWORD_LENGTH);

log(LOG_INFO, "binkterm_sync: created user #" + newUser.number + " (" + fullUsername + ")");

sendResponse({
	success: true,
	username: fullUsername,
	user_number: newUser.number,
	created: true
});

exit();