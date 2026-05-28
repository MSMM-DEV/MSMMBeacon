#!/usr/bin/env python3
"""
MSMM Beacon Timeclock — 7" touchscreen kiosk (PyQt5).

A full-screen appliance UI for the office entrance. Flow:

    NFC tap → read UID → POST timeclock-punch (device key)
            → show "Hi <name> — you're now IN/OUT"
            → IN  : a single "Working" confirm
              OUT : a category grid (Lunch / Meeting / Travel / Break /
                    Done for the day)
            → on pick: POST timeclock-punch {action:'tag'} to label the
              interval the punch just opened
            → "✓" confirmation, then back to the idle clock screen.

Why this lives next to timeclock.py: it reuses that module's Config, the
NFC reader-target resolution, and the device-authenticated HTTP helpers
(post_punch / post_tag). timeclock.py remains the headless OLED/LED daemon;
this is the alternative front-end selected by `[ui] mode = kiosk`.

The device secret never leaves the Pi: only this process holds the bearer
token and makes the punch + tag calls. The screen is pure presentation +
touch input.

Threading model:
  • NfcReaderThread owns the blocking nfcpy loop and emits `tapped(uid)`.
  • Each HTTP call runs on a short-lived CallThread so the UI never blocks.
  • Qt's queued signal delivery marshals every result back onto the UI
    thread — widgets are only ever touched there.

Run (normally via systemd in the desktop session):
  python3 kiosk.py --config /etc/beacon-timeclock/config.ini

Test on a desktop without a reader:
  BEACON_KIOSK_TEST_UID=04:AA:BB:CC python3 kiosk.py --config dev.ini
  …then press the "T" key to simulate a tap.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from datetime import datetime

from PyQt5 import QtCore, QtGui, QtWidgets

from timeclock import Config, post_punch, post_tag, reader_target

try:
    import nfc                                 # pip install nfcpy
except ImportError:                            # pragma: no cover
    nfc = None

LOG = logging.getLogger("kiosk")

# Categories shown after a PUNCH-OUT. The key is the interval_category_enum
# value; the label is what the screen shows. Every one is "out of office" →
# red + uncounted; the choice is just a label so colleagues know where you are.
OUT_CATEGORIES = [
    ("lunch",   "Lunch"),
    ("meeting", "Meeting"),
    ("travel",  "Travel"),
    ("break",   "Break"),
    ("eod",     "Done for the day"),
]

# Beacon-ish palette. Green = at desk / in; red = out.
QSS = """
* { font-family: "DejaVu Sans", "Segoe UI", sans-serif; color: #f4f7fb; }
QMainWindow, QWidget#page { background: #0e141b; }
QLabel#brand      { color: #8aa0b6; font-size: 26px; font-weight: 600; letter-spacing: 2px; }
QLabel#clock      { color: #f4f7fb; font-size: 96px; font-weight: 700; }
QLabel#date       { color: #8aa0b6; font-size: 28px; }
QLabel#hint       { color: #c7d3df; font-size: 34px; font-weight: 600; }
QLabel#location   { color: #5e7184; font-size: 20px; letter-spacing: 1px; }
QLabel#name       { font-size: 56px; font-weight: 800; }
QLabel#statusLine { font-size: 30px; font-weight: 600; }
QLabel#subline    { color: #c7d3df; font-size: 26px; }
QLabel#bigicon    { font-size: 80px; font-weight: 800; }
QPushButton#cat {
    font-size: 30px; font-weight: 700; color: #f4f7fb;
    background: #1b2733; border: 2px solid #2c3b4b; border-radius: 16px;
    padding: 20px 16px;
}
QPushButton#cat:pressed { background: #243443; }
QPushButton#primary {
    font-size: 34px; font-weight: 800; color: #06210f;
    background: #34c27a; border: none; border-radius: 18px; padding: 28px 40px;
}
QPushButton#primary:pressed { background: #2aa869; }
QPushButton#ghost {
    font-size: 24px; color: #8aa0b6; background: transparent; border: none;
}
"""

GREEN = "#34c27a"
RED   = "#e1607a"


# ---------------------------------------------------------------------------
# NFC reader — blocking nfcpy loop on its own thread.
# ---------------------------------------------------------------------------
class NfcReaderThread(QtCore.QThread):
    tapped       = QtCore.pyqtSignal(str)
    reader_error = QtCore.pyqtSignal(str)

    def __init__(self, cfg: Config):
        super().__init__()
        self.cfg     = cfg
        self._run    = True
        self._last   = (None, 0.0)   # (uid, monotonic) for debounce

    def stop(self):
        self._run = False

    def _debounce_ok(self, uid: str) -> bool:
        now = time.monotonic()
        last_uid, last_t = self._last
        if uid == last_uid and now - last_t < self.cfg.debounce_sec:
            return False
        self._last = (uid, now)
        return True

    def run(self):
        if nfc is None:
            self.reader_error.emit("nfcpy not installed")
            return
        target = reader_target(self.cfg)
        while self._run:
            try:
                with nfc.ContactlessFrontend(target) as clf:
                    LOG.info("reader ready · target=%s", target)
                    while self._run:
                        # `terminate` lets connect() return promptly on stop()
                        # instead of blocking until the next tap.
                        tag = clf.connect(
                            rdwr={"on-connect": lambda t: False, "beep-on-connect": False},
                            terminate=lambda: not self._run,
                        )
                        if not tag:
                            continue
                        try:
                            uid = ":".join(f"{b:02X}" for b in tag.identifier)
                        except Exception:
                            continue
                        if self._debounce_ok(uid):
                            self.tapped.emit(uid)
                        time.sleep(1.0)   # let the user lift the fob
            except Exception as e:                         # pragma: no cover
                LOG.error("reader loop error: %s", e)
                self.reader_error.emit(str(e))
                # Back off and retry — a transient USB/I2C hiccup shouldn't
                # kill the kiosk for the day.
                for _ in range(50):
                    if not self._run:
                        break
                    time.sleep(0.1)


# ---------------------------------------------------------------------------
# Generic one-shot HTTP worker so the UI thread never blocks on the network.
# ---------------------------------------------------------------------------
class CallThread(QtCore.QThread):
    result = QtCore.pyqtSignal(object)

    def __init__(self, fn, *args):
        super().__init__()
        self._fn = fn
        self._args = args

    def run(self):
        try:
            out = self._fn(*self._args)
        except Exception as e:                             # pragma: no cover
            out = {"ok": False, "code": "exception", "message": str(e)}
        self.result.emit(out)


# ---------------------------------------------------------------------------
# Main window — a QStackedWidget of full-screen pages.
# ---------------------------------------------------------------------------
class KioskWindow(QtWidgets.QMainWindow):
    PAGE_IDLE, PAGE_BUSY, PAGE_PROMPT, PAGE_CONFIRM, PAGE_ERROR = range(5)

    def __init__(self, cfg: Config):
        super().__init__()
        self.cfg      = cfg
        self._busy    = False          # serialize: ignore taps mid-flow
        self._pending = None           # {user, state, interval_id}
        self._threads = []             # keep refs so workers aren't GC'd

        self.setWindowTitle("MSMM Beacon Timeclock")
        self.setStyleSheet(QSS)
        self.stack = QtWidgets.QStackedWidget()
        self.setCentralWidget(self.stack)

        self.stack.addWidget(self._build_idle())
        self.stack.addWidget(self._build_busy())
        self.stack.addWidget(self._build_prompt())
        self.stack.addWidget(self._build_confirm())
        self.stack.addWidget(self._build_error())

        # Clock tick.
        self._clock_timer = QtCore.QTimer(self)
        self._clock_timer.timeout.connect(self._tick_clock)
        self._clock_timer.start(1000)
        self._tick_clock()

        # Inactivity → back to idle (keeps the rule-classified default).
        self._idle_timer = QtCore.QTimer(self)
        self._idle_timer.setSingleShot(True)
        self._idle_timer.timeout.connect(self._go_idle)

        # Auto-return after a confirmation / error.
        self._return_timer = QtCore.QTimer(self)
        self._return_timer.setSingleShot(True)
        self._return_timer.timeout.connect(self._go_idle)

        self._go_idle()

    # ---- page builders ---------------------------------------------------
    def _page(self) -> QtWidgets.QWidget:
        w = QtWidgets.QWidget()
        w.setObjectName("page")
        return w

    def _build_idle(self):
        w = self._page()
        v = QtWidgets.QVBoxLayout(w)
        v.setContentsMargins(60, 40, 60, 40)
        v.addStretch(1)
        brand = QtWidgets.QLabel("MSMM BEACON"); brand.setObjectName("brand")
        brand.setAlignment(QtCore.Qt.AlignCenter)
        self.clock_label = QtWidgets.QLabel("--:--"); self.clock_label.setObjectName("clock")
        self.clock_label.setAlignment(QtCore.Qt.AlignCenter)
        self.date_label = QtWidgets.QLabel(""); self.date_label.setObjectName("date")
        self.date_label.setAlignment(QtCore.Qt.AlignCenter)
        hint = QtWidgets.QLabel("Tap your fob to punch in or out"); hint.setObjectName("hint")
        hint.setAlignment(QtCore.Qt.AlignCenter)
        loc = QtWidgets.QLabel(self.cfg.location_label or ""); loc.setObjectName("location")
        loc.setAlignment(QtCore.Qt.AlignCenter)
        for x in (brand, self.clock_label, self.date_label):
            v.addWidget(x)
        v.addSpacing(30)
        v.addWidget(hint)
        v.addStretch(1)
        v.addWidget(loc)
        return w

    def _build_busy(self):
        w = self._page()
        v = QtWidgets.QVBoxLayout(w)
        v.addStretch(1)
        self.busy_label = QtWidgets.QLabel("Reading…"); self.busy_label.setObjectName("name")
        self.busy_label.setAlignment(QtCore.Qt.AlignCenter)
        v.addWidget(self.busy_label)
        v.addStretch(1)
        return w

    def _build_prompt(self):
        w = self._page()
        v = QtWidgets.QVBoxLayout(w)
        v.setContentsMargins(50, 40, 50, 40)
        self.prompt_name = QtWidgets.QLabel(""); self.prompt_name.setObjectName("name")
        self.prompt_name.setAlignment(QtCore.Qt.AlignCenter)
        self.prompt_status = QtWidgets.QLabel(""); self.prompt_status.setObjectName("statusLine")
        self.prompt_status.setAlignment(QtCore.Qt.AlignCenter)
        v.addWidget(self.prompt_name)
        v.addWidget(self.prompt_status)
        v.addSpacing(20)

        # Container that we repopulate per punch (grid for OUT, single button
        # for IN).
        self.prompt_body = QtWidgets.QWidget()
        self.prompt_body_layout = QtWidgets.QGridLayout(self.prompt_body)
        self.prompt_body_layout.setSpacing(18)
        v.addWidget(self.prompt_body, 1)

        skip = QtWidgets.QPushButton("Skip"); skip.setObjectName("ghost")
        skip.clicked.connect(self._go_idle)
        v.addWidget(skip, 0, QtCore.Qt.AlignCenter)
        return w

    def _build_confirm(self):
        w = self._page()
        v = QtWidgets.QVBoxLayout(w)
        v.addStretch(1)
        self.confirm_icon = QtWidgets.QLabel("✓"); self.confirm_icon.setObjectName("bigicon")
        self.confirm_icon.setAlignment(QtCore.Qt.AlignCenter)
        self.confirm_text = QtWidgets.QLabel(""); self.confirm_text.setObjectName("statusLine")
        self.confirm_text.setAlignment(QtCore.Qt.AlignCenter)
        v.addWidget(self.confirm_icon)
        v.addWidget(self.confirm_text)
        v.addStretch(1)
        return w

    def _build_error(self):
        w = self._page()
        v = QtWidgets.QVBoxLayout(w)
        v.addStretch(1)
        self.error_title = QtWidgets.QLabel("Something went wrong"); self.error_title.setObjectName("name")
        self.error_title.setAlignment(QtCore.Qt.AlignCenter)
        self.error_body = QtWidgets.QLabel(""); self.error_body.setObjectName("subline")
        self.error_body.setAlignment(QtCore.Qt.AlignCenter)
        self.error_body.setWordWrap(True)
        v.addWidget(self.error_title)
        v.addWidget(self.error_body)
        v.addStretch(1)
        return w

    # ---- clock -----------------------------------------------------------
    def _tick_clock(self):
        now = datetime.now()
        self.clock_label.setText(now.strftime("%-I:%M"))
        self.date_label.setText(now.strftime("%A, %B %-d"))

    # ---- navigation ------------------------------------------------------
    def _go_idle(self):
        self._busy = False
        self._pending = None
        self._idle_timer.stop()
        self.stack.setCurrentIndex(self.PAGE_IDLE)

    def _accent(self, label: QtWidgets.QLabel, color: str):
        label.setStyleSheet(f"color: {color};")

    # ---- tap → punch -----------------------------------------------------
    @QtCore.pyqtSlot(str)
    def on_tap(self, uid: str):
        if self._busy:
            return
        self._busy = True
        self._return_timer.stop()
        self._idle_timer.stop()
        self.busy_label.setText("Reading…")
        self.stack.setCurrentIndex(self.PAGE_BUSY)
        self._run(post_punch, self.cfg, uid, slot=self.on_punch_result)

    @QtCore.pyqtSlot(object)
    def on_punch_result(self, resp: dict):
        if not isinstance(resp, dict) or not resp.get("ok"):
            self._show_error(resp if isinstance(resp, dict) else {})
            return

        user  = resp.get("user") or {}
        name  = (user.get("first_name") or user.get("display_name") or "there").strip()
        state = resp.get("state") or "out"
        self._pending = {
            "user": user,
            "state": state,
            "interval_id": resp.get("open_interval_id"),
        }

        self.prompt_name.setText(name)
        if state == "in":
            self.prompt_status.setText("You're clocked IN")
            self._accent(self.prompt_status, GREEN)
            self._populate_in()
        else:
            self.prompt_status.setText("You're now OUT — where are you headed?")
            self._accent(self.prompt_status, RED)
            self._populate_out()

        self.stack.setCurrentIndex(self.PAGE_PROMPT)
        self._busy = False
        self._idle_timer.start(self.cfg.category_timeout_sec * 1000)

    def _clear_body(self):
        while self.prompt_body_layout.count():
            item = self.prompt_body_layout.takeAt(0)
            wdg = item.widget()
            if wdg:
                wdg.deleteLater()

    def _populate_in(self):
        self._clear_body()
        btn = QtWidgets.QPushButton("Working"); btn.setObjectName("primary")
        btn.clicked.connect(lambda: self.on_category("work"))
        self.prompt_body_layout.addWidget(btn, 0, 0)

    def _populate_out(self):
        self._clear_body()
        # 5 categories → 2 columns, last spans both for a tidy grid.
        for i, (key, label) in enumerate(OUT_CATEGORIES):
            btn = QtWidgets.QPushButton(label); btn.setObjectName("cat")
            btn.clicked.connect(lambda _=False, k=key: self.on_category(k))
            row, col = divmod(i, 2)
            if i == len(OUT_CATEGORIES) - 1 and len(OUT_CATEGORIES) % 2 == 1:
                self.prompt_body_layout.addWidget(btn, row, 0, 1, 2)
            else:
                self.prompt_body_layout.addWidget(btn, row, col)

    # ---- category pick → tag --------------------------------------------
    def on_category(self, category: str):
        if not self._pending:
            self._go_idle()
            return
        interval_id = self._pending.get("interval_id")
        self._idle_timer.stop()
        if not interval_id:
            # No interval to tag (shouldn't happen) — just confirm the punch.
            self._show_confirm(category)
            return
        self._busy = True
        self.busy_label.setText("Saving…")
        self.stack.setCurrentIndex(self.PAGE_BUSY)
        self._run(post_tag, self.cfg, interval_id, category,
                  slot=lambda resp: self._show_confirm(category, resp))

    def _show_confirm(self, category: str, resp: dict | None = None):
        # We confirm even if the tag POST failed — the punch itself already
        # landed; a failed label is non-critical and self-heals via the web app.
        name = ((self._pending or {}).get("user") or {}).get("first_name") or "you"
        state = (self._pending or {}).get("state") or "out"
        self.confirm_icon.setText("✓")
        if state == "in":
            self._accent(self.confirm_icon, GREEN)
            self.confirm_text.setText(f"Welcome, {name}!")
        else:
            self._accent(self.confirm_icon, RED)
            label = dict(OUT_CATEGORIES).get(category, "Out")
            self.confirm_text.setText(f"See you later, {name} · {label}")
        self.stack.setCurrentIndex(self.PAGE_CONFIRM)
        self._busy = False
        self._pending = None
        self._return_timer.start(self.cfg.confirm_sec * 1000)

    # ---- errors ----------------------------------------------------------
    def _show_error(self, resp: dict):
        code = (resp or {}).get("code") or "error"
        msgs = {
            "unenrolled":  ("Fob not recognized", "Ask an admin to enroll your tag in Beacon."),
            "disabled":    ("Timekeeping paused", "This workspace has time tracking turned off."),
            "network":     ("No connection", "Use the Beacon app to punch until the network is back."),
            "device_unknown": ("Device not registered", "Register this kiosk in Time Admin → NFC."),
            "week_locked": ("Week locked", "That week is approved — submit a correction in Beacon."),
        }
        title, body = msgs.get(code, ("Something went wrong", str((resp or {}).get("message") or code)))
        self.error_title.setText(title)
        self.error_body.setText(body)
        self.stack.setCurrentIndex(self.PAGE_ERROR)
        self._busy = False
        self._pending = None
        self._return_timer.start(self.cfg.confirm_sec * 1000)

    # ---- reader errors ---------------------------------------------------
    @QtCore.pyqtSlot(str)
    def on_reader_error(self, msg: str):
        LOG.warning("reader error surfaced: %s", msg)
        # Don't hijack the screen mid-interaction; only note it while idle.

    # ---- worker plumbing -------------------------------------------------
    def _run(self, fn, *args, slot):
        t = CallThread(fn, *args)
        t.result.connect(slot)
        t.finished.connect(lambda: self._threads.remove(t) if t in self._threads else None)
        self._threads.append(t)
        t.start()

    # ---- dev: simulate a tap with the "T" key ----------------------------
    def keyPressEvent(self, e: QtGui.QKeyEvent):
        test_uid = os.environ.get("BEACON_KIOSK_TEST_UID")
        if test_uid and e.key() == QtCore.Qt.Key_T:
            LOG.info("simulated tap (test uid): %s", test_uid)
            self.on_tap(test_uid)
        elif e.key() in (QtCore.Qt.Key_Escape, QtCore.Qt.Key_Q):
            QtWidgets.QApplication.quit()
        else:
            super().keyPressEvent(e)


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

    app = QtWidgets.QApplication(sys.argv)
    app.setOverrideCursor(QtGui.QCursor(QtCore.Qt.BlankCursor))   # touchscreen — hide pointer

    win = KioskWindow(cfg)
    win.showFullScreen()

    reader = NfcReaderThread(cfg)
    reader.tapped.connect(win.on_tap)                  # queued: runs on UI thread
    reader.reader_error.connect(win.on_reader_error)
    reader.start()

    try:
        rc = app.exec_()
    finally:
        reader.stop()
        reader.wait(2000)
    sys.exit(rc)


if __name__ == "__main__":
    main()
