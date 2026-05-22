# MSMM Beacon Timeclock — Raspberry Pi

NFC tap-in/tap-out daemon. Reads NFC fobs with a PN532 (I2C/UART) or
ACR122U (USB) reader, posts each tap to the Supabase `timeclock-punch`
Edge Function, and surfaces the response on an optional SSD1306 OLED.

## Hardware

Recommended cheap build (≈ $35):

| Part            | Notes                                                  |
|-----------------|--------------------------------------------------------|
| Raspberry Pi 3A+ / Zero 2 W / 4 | Any model with I2C and Wi-Fi or Ethernet |
| PN532 NFC HAT (I2C) | Most reliable. Set switch to I2C, address 0x24. |
| SSD1306 128×64 OLED | I2C @ 0x3C. Optional but vastly improves the UX. |
| Personal NFC fobs (Mifare Classic 1K, 13.56 MHz) | One per employee, ≈ $1 each in bulk. |
| Power adapter (3 A USB-C) | Wall-mounted enclosure recommended.             |

## Install

```bash
# 1. Burn Raspbian Lite, enable SSH + I2C in raspi-config
sudo raspi-config        # → Interface Options → I2C → Yes
sudo apt-get update && sudo apt-get install git
git clone https://github.com/rmehta-msmm/MSMMBeacon.git ~/MSMMBeacon
cd ~/MSMMBeacon/pi

# 2. Provision (installs deps + systemd unit + venv + nfcpy + luma.oled)
sudo bash deploy/provision.sh

# 3. Fill in config
sudo nano /etc/beacon-timeclock/config.ini
#   - endpoint_url = your function URL
#   - bearer_token = TIMECLOCK_DEVICE_KEY (random 32-byte hex; same value
#     set as a Supabase function secret)

# 4. Register this device in Beacon first (Time Admin → NFC → Register
#    device), using the `id` you put in the config.

# 5. Start it
sudo systemctl enable --now beacon-timeclock
journalctl -u beacon-timeclock -f
```

## How it works

```
fob tap  →  nfcpy reads UID  →  HTTP POST timeclock-punch
                                  ↳ source=nfc, device_id, nfc_uid,
                                    punched_at (advisory)
                                ↓
                          Edge Function:
                            • dedupe (30-s window)
                            • resolve nfc_uid → user
                            • insert time_punches (trigger reconciles intervals)
                            • kick timeclock-classify
                          ↓
              { ok, state: 'in'|'out', user, message }
                          ↓
                       OLED shows the message for 3s
```

## Troubleshooting

- **`reader busy` / no UID read** — confirm I2C: `sudo i2cdetect -y 1`
  should show `24` for the PN532 and `3C` for the OLED.
- **`unenrolled` from the function** — the UID has no row in
  `beacon_v2.nfc_tags`. Open Time Admin → NFC enrollment, click
  "Capture next tap", then tap the fob.
- **`device_unknown`** — register the device first (Time Admin → NFC →
  Register device), using the same `id` from `config.ini`.
- **`disabled`** — workspace toggle `app_settings.tk_enabled` is off.
  Flip it on from Time Admin → Settings.
- **Pi clock skew** — `sudo timedatectl status`. The server overrides
  drift > 60 s automatically; if it's hours off, run `sudo timedatectl
  set-ntp true`.

## What's NOT in v1

- Offline buffer (no internet → red blink, user web-punches instead)
- Auto-update of the Pi software (manual `git pull && systemctl restart`)
- Multi-zone IN/OUT readers (single shared toggle Pi for now)

Both are tracked for v1.1.
