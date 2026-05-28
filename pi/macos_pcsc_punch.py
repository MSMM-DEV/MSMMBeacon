#!/usr/bin/env python3
"""
macOS-only NFC punch / enrollment / verify tester for the ACR122U (PC/SC).

Why this exists
---------------
The production Pi daemon (`timeclock.py`) reads the reader through nfcpy/libusb.
On macOS that path is blocked: the OS smartcard service (`com.apple.ifdreader`,
SIP-protected) claims the ACR122U, so libusb gets "access denied". Instead of
fighting SIP, this script talks to the reader *through* the same PC/SC service
via `pyscard`, reading the card UID with the ACR122U pseudo-APDU FF CA 00 00 00.

It is NOT a production front-end — the office still runs `timeclock.py` /
`kiosk.py` on the Pi. This is a developer tool for testing from a Mac.

Modes
-----
  --read-only         Just print UIDs as you tap. No network, no creds needed.
  (default)           Punch mode: POST each tap to timeclock-punch (device key).
                      Creates real punches; an enrolled fob prints the user name.
  --whoami            Verify mode: tap a fob and print which user it's bound to
                      (or "not enrolled"). DB lookup only — does NOT punch, so it
                      won't pollute timesheets. Loops until Ctrl-C.
  --rewrite <user>    Re-assign (rewrite) the next-tapped fob to <user> (email or
                      name match), mirroring the server's enroll-tag logic. One
                      tap, confirm, bind, exit. Writes to the production DB.

Credentials
-----------
  Punch mode reads [device] from --config (id, endpoint_url, bearer_token).
  --whoami / --rewrite need admin DB access: SUPABASE_URL + SUPABASE_SERVICE_KEY,
  taken from the environment or auto-loaded from the repo-root .env (these modes
  are dev-only; the Pi never has the service key).

Usage:
  pip install pyscard requests
  python3 macos_pcsc_punch.py --config ~/.config/beacon-timeclock/config.ini
  python3 macos_pcsc_punch.py --whoami
  python3 macos_pcsc_punch.py --rewrite chris            # by name fragment
  python3 macos_pcsc_punch.py --rewrite jdoe@msmmeng.com --label "blue fob"
"""
from __future__ import annotations

import argparse
import configparser
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone

try:
    from smartcard.System import readers
    from smartcard.Exceptions import NoCardException, CardConnectionException
except ImportError:
    sys.exit("pyscard is required: pip install pyscard")

GET_UID_APDU = [0xFF, 0xCA, 0x00, 0x00, 0x00]  # ACR122U / PC/SC: read card serial (UID)
SCHEMA = "beacon_v2"


# ---------------------------------------------------------------------------
# Reader
# ---------------------------------------------------------------------------

def pick_reader():
    rs = readers()
    if not rs:
        sys.exit("no PC/SC readers found — is the ACR122U plugged in?")
    for r in rs:  # prefer the contactless (PICC) interface if several show up
        if "picc" in str(r).lower():
            return r
    return rs[0]


def read_uid(reader, debug=False):
    """Return the UID hex string for a present card, or None if no card / error."""
    conn = reader.createConnection()
    try:
        conn.connect()
    except NoCardException:
        return None
    except CardConnectionException as e:
        if debug:
            print(f"  [debug] connect failed: {e}")
        return None
    except Exception as e:
        if debug:
            print(f"  [debug] connect error ({type(e).__name__}): {e}")
        return None
    try:
        data, sw1, sw2 = conn.transmit(GET_UID_APDU)
        if (sw1, sw2) != (0x90, 0x00):
            if debug:
                print(f"  [debug] card present but UID APDU returned SW={sw1:02X}{sw2:02X}")
            return None
        return ":".join(f"{b:02X}" for b in data)
    except Exception as e:
        if debug:
            print(f"  [debug] transmit error ({type(e).__name__}): {e}")
        return None
    finally:
        try:
            conn.disconnect()
        except Exception:
            pass


def wait_for_tap(reader, debug=False, debounce=5.0):
    """Block until a (debounced) tag is read; return its UID. Ctrl-C to abort."""
    last_uid, last_t = None, 0.0
    while True:
        uid = read_uid(reader, debug=debug)
        if uid:
            now = time.monotonic()
            if not (uid == last_uid and now - last_t < debounce):
                return uid
        time.sleep(0.25)


# ---------------------------------------------------------------------------
# Device-mode punch (timeclock-punch) — same call the Pi makes
# ---------------------------------------------------------------------------

def read_device_config(path):
    cp = configparser.ConfigParser()
    if not cp.read(os.path.expanduser(path)):
        sys.exit(f"config not found: {path}")
    return {
        "device_id":    cp.get("device", "id"),
        "endpoint_url": cp.get("device", "endpoint_url"),
        "bearer_token": cp.get("device", "bearer_token"),
        "debounce_sec": cp.getint("behavior", "debounce_sec", fallback=5),
    }


def post_punch(cfg, uid_hex):
    import requests
    body = {
        "source":     "nfc",
        "device_id":  cfg["device_id"],
        "nfc_uid":    uid_hex,
        "punched_at": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
    }
    headers = {"Authorization": f"Bearer {cfg['bearer_token']}", "Content-Type": "application/json"}
    try:
        r = requests.post(cfg["endpoint_url"], headers=headers, data=json.dumps(body), timeout=8)
    except Exception as e:
        return {"ok": False, "code": "network", "message": str(e)}
    try:
        return r.json()
    except ValueError:
        return {"ok": False, "code": "bad_response", "message": f"HTTP {r.status_code}: {r.text[:120]}"}


def describe_punch(resp):
    if not resp.get("ok"):
        code = resp.get("code", "error")
        if code == "unenrolled":
            return "  ↳ UNENROLLED — UID captured (bind it in Time Admin → NFC, or with --rewrite)."
        return f"  ↳ ERROR [{code}]: {resp.get('message')}"
    user = resp.get("user") or {}
    name = user.get("first_name") or user.get("display_name") or "?"
    return f"  ↳ OK — {name} is now {str(resp.get('state','?')).upper()}. {resp.get('message','')}"


# ---------------------------------------------------------------------------
# Admin DB access (service key) — for --whoami / --rewrite (dev-only)
# ---------------------------------------------------------------------------

def find_repo_env():
    """Walk up from this script to find a .env with SUPABASE_URL + SERVICE key."""
    d = os.path.dirname(os.path.abspath(__file__))
    for _ in range(6):
        p = os.path.join(d, ".env")
        if os.path.isfile(p):
            return p
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None


def load_admin_creds():
    base = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (base and key):
        envp = find_repo_env()
        if envp:
            for line in open(envp):
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip().strip('"').strip("'")
                    if k == "SUPABASE_URL" and not base:
                        base = v
                    elif k in ("SUPABASE_SERVICE_KEY", "SUPABASE_SERVICE_ROLE_KEY") and not key:
                        key = v
    if not (base and key):
        sys.exit("--whoami/--rewrite need SUPABASE_URL + SUPABASE_SERVICE_KEY "
                 "(set them in the env or repo .env). These are dev-only modes.")
    return base.rstrip("/"), key


def rest(method, base, key, path, body=None):
    url = f"{base}/rest/v1/{path}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept-Profile": SCHEMA,
        "Content-Profile": SCHEMA,
        "Content-Type": "application/json",
    }
    if method in ("PATCH", "POST"):
        headers["Prefer"] = "return=representation"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read().decode()
            return json.loads(txt) if txt else []
    except urllib.error.HTTPError as e:
        raise SystemExit(f"DB {method} {path} failed: HTTP {e.code} {e.read().decode()[:200]}")


def lookup_binding(base, key, uid):
    """Return the user dict bound to this UID (active only), or None."""
    q = (f"nfc_tags?uid=eq.{urllib.parse.quote(uid)}&active=eq.true"
         f"&select=uid,label,active,last_seen_at,user:users(id,email,display_name,first_name,role,is_enabled)")
    rows = rest("GET", base, key, q)
    return rows[0] if rows else None


def resolve_user(base, key, query):
    """Find a single enabled user by email/name fragment. Exits on 0 or >1 match."""
    like = f"*{query}*"
    enc = urllib.parse.quote(like)
    q = (f"users?or=(email.ilike.{enc},display_name.ilike.{enc},first_name.ilike.{enc},"
         f"last_name.ilike.{enc},login_name.ilike.{enc})"
         f"&select=id,email,display_name,first_name,last_name,role,is_enabled")
    rows = [u for u in rest("GET", base, key, q) if u.get("is_enabled") is not False]
    if not rows:
        sys.exit(f"no enabled user matches '{query}'.")
    if len(rows) > 1:
        print(f"'{query}' matches {len(rows)} users — be more specific:")
        for u in rows[:12]:
            print(f"   {u.get('display_name') or u.get('first_name')}  <{u['email']}>")
        sys.exit(1)
    return rows[0]


def enroll_uid(base, key, uid, user, label):
    """Mirror timeclock-admin enroll-tag: retire conflicts, then bind active."""
    user_id = user["id"]
    nowiso = datetime.now(tz=timezone.utc).isoformat()
    # 1. Retire any active tag currently bound to this user.
    rest("PATCH", base, key,
         f"nfc_tags?user_id=eq.{user_id}&active=eq.true",
         {"active": False, "retired_at": nowiso})
    # 2. Retire this UID if it's actively bound to a *different* user.
    rest("PATCH", base, key,
         f"nfc_tags?uid=eq.{urllib.parse.quote(uid)}&active=eq.true&user_id=neq.{user_id}",
         {"active": False, "retired_at": nowiso})
    # 3. Upsert the binding active (update if the UID row exists, else insert).
    existing = rest("GET", base, key, f"nfc_tags?uid=eq.{urllib.parse.quote(uid)}&select=uid")
    payload = {"user_id": user_id, "label": label, "active": True,
               "retired_at": None, "enrolled_at": nowiso}
    if existing:
        rest("PATCH", base, key, f"nfc_tags?uid=eq.{urllib.parse.quote(uid)}", payload)
    else:
        rest("POST", base, key, "nfc_tags", {"uid": uid, **payload})


def fmt_user(u):
    if not u:
        return "—"
    return f"{u.get('display_name') or u.get('first_name') or '?'} <{u.get('email','?')}>"


# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------

def run_read_only(reader, debug):
    print("Mode:   READ-ONLY (no network)\nTap a fob… (Ctrl-C to quit)\n")
    last_uid, last_t = None, 0.0
    ticks = 0
    while True:
        uid = read_uid(reader, debug=debug)
        if uid:
            now = time.monotonic()
            if not (uid == last_uid and now - last_t < 5):
                last_uid, last_t = uid, now
                print(f"[{datetime.now():%H:%M:%S}] TAG {uid}")
        elif debug:
            ticks += 1
            if ticks % 12 == 0:
                print("  [debug] polling… (no card present)")
        time.sleep(0.25)


def run_punch(reader, cfg, debug):
    print(f"Mode:   PUNCH → {cfg['endpoint_url']}\nTap a fob… (Ctrl-C to quit)\n")
    last_uid, last_t = None, 0.0
    while True:
        uid = read_uid(reader, debug=debug)
        if uid:
            now = time.monotonic()
            if not (uid == last_uid and now - last_t < cfg["debounce_sec"]):
                last_uid, last_t = uid, now
                print(f"[{datetime.now():%H:%M:%S}] TAG {uid}")
                print(describe_punch(post_punch(cfg, uid)))
        time.sleep(0.25)


def run_whoami(reader, debug):
    base, key = load_admin_creds()
    print("Mode:   WHOAMI (verify binding — no punch created)\nTap a fob… (Ctrl-C to quit)\n")
    last_uid, last_t = None, 0.0
    while True:
        uid = read_uid(reader, debug=debug)
        if uid:
            now = time.monotonic()
            if not (uid == last_uid and now - last_t < 3):
                last_uid, last_t = uid, now
                b = lookup_binding(base, key, uid)
                ts = f"[{datetime.now():%H:%M:%S}]"
                if b:
                    u = b.get("user")
                    extra = []
                    if u and u.get("role") == "Admin":
                        extra.append("admin")
                    if u and u.get("is_enabled") is False:
                        extra.append("DISABLED")
                    tail = f" ({', '.join(extra)})" if extra else ""
                    lbl = f" [{b['label']}]" if b.get("label") else ""
                    print(f"{ts} TAG {uid} → {fmt_user(u)}{tail}{lbl}")
                else:
                    print(f"{ts} TAG {uid} → NOT ENROLLED")
        time.sleep(0.25)


def run_rewrite(reader, target_query, label, debug):
    base, key = load_admin_creds()
    user = resolve_user(base, key, target_query)
    print(f"Mode:   REWRITE → will bind the next tapped fob to "
          f"{fmt_user(user)}\nTap the fob to (re)assign… (Ctrl-C to quit)\n")
    uid = wait_for_tap(reader, debug=debug)
    current = lookup_binding(base, key, uid)
    print(f"  UID:     {uid}")
    print(f"  Current: {fmt_user(current.get('user')) if current else 'not enrolled'}")
    print(f"  New:     {fmt_user(user)}" + (f"   label='{label}'" if label else ""))
    if current and current.get("user", {}).get("id") == user["id"]:
        print("  (already bound to this user — this will refresh the binding)")
    ans = input("Write this binding to the production DB? [y/N] ").strip().lower()
    if ans not in ("y", "yes"):
        print("aborted — nothing written.")
        return
    enroll_uid(base, key, uid, user, label)
    print(f"✓ bound {uid} → {fmt_user(user)}")
    # Read it back so you can confirm it took.
    b = lookup_binding(base, key, uid)
    print(f"  verify:  {uid} → {fmt_user(b.get('user') if b else None)}")


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="ACR122U PC/SC tester for MSMM Beacon timekeeping")
    ap.add_argument("--config", default="~/.config/beacon-timeclock/config.ini",
                    help="device config (punch mode)")
    ap.add_argument("--read-only", action="store_true", help="just print UIDs; no network")
    ap.add_argument("--whoami", action="store_true", help="verify which user a fob is bound to (no punch)")
    ap.add_argument("--rewrite", metavar="USER", help="re-assign the next fob to USER (email/name)")
    ap.add_argument("--label", help="optional tag label for --rewrite")
    ap.add_argument("--debug", action="store_true", help="surface reader errors + heartbeat")
    args = ap.parse_args()

    reader = pick_reader()
    print(f"Reader: {reader}")

    if args.rewrite:
        run_rewrite(reader, args.rewrite, args.label, args.debug)
    elif args.whoami:
        run_whoami(reader, args.debug)
    elif args.read_only:
        run_read_only(reader, args.debug)
    else:
        run_punch(reader, read_device_config(args.config), args.debug)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nbye")
