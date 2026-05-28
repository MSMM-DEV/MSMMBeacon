#!/usr/bin/env python3
"""
MSMM Beacon Timeclock — Raspberry Pi NFC tap-in/tap-out daemon.

Polls a PN532 or ACR122U NFC reader for tag taps, POSTs each tap to the
Supabase Edge Function `timeclock-punch`, and surfaces the response on an
optional SSD1306 OLED display (or a single GPIO LED + buzzer if no screen
is present).

Design notes:
  * Network failures do NOT buffer in v1 — we blink red and require the user
    to web-punch from the Beacon app as a fallback. (v1.1 will add a SQLite
    queue + replay on reconnect.)
  * Pi clock drift is handled server-side: the function ignores our
    `punched_at` advisory if it differs from server `now()` by > 60s.
    systemd-timesyncd keeps us close to NTP either way.
  * A 5-second per-UID debounce filters the reader's "still here" repeats.

Config: /etc/beacon-timeclock/config.ini (or `--config <path>`).

  [device]
  id            = pi-front-door
  endpoint_url  = https://<project-ref>.supabase.co/functions/v1/timeclock-punch
  bearer_token  = <TIMECLOCK_DEVICE_KEY>

  [reader]
  type          = pn532    ; or 'acr122u'
  i2c_bus       = 1        ; pn532 only; default 1
  serial_port   =          ; pn532 over uart; e.g. /dev/serial0

  [display]
  type          = ssd1306  ; or 'none'
  i2c_addr      = 0x3C
  width         = 128
  height        = 64

  [behavior]
  debounce_sec  = 5
  message_sec   = 3

Run:
  python3 timeclock.py --config /etc/beacon-timeclock/config.ini
"""

from __future__ import annotations

import argparse
import configparser
import json
import logging
import os
import signal
import sys
import time
from datetime import datetime, timezone
from typing import Optional

try:
    import nfc                                # pip install nfcpy
except ImportError:                           # pragma: no cover
    nfc = None
try:
    import requests
except ImportError:                           # pragma: no cover
    requests = None

LOG = logging.getLogger("timeclock")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

class Config:
    def __init__(self, path: str):
        cp = configparser.ConfigParser()
        if not cp.read(path):
            raise SystemExit(f"config file not found: {path}")
        self.device_id     = cp.get("device", "id")
        self.endpoint_url  = cp.get("device", "endpoint_url")
        self.bearer_token  = cp.get("device", "bearer_token")
        self.reader_type   = cp.get("reader", "type", fallback="pn532").lower()
        self.i2c_bus       = cp.getint("reader", "i2c_bus", fallback=1)
        self.serial_port   = cp.get("reader", "serial_port", fallback="").strip() or None
        self.display_type  = cp.get("display", "type", fallback="none").lower()
        self.display_addr  = int(cp.get("display", "i2c_addr", fallback="0x3C"), 16)
        self.display_w     = cp.getint("display", "width", fallback=128)
        self.display_h     = cp.getint("display", "height", fallback=64)
        self.debounce_sec  = cp.getint("behavior", "debounce_sec", fallback=5)
        self.message_sec   = cp.getint("behavior", "message_sec", fallback=3)
        # [ui] — drives the touchscreen kiosk (kiosk.py). 'headless' = this
        # OLED/LED daemon; 'kiosk' = the PyQt5 7" touchscreen app.
        self.ui_mode             = cp.get("ui", "mode", fallback="headless").lower()
        self.location_label      = cp.get("ui", "location_label", fallback="").strip()
        self.category_timeout_sec = cp.getint("ui", "category_timeout_sec", fallback=25)
        self.confirm_sec         = cp.getint("ui", "confirm_sec", fallback=4)


# ---------------------------------------------------------------------------
# Display abstraction. Only SSD1306 + 'none' are wired in v1. ACR122U and
# OLED-less builds use the LED variant (GPIO 17 by default — see install).
# ---------------------------------------------------------------------------

class Display:
    """Best-effort OLED. Silent no-ops if the lib isn't installed."""
    def __init__(self, cfg: Config):
        self.cfg     = cfg
        self.device  = None
        if cfg.display_type != "ssd1306":
            return
        try:
            from luma.core.interface.serial import i2c        # type: ignore
            from luma.oled.device import ssd1306              # type: ignore
            self.device = ssd1306(
                i2c(port=cfg.i2c_bus, address=cfg.display_addr),
                width=cfg.display_w, height=cfg.display_h,
            )
        except Exception as e:                                # pragma: no cover
            LOG.warning("OLED init failed: %s", e)

    def show(self, lines: list[str]):
        if not self.device:
            return
        try:
            from luma.core.render import canvas              # type: ignore
            from PIL import ImageFont                        # type: ignore
            font = ImageFont.load_default()
            with canvas(self.device) as draw:
                y = 4
                for ln in lines[:4]:
                    draw.text((4, y), ln[:24], font=font, fill=255)
                    y += 14
        except Exception as e:                                # pragma: no cover
            LOG.debug("OLED draw failed: %s", e)

    def clear(self):
        if not self.device:
            return
        try:
            from luma.core.render import canvas              # type: ignore
            with canvas(self.device) as draw:
                draw.rectangle(self.device.bounding_box, fill=0)
        except Exception:                                     # pragma: no cover
            pass


# ---------------------------------------------------------------------------
# HTTP call to timeclock-punch
# ---------------------------------------------------------------------------

def _headers(cfg: Config) -> dict:
    return {
        "Authorization": f"Bearer {cfg.bearer_token}",
        "Content-Type":  "application/json",
    }


def post_punch(cfg: Config, uid_hex: str) -> dict:
    if requests is None:
        raise RuntimeError("the `requests` package is required")
    body = {
        "source":     "nfc",
        "device_id":  cfg.device_id,
        "nfc_uid":    uid_hex,
        "punched_at": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
    }
    try:
        r = requests.post(cfg.endpoint_url, headers=_headers(cfg), data=json.dumps(body), timeout=8)
    except requests.RequestException as e:
        LOG.error("punch HTTP error: %s", e)
        return {"ok": False, "code": "network", "message": "no network"}
    try:
        return r.json()
    except ValueError:
        return {"ok": False, "code": "bad_response", "message": f"HTTP {r.status_code}"}


def post_tag(cfg: Config, interval_id: str, category: str, note: Optional[str] = None) -> dict:
    """Phase 2 of the kiosk flow — set the category on the interval the punch
    just opened. Device-authenticated; the server validates the interval is
    recent. Returns the JSON response dict."""
    if requests is None:
        raise RuntimeError("the `requests` package is required")
    body = {
        "source":      "nfc",
        "device_id":   cfg.device_id,
        "action":      "tag",
        "interval_id": interval_id,
        "category":    category,
        "note":        note,
    }
    try:
        r = requests.post(cfg.endpoint_url, headers=_headers(cfg), data=json.dumps(body), timeout=8)
    except requests.RequestException as e:
        LOG.error("tag HTTP error: %s", e)
        return {"ok": False, "code": "network", "message": "no network"}
    try:
        return r.json()
    except ValueError:
        return {"ok": False, "code": "bad_response", "message": f"HTTP {r.status_code}"}


def reader_target(cfg: Config) -> str:
    """nfcpy reader path resolution. PN532 over I2C is the recommended cheap
    path; PN532 over UART works on a Pi Zero too. ACR122U is USB."""
    if cfg.reader_type == "pn532" and cfg.serial_port:
        return f"tty:{cfg.serial_port.replace('/dev/', '')}:pn532"
    if cfg.reader_type == "pn532":
        return f"i2c:{cfg.i2c_bus}:pn532"
    if cfg.reader_type == "acr122u":
        return "usb"
    raise SystemExit(f"unknown reader type: {cfg.reader_type}")


# ---------------------------------------------------------------------------
# NFC reader loop
# ---------------------------------------------------------------------------

class TimeclockApp:
    def __init__(self, cfg: Config):
        self.cfg            = cfg
        self.display        = Display(cfg)
        self.last_uid       = None
        self.last_uid_time  = 0.0
        self._running       = True

    def _reader_target(self):
        return reader_target(self.cfg)

    def stop(self, *_):
        self._running = False

    def run(self):
        if nfc is None:
            raise SystemExit("nfcpy is not installed — `pip install nfcpy`")
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT,  self.stop)

        target = self._reader_target()
        self.display.show(["MSMM Beacon", "Timeclock ready", f"Device: {self.cfg.device_id}"])

        with nfc.ContactlessFrontend(target) as clf:
            LOG.info("reader ready · target=%s", target)
            while self._running:
                tag = clf.connect(rdwr={"on-connect": lambda t: False, "beep-on-connect": False})
                if not tag:
                    continue
                try:
                    uid_hex = ":".join(f"{b:02X}" for b in tag.identifier)
                except Exception:
                    continue
                if not self._debounce_ok(uid_hex):
                    continue
                self._handle_tap(uid_hex)
                # Small dwell so the user can lift the fob before the next
                # poll cycle re-detects it.
                time.sleep(1.0)

    def _debounce_ok(self, uid_hex: str) -> bool:
        now = time.monotonic()
        if uid_hex == self.last_uid and now - self.last_uid_time < self.cfg.debounce_sec:
            return False
        self.last_uid       = uid_hex
        self.last_uid_time  = now
        return True

    def _handle_tap(self, uid_hex: str):
        LOG.info("tap · uid=%s", uid_hex)
        self.display.show(["Reading…", uid_hex])
        resp = post_punch(self.cfg, uid_hex)
        msg  = build_display(resp)
        LOG.info("punch response: %s", json.dumps(resp)[:200])
        self.display.show(msg)
        time.sleep(self.cfg.message_sec)
        self.display.show(["MSMM Beacon", "Tap your fob", "to punch in/out"])


def build_display(resp: dict) -> list[str]:
    if not resp.get("ok"):
        code = resp.get("code") or "error"
        if code == "unenrolled":
            return ["Fob not bound", "Ask admin to", "enroll your tag"]
        if code == "disabled":
            return ["Timekeeping", "is paused"]
        if code == "network":
            return ["No network", "Use the Beacon", "site to punch"]
        return ["Error", str(resp.get("message"))[:24]]
    user  = resp.get("user", {}) or {}
    name  = user.get("first_name") or user.get("display_name") or "you"
    state = resp.get("state") or "?"
    msg   = resp.get("message") or ""
    return [f"Hi {name}", f"State: {state.upper()}", msg[:24]]


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.environ.get(
        "BEACON_TIMECLOCK_CONFIG", "/etc/beacon-timeclock/config.ini"))
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s · %(message)s",
    )

    cfg = Config(args.config)
    TimeclockApp(cfg).run()


if __name__ == "__main__":
    main()
