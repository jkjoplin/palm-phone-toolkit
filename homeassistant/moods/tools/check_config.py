#!/usr/bin/env python3
"""Check and finish a panel's config.json before provision.sh pushes it.

    python3 -I tools/check_config.py <config.json> <panel> <out.json>

Mirrors ShellConfig.parse in the shell (shell/app/src/main/java/com/palmmoods/shell/ShellConfig.kt),
so a file that passes here is not rejected by the app. The shared cases in
tools/config-cases.json are run against both (tools/test_check_config.py and ShellConfigTest).
On top of the app's rules, provisioning also needs a real haUrl and token, and no .local name.

Prints key names and the normalized haUrl, never the token.
"""
import json
import os
import re
import stat
import sys

MAX_BYTES = 64 * 1024  # ConfigStore.MAX_BYTES
WS_PATH = "/api/websocket"
STRING_KEYS = ("haUrl", "token", "panel", "deviceName", "nightStart", "nightEnd")

# Characters java.net.URI accepts unescaped; anything else (spaces included) makes it throw.
URI_CHARS = re.compile(r"^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]*$")
URI_PARTS = re.compile(r"^([A-Za-z][A-Za-z0-9+.\-]*)://([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$")
LABEL = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9\-]*[A-Za-z0-9])?$")
IPV6 = re.compile(r"^\[[0-9A-Fa-f:.]+\]$")
CLOCK = re.compile(r"^(\d{1,2}):(\d{2})$")


class Invalid(Exception):
    pass


def _host_ok(host):
    """java.net.URI only reports a host for an IPv4 address, a [IPv6] literal or a DNS name
    whose last label starts with a letter; otherwise URI.getHost() is null and the app rejects it."""
    if IPV6.match(host):
        return True
    parts = host.split(".")
    if len(parts) == 4 and all(p.isdigit() and len(p) <= 3 for p in parts):
        return all(int(p) <= 255 for p in parts)
    if host.endswith("."):
        parts = parts[:-1]
    if not parts or not all(LABEL.match(p) for p in parts):
        return False
    return parts[-1][0].isalpha()


def normalize_ha_url(raw):
    """Same result as ShellConfig.normalizeHaUrl, or None."""
    url = raw.strip()
    if not URI_CHARS.match(url):
        return None
    m = URI_PARTS.match(url)
    if not m:
        return None
    scheme, authority, path, _query, fragment = m.groups()
    scheme = scheme.lower()
    if scheme in ("http", "https"):
        web = True
    elif scheme in ("ws", "wss"):
        web = False
    else:
        return None
    if fragment is not None or "@" in authority:
        return None
    if authority.startswith("["):
        end = authority.find("]")
        if end < 0:
            return None
        host, rest = authority[: end + 1], authority[end + 1 :]
        if rest and not rest.startswith(":"):
            return None
        port = rest[1:] if rest else None
    elif ":" in authority:
        host, port = authority.rsplit(":", 1)
    else:
        host, port = authority, None
    if not host or not _host_ok(host):
        return None
    if port is not None:
        if not port.isdigit() or not 1 <= int(port) <= 65535:
            return None
        port = ":%d" % int(port)
    else:
        port = ""
    if path.endswith(WS_PATH):
        pass
    elif web or path in ("", "/"):
        path = WS_PATH
    else:
        return None
    return "%s://%s%s%s" % ("wss" if scheme in ("https", "wss") else "ws", host, port, path)


def _opt_string(c, key):
    """ShellConfig.optString: absent, null or blank -> None; any other non-string rejects."""
    v = c.get(key)
    if v is None:
        return None
    if not isinstance(v, str):
        raise Invalid("%s must be a string" % key)
    return v.strip() or None


def parse(c):
    """The app's rules (ShellConfig.parse). Returns the normalized haUrl or None."""
    if not isinstance(c, dict):
        raise Invalid("config must be a JSON object")
    for k in STRING_KEYS:
        _opt_string(c, k)
    url = _opt_string(c, "haUrl")
    norm = None
    if url is not None:
        norm = normalize_ha_url(url)
        if norm is None:
            raise Invalid("haUrl is not a ws://, wss://, http:// or https:// URL with a host "
                          "(e.g. ws://<LAN-IP>:8123/api/websocket)")
    for k in ("nightStart", "nightEnd"):
        v = _opt_string(c, k)
        if v is not None:
            m = CLOCK.match(v)
            if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
                raise Invalid("%s must be HH:MM (24 h)" % k)
    if c.get("mock") is not None and not isinstance(c.get("mock"), bool):
        raise Invalid("mock must be true or false")
    return norm


def check_for_provisioning(c):
    """The app's rules plus what a real panel needs. Returns the normalized haUrl."""
    norm = parse(c)
    if norm is None:
        raise Invalid("haUrl is missing (e.g. ws://<LAN-IP>:8123/api/websocket)")
    if re.search(r"\.local\.?(:|/|$)", norm):
        raise Invalid(".local names do not resolve on Android 8.1; use the LAN IP (or a VPN address)")
    tok = _opt_string(c, "token")
    if tok is None or len(tok) < 20 or tok.startswith("PASTE"):
        raise Invalid("token is missing (paste a long-lived access token)")
    return norm


def _no_duplicates(pairs):
    seen = {}
    for k, v in pairs:
        if k in seen:
            raise Invalid("key %r appears twice" % k)
        seen[k] = v
    return seen


def _no_constants(name):
    raise Invalid("%s is not valid JSON" % name)


def loads(text):
    try:
        return json.loads(text, object_pairs_hook=_no_duplicates, parse_constant=_no_constants)
    except Invalid:
        raise
    except ValueError as e:
        raise Invalid("not valid JSON (%s)" % type(e).__name__)


def main(argv):
    if len(argv) != 4:
        sys.exit("usage: check_config.py <config.json> <panel> <out.json>")
    src, panel, out = argv[1:]
    try:
        mode = os.stat(src).st_mode
        if mode & (stat.S_IRWXG | stat.S_IRWXO):
            print("warning: %s holds the token and other users can read it; run: chmod 600 %s" % (src, src),
                  file=sys.stderr)
        with open(src, encoding="utf-8") as f:
            c = loads(f.read())
        check_for_provisioning(c)
        c["panel"] = panel
        if _opt_string(c, "deviceName") is None:
            c["deviceName"] = "palm-" + panel
        norm = check_for_provisioning(c)
        text = json.dumps(c)
        if len(text.encode("utf-8")) > MAX_BYTES:
            raise Invalid("larger than %d bytes" % MAX_BYTES)
    except Invalid as e:
        sys.exit("error: %s: %s" % (src, e))
    except OSError as e:
        sys.exit("error: cannot read %s (%s)" % (src, type(e).__name__))
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    print("config ok: keys %s; the app will connect to %s" % (", ".join(sorted(c)), norm))


if __name__ == "__main__":
    main(sys.argv)
