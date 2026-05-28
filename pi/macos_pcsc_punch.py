#!/usr/bin/env python3
"""
macOS-only NFC punch/enrollment tester for the ACR122U (and other PC/SC readers).

Why this exists
---------------
The production Pi daemon (`timeclock.py`) reads the reader through nfcpy/libusb.
On macOS that path is blocked: the OS smartcard service (`com.apple.ifdreader`,
SIP-protected) claims the ACR122U, so libusb gets "access denied". Instead of
fighting SIP, this script talks to the reader *through* the same PC/SC service
via `pyscard`, reading the card UID with the ACR122U pseudo-APDU FF CA 00 00 00.

It POSTs to the exact same `timeclock-punch` Edge Function the Pi uses, so it's a
faithful stand-in for enrollment testing from a Mac. It is NOT a production
front-end — the office still runs `timeclock.py` / `kiosk.py` on the Pi.

Reuses the [device] section of the Pi config so creds live in one place:

  [device]
  id            = pi-front-door         ; must exist in time_devices
  endpoint_url  = https://<ref>.supabase.co/functions/v1/timeclock-punch
  bearer_token  = <TIMECLOCK_DEVICE_KEY> ; must match the deployed function secret

Usage:
  pip install pyscard requests
  python3 macos_pcsc_punch.py --config ./config.ini --read-only   # just print UIDs, no network
  python3 macos_pcsc_punch.py --config ./config.ini               # full punch/enroll POSTs
"""
from __future__ import annotations

import argparse
import configparser
import json
import sys
import time
from datetime import datetime, timezone

try:
    from smartcard.System import readers
    from smartcard.util import toHexString
    from smartcard.Exceptions import NoCardException, CardConnectionException
except ImportError:
    sys.exit("pyscard is required: pip install pyscard")

GET_UID_APDU = [0xFF, 0xCA, 0x00, 0x00, 0x00]  # ACR122U / PC/SC: read card serial (UID)


def read_config(path: str):
    cp = configparser.ConfigParser()
    if not cp.read(path):
        sys.exit(f"config not found: {path}")
    return {
        "device_id":    cp.get("device", "id"),
        "endpoint_url": cp.get("device", "endpoint_url"),
        "bearer_token": cp.get("device", "bearer_token"),
        "debounce_sec": cp.getint("behavior", "debounce_sec", fallback=5),
    }


def pick_reader():
    rs = readers()
    if not rs:
        sys.exit("no PC/SC readers found — is the ACR122U plugged in?")
    # Prefer the contactless (PICC) interface if multiple show up.
    for r in rs:
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


def post_punch(cfg, uid_hex):
    import requests
    body = {
        "source":     "nfc",
        "device_id":  cfg["device_id"],
        "nfc_uid":    uid_hex,
        "punched_at": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
    }
    headers = {
        "Authorization": f"Bearer {cfg['bearer_token']}",
        "Content-Type":  "application/json",
    }
    try:
        r = requests.post(cfg["endpoint_url"], headers=headers, data=json.dumps(body), timeout=8)
    except Exception as e:
        return {"ok": False, "code": "network", "message": str(e)}
    try:
        return r.json()
    except ValueError:
        return {"ok": False, "code": "bad_response", "message": f"HTTP {r.status_code}: {r.text[:120]}"}


def describe(resp):
    if not resp.get("ok"):
        code = resp.get("code", "error")
        if code == "unenrolled":
            return f"  ↳ UNENROLLED — UID captured. If an enroll session is open in Time Admin → NFC, it should appear there now."
        return f"  ↳ ERROR [{code}]: {resp.get('message')}"
    user = resp.get("user") or {}
    name = user.get("first_name") or user.get("display_name") or "?"
    return f"  ↳ OK — {name} is now {str(resp.get('state','?')).upper()}. {resp.get('message','')}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="./config.ini")
    ap.add_argument("--read-only", action="store_true", help="just print UIDs; no network calls")
    ap.add_argument("--debug", action="store_true", help="surface reader errors + heartbeat")
    args = ap.parse_args()

    cfg = None if args.read_only else read_config(args.config)
    reader = pick_reader()
    print(f"Reader: {reader}")
    print("Mode:  ", "READ-ONLY (no POST)" if args.read_only else f"PUNCH → {cfg['endpoint_url']}")
    print("Tap a fob on the reader… (Ctrl-C to quit)\n")

    last_uid, last_t = None, 0.0
    debounce = 5 if args.read_only else cfg["debounce_sec"]
    ticks = 0
    while True:
        uid = read_uid(reader, debug=args.debug)
        if uid:
            now = time.monotonic()
            if not (uid == last_uid and now - last_t < debounce):
                last_uid, last_t = uid, now
                ts = datetime.now().strftime("%H:%M:%S")
                print(f"[{ts}] TAG {uid}")
                if not args.read_only:
                    print(describe(post_punch(cfg, uid)))
        elif args.debug:
            ticks += 1
            if ticks % 12 == 0:  # ~ every 3s
                print("  [debug] polling… (no card present)")
        time.sleep(0.25)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nbye")
