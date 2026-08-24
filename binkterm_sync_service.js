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
 *   {"success":true,"doors":[{"code":"lord","name":"Legend of the Red Dragon","sec_code":"games","sec_name":"Games","description":"...","author":"...","categories":["Games","RPG"]}, ...]}
 *
 *   "code" is the door's internal xtrn program code -- the value BinktermPHP
 *   needs for the rlogin door's Terminal Type field ("xtrn=<code>") so
 *   Synchronet's door server routes straight into that program.
 *
 *   "description", "author", and "categories" are best-effort and may be
 *   absent -- see "install-xtrn.ini enrichment" below.
 *
 * Response (failure):
 *   {"success":false,"error":"reason"}
 *
 * SETUP
 * -----
 * 1. Copy this file to your Synchronet exec/ or mods/ directory.
 * 2. Copy binkterm_sync_service.ini.example to ctrl/binkterm_sync_service.ini
 *    and edit it -- at minimum, set api_key to a long random value (shared
 *    with BinktermPHP) and add BinktermPHP's IP address(es) to trusted_ips.
 *    See "CONFIGURATION" below for the full set of keys. Keeping these
 *    settings in ctrl/binkterm_sync_service.ini instead of editing the
 *    constants below means re-copying an updated version of this script
 *    (e.g. a git pull) never loses your configuration.
 * 3. In ctrl/services.ini add a section, e.g.:
 *
 *      [binkterm_sync]
 *      Port = 24512
 *      Command = binkterm_sync_service.js
 *      MaxClients = 5
 *
 *    Do NOT set STATIC/LOOP in Options; those are for long-running
 *    single-instance services (e.g. ircd.js) that manage their own client
 *    loop, not the per-connection-thread model this script expects.
 *
 *    To require TLS on this connection (recommended -- see "TLS" below),
 *    add the TLS flag instead:
 *
 *      [binkterm_sync]
 *      Port = 24512
 *      Command = binkterm_sync_service.js
 *      MaxClients = 5
 *      Options = TLS
 *
 * 4. Connections from any IP not listed in trusted_ips are rejected before
 *    the request body is even parsed. Still bind the listening port to
 *    localhost or firewall it where practical -- the IP allowlist and API
 *    key are defense-in-depth, not a substitute for network restriction
 *    (spoofing/NAT edge cases, compromised hosts on the same LAN, etc.).
 * 5. Restart (or reload) the Services server. ctrl/binkterm_sync_service.ini
 *    itself, once step 2 is done, is re-read on every connection (see
 *    "CONFIGURATION" below) -- only script code changes (this .js file)
 *    require a Services server restart, not config-only changes.
 *
 * CONFIGURATION
 * -------------
 * ctrl/binkterm_sync_service.ini, section [binkterm_sync], keys:
 *
 *   api_key                   Shared secret BinktermPHP must send as
 *                              "api_key" in every request. No default --
 *                              falls back to the (insecure) placeholder
 *                              constant below if unset.
 *   trusted_ips                Comma-separated list of exact IPs and/or
 *                              CIDR ranges allowed to connect (see
 *                              TRUSTED_IPS below for syntax). Falls back to
 *                              the constant below (localhost only) if unset.
 *   new_user_password_length  Length of the random password set on newly
 *                              created accounts. Defaults to 24.
 *   default_security_level    User.level assigned to newly created
 *                              accounts. Defaults to 50.
 *
 * If ctrl/binkterm_sync_service.ini does not exist at all, every setting
 * falls back to the constants in the "Configuration" section below --
 * this keeps the script working out of the box for anyone who hasn't
 * created the ini file yet, at the cost of needing to hand-edit this
 * script (and losing those edits on every update) until they do.
 *
 * install-xtrn.ini enrichment
 * ---------------------------
 * Synchronet's own external-program record (xtrn.ini, exposed to JS as
 * xtrn_area.sec_list[].prog_list[]) has no description or author field --
 * only code/name/section/command-line/etc. Most installed doors, however,
 * were installed via install-xtrn.js from an install-xtrn.ini file (see
 * exec/install-xtrn.js) whose root section carries sysop-facing metadata as
 * "Name:", "Desc:", "By:", "Cats:", and "Subs:" lines, e.g.:
 *
 *   Name: Chicken Delivery
 *   Desc: You are a chicken on a mission.
 *   By:   echicken -at- bbs.electronicchicken.com
 *   Cats: Games
 *   Subs: Platformer, JavaScript
 *
 * listDoors() below opportunistically re-reads that file, resolved from
 * each program's "startup_dir" (which install-xtrn.js stores relative to
 * ctrl_dir -- see cfg.ctrl_dir + startup_dir usage throughout Synchronet's
 * own JS, e.g. xtrn/doorscan/003-doorscan.xjs), and attaches "description",
 * "author" (the "By:" list joined with ", "), and "categories" (Cats: +
 * Subs: combined) when the file is present and parses cleanly. This is
 * best-effort: doors installed by hand, by a non-install-xtrn.ini installer,
 * or with the file since deleted simply come back without these fields, and
 * a read/parse failure for one door's install-xtrn.ini never fails the
 * whole list_doors request.
 *
 * TLS
 * ---
 * BinktermPHP's client defaults to requiring TLS on this connection, so add
 * `Options = TLS` to the section (step 3 above) to match -- this makes the
 * Services server terminate TLS before this script ever sees the socket, no
 * code changes needed here, since `client`/`readln`/`writeln` already sit on
 * top of whatever transport the Services server negotiated. TLS uses the
 * same certificate/key as every other TLS-enabled Synchronet service
 * (`ctrl/ssl.cert`), configured under SCFG -> System -> Security -- generate
 * a self-signed certificate there if you don't already have one for another
 * service. BinktermPHP's client
 * defaults to accepting a self-signed certificate (no verification) since
 * this is typically a LAN/localhost link between two systems the same sysop
 * controls; see the `tls_verify_peer` option in binkterm-php's
 * `config/rlogin_synchronet_service.json` if you want strict verification
 * against a CA-signed certificate instead. Whichever you choose, `Options`
 * here and the client's `tls` setting must agree -- a plaintext client
 * cannot reach a TLS-only service, or vice versa.
 */

// ---- Configuration ---------------------------------------------------
//
// These are fallback defaults, used only for whatever
// ctrl/binkterm_sync_service.ini (loaded by loadConfig() below) doesn't
// set -- see "CONFIGURATION" above and binkterm_sync_service.ini.example.
// Prefer editing that ini file over these constants: it survives updates
// to this script (e.g. a git pull), while edits here do not.

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

// Re-read ctrl/binkterm_sync_service.ini (if present) and override the
// defaults above with whatever it sets. Called once per connection, same
// as the rest of this script -- Synchronet Services scripts are re-run
// fresh per connection, so this file is always current without needing a
// Services server restart (only editing this .js file's own code does).
function loadConfig() {
	var iniPath = system.ctrl_dir + "binkterm_sync_service.ini";
	if (!file_exists(iniPath)) {
		return;
	}

	var f = new File(iniPath);
	if (!f.open("r")) {
		log(LOG_WARNING, "binkterm_sync: could not open " + iniPath + ": " + f.error);
		return;
	}

	try {
		var section = "binkterm_sync";

		var apiKey = f.iniGetValue(section, "api_key");
		if (apiKey) {
			API_KEY = apiKey;
		}

		var pwLen = f.iniGetValue(section, "new_user_password_length");
		if (pwLen) {
			NEW_USER_PASSWORD_LENGTH = pwLen;
		}

		var secLevel = f.iniGetValue(section, "default_security_level");
		if (secLevel !== null && secLevel !== undefined && secLevel !== "") {
			DEFAULT_SECURITY_LEVEL = secLevel;
		}

		var trustedIps = f.iniGetValue(section, "trusted_ips", []);
		if (trustedIps && trustedIps.length) {
			TRUSTED_IPS = trustedIps;
		}
	} catch (e) {
		log(LOG_ERR, "binkterm_sync: failed to read " + iniPath + ": " + e);
	} finally {
		f.close();
	}
}

loadConfig();

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

// True if `dir` is already an absolute path -- a leading "/" (Unix), a
// drive letter ("C:\" or "C:/"), or a UNC path ("\\server\share"). Most
// doors get startup_dir written relative to ctrl_dir by install-xtrn.js
// (see relpath.get() in that script), but a door added or edited by hand
// through SCFG can end up with an absolute path typed directly into the
// Startup Directory field instead -- both are valid xtrn.ini values.
function isAbsolutePath(dir) {
	return /^(\/|[A-Za-z]:[\\\/]|\\\\)/.test(dir);
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

// Best-effort read of a door's install-xtrn.ini (see "install-xtrn.ini
// enrichment" above). Returns {description, author, categories} with only
// the fields that were actually present, or null if the file doesn't exist
// or couldn't be parsed. Never throws -- callers treat this as optional
// enrichment, not a required step.
function readInstallXtrnMeta(startupDir, code) {
	if (!startupDir) {
		log(LOG_DEBUG, "binkterm_sync: " + code + " has no startup_dir set -- skipping install-xtrn.ini lookup");
		return null;
	}

	// startup_dir is usually stored relative to ctrl_dir (see install-xtrn.js's
	// relpath.get(system.ctrl_dir, startup_dir) at install time -- the same
	// convention Synchronet's own scripts use to resolve it back, e.g.
	// xtrn/doorscan/003-doorscan.xjs's system.ctrl_dir + "../xtrn/..."), but
	// a hand-entered SCFG value can be absolute instead -- see isAbsolutePath().
	var dir = isAbsolutePath(startupDir) ? startupDir : (system.ctrl_dir + startupDir);
	if (dir.charAt(dir.length - 1) !== "/" && dir.charAt(dir.length - 1) !== "\\") {
		dir += "/";
	}
	var iniPath = fullpath(dir + "install-xtrn.ini");

	if (!file_exists(iniPath)) {
		log(LOG_INFO, "binkterm_sync: " + code + " startup_dir=" + startupDir + " -> " + iniPath + " (not found)");
		return null;
	}

	log(LOG_DEBUG, "binkterm_sync: " + code + " startup_dir=" + startupDir + " -> " + iniPath + " (found)");

	var f = new File(iniPath);
	try {
		if (!f.open("r")) {
			log(LOG_WARNING, "binkterm_sync: " + code + " could not open " + iniPath + ": " + f.error);
			return null;
		}

		var desc = f.iniGetValue(null, "desc");
		var by = f.iniGetValue(null, "by", []);
		var cats = f.iniGetValue(null, "cats", []);
		var subs = f.iniGetValue(null, "subs", []);

		var meta = {};
		if (desc) {
			meta.description = desc;
		}
		if (by && by.length) {
			meta.author = by.join(", ");
		}
		var categories = [].concat(cats || [], subs || []);
		if (categories.length) {
			meta.categories = categories;
		}

		log(LOG_DEBUG, "binkterm_sync: " + code + " parsed " + iniPath + ": " + JSON.stringify(meta));
		return meta;
	} catch (e) {
		log(LOG_WARNING, "binkterm_sync: " + code + " failed to parse " + iniPath + ": " + e);
		return null;
	} finally {
		f.close();
	}
}

// List installed external programs (doors) from xtrn_area, grouped by
// section, flattened into one array. Each entry's "code" is what
// BinktermPHP needs for the rlogin Terminal Type "xtrn=<code>" handoff.
// "description"/"author"/"categories" are opportunistically filled in from
// each program's install-xtrn.ini, if one can be found -- see
// readInstallXtrnMeta() and the "install-xtrn.ini enrichment" header note.
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
	// Cache install-xtrn.ini reads by startup_dir -- multiple [prog:CODE]
	// entries commonly share one install-xtrn.ini (and one startup_dir).
	var metaCache = {};
	try {
		for (var i = 0; i < xtrn_area.sec_list.length; i++) {
			var sec = xtrn_area.sec_list[i];
			var progList = sec.prog_list || [];
			for (var j = 0; j < progList.length; j++) {
				var prog = progList[j];
				var door = {
					code: prog.code,
					name: prog.name,
					sec_code: sec.code,
					sec_name: sec.name
				};

				var startupDir = prog.startup_dir || "";
				if (!Object.prototype.hasOwnProperty.call(metaCache, startupDir)) {
					try {
						metaCache[startupDir] = readInstallXtrnMeta(startupDir, prog.code);
					} catch (e) {
						log(LOG_WARNING, "binkterm_sync: install-xtrn.ini lookup failed for " + prog.code + ": " + e);
						metaCache[startupDir] = null;
					}
				}
				var meta = metaCache[startupDir];
				if (meta) {
					if (meta.description) {
						door.description = meta.description;
					}
					if (meta.author) {
						door.author = meta.author;
					}
					if (meta.categories) {
						door.categories = meta.categories;
					}
				}

				doors.push(door);
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