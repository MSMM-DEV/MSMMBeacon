# MSMM Beacon Timeclock — Raspberry Pi

NFC tap-in/tap-out for the office. Reads NFC fobs (PN532 over I2C/UART, or
ACR122U over USB), posts each tap to the Supabase `timeclock-punch` Edge
Function, and surfaces the result.

Two front-ends — pick one per Pi:

| Mode | File / service | Display | OS |
|---|---|---|---|
| **`kiosk`** (recommended) | `kiosk.py` · `beacon-kiosk.service` | **Official 7" touchscreen** — shows the person's name + a tap-to-pick category (Lunch / Meeting / Travel / Break / Done for the day) | Raspberry Pi OS **with Desktop** + autologin |
| `headless` | `timeclock.py` · `beacon-timeclock.service` | 128×64 SSD1306 OLED (or none) | Raspberry Pi OS Lite |

The two are mutually exclusive on one Pi (they'd both grab the reader). The mode
is set in `config.ini` `[ui] mode` and chosen at provision time via `MODE=`.

## Hardware

### Kiosk build (Pi 3 + 7" touchscreen, ≈ $110)

| Part | Connection | Notes |
|---|---|---|
| Raspberry Pi 3B / 3B+ | — | Has the DSI connector the official screen uses. |
| Official Raspberry Pi 7" Touchscreen (800×480, capacitive) | **DSI ribbon** + two GPIO jumpers (5V, GND) for power | Touch rides the DSI bus — it does **not** use the GPIO I2C pins, so it never conflicts with the PN532. |
| PN532 NFC HAT/module | **GPIO I2C** (SDA=GPIO2, SCL=GPIO3) @ 0x24, or UART | I2C bus 1 stays free for it. |
| Personal NFC fobs (Mifare Classic 1K, 13.56 MHz) | — | One per employee, ≈ $1 each in bulk. |
| **3 A** 5V USB-C power adapter | — | The screen backlight + Pi 3 exceed the stock 2.5 A supply — use 3 A. |

Wall-mount enclosure recommended. ACR122U (USB) works too — no GPIO conflict
with the screen either way.

### Headless build (≈ $35)

Pi 3A+ / Zero 2 W / 4 + PN532 + optional SSD1306 OLED. See the `headless` install below.

## Install — kiosk (7" touchscreen)

```bash
# 1. Flash Raspberry Pi OS *with Desktop*. In raspi-config:
sudo raspi-config
#    → System Options → Boot / Auto Login → Desktop Autologin
#    → Interface Options → I2C → Yes
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/rmehta-msmm/MSMMBeacon.git ~/MSMMBeacon
cd ~/MSMMBeacon/pi

# 2. Provision (installs deps incl. python3-pyqt5, venv, systemd unit).
#    KIOSK_USER defaults to 'pi' — set it if your autologin user differs.
sudo MODE=kiosk KIOSK_USER=pi bash deploy/provision.sh

# 3. Fill in config (bearer token + endpoint URL + [ui] settings).
sudo nano /etc/beacon-timeclock/config.ini

# 4. Register this device in Beacon (Time Admin → NFC → Register device),
#    using the `id` from config.ini.

# 5. Start it (launches full-screen in the desktop session).
sudo systemctl enable --now beacon-kiosk
journalctl -u beacon-kiosk -f
```

**Test without a reader** (e.g. on a desktop): set `BEACON_KIOSK_TEST_UID` to an
enrolled fob's UID and press the **T** key to simulate a tap. **Esc / Q** quits.

```bash
BEACON_KIOSK_TEST_UID=04:AA:BB:CC python3 kiosk.py --config dev.ini -v
```

## Install — headless (OLED)

```bash
sudo raspi-config        # → Interface Options → I2C → Yes
git clone https://github.com/rmehta-msmm/MSMMBeacon.git ~/MSMMBeacon
cd ~/MSMMBeacon/pi
sudo MODE=headless bash deploy/provision.sh
sudo nano /etc/beacon-timeclock/config.ini    # set [ui] mode = headless
sudo systemctl enable --now beacon-timeclock
```

## How the kiosk works

```
fob tap → nfcpy reads UID → POST timeclock-punch (device bearer)
                              ↳ source=nfc, device_id, nfc_uid
                            ↓ Edge Function: dedupe → resolve UID→user →
                              insert time_punches (trigger TOGGLES the interval) →
                              kick timeclock-classify
                            ↓ { ok, state:'in'|'out', user, open_interval_id }
              screen shows "Hi <name> — you're now IN/OUT"
                  IN  → one "Working" confirm
                  OUT → category grid (Lunch / Meeting / Travel / Break / Done)
                            ↓ user taps a category
              POST timeclock-punch { action:'tag', interval_id, category }
                            ↳ device-authed; sets category (source='user') on the
                              interval the punch just opened, recomputes the day
                            ↓ "✓ See you later, <name>"  → idle clock screen
```

Punch direction is the source of truth: **IN = at desk = counts (green); OUT =
out of office = never counts (red)**. The category is just a label of where the
person is. The device secret never leaves the Pi — only this process holds the
bearer token and makes the punch + tag calls; the screen is pure presentation.

## Troubleshooting

- **`reader busy` / no UID** — confirm I2C: `sudo i2cdetect -y 1` should show
  `24` for the PN532.
- **`unenrolled`** — the UID has no `beacon_v2.nfc_tags` row. Time Admin → NFC →
  "Capture next tap", then tap the fob.
- **`device_unknown`** — register the device first (Time Admin → NFC → Register
  device) with the same `id` as `config.ini`.
- **`disabled`** — `app_settings.tk_enabled` is off. Flip it on in Time Admin → Settings.
- **Kiosk shows nothing / black** — confirm the Pi booted to **Desktop autologin**
  and `KIOSK_USER` matches the logged-in user; check `journalctl -u beacon-kiosk -f`
  for `DISPLAY`/`XAUTHORITY` errors.
- **Pi clock skew** — `sudo timedatectl set-ntp true`. The server overrides drift
  > 60 s automatically.

## What's NOT in v1

- Offline buffer (no internet → the kiosk shows "no connection", user web-punches).
- Auto-update of the Pi software (manual `git pull && systemctl restart`).
- Multi-zone IN/OUT readers (single shared toggle Pi for now).
