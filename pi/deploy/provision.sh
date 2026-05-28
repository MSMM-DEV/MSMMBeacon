#!/usr/bin/env bash
# Provision a fresh Raspberry Pi for the MSMM Beacon Timeclock.
#
# Two front-ends, pick one with MODE:
#   MODE=kiosk    (default) — 7" PyQt5 touchscreen (kiosk.py, beacon-kiosk.service).
#                             Runs in the desktop session as KIOSK_USER (default: pi).
#                             Requires Raspberry Pi OS *with Desktop* + autologin.
#   MODE=headless           — OLED/LED daemon (timeclock.py, beacon-timeclock.service).
#                             Runs as the "beacon" system user. Raspberry Pi OS Lite is fine.
#
# Run as root on a clean install:
#   sudo bash provision.sh                       # kiosk, user 'pi'
#   sudo MODE=kiosk KIOSK_USER=lobby bash provision.sh
#   sudo MODE=headless bash provision.sh
#
# Then:
#   1. Edit /etc/beacon-timeclock/config.ini (bearer token + endpoint URL + [ui] mode)
#   2. Register this device in Beacon (Time Admin → NFC → Register device), using the
#      same `id` as config.ini.
#   3. Enable the matching service (printed at the end).

set -euo pipefail

MODE="${MODE:-kiosk}"
KIOSK_USER="${KIOSK_USER:-pi}"

APP_DIR=/opt/beacon-timeclock
CFG_DIR=/etc/beacon-timeclock
LOG_DIR=/var/log/beacon-timeclock

if [ "$MODE" = "kiosk" ]; then
  SVC_USER="$KIOSK_USER"
else
  SVC_USER=beacon
fi

echo "==> MODE=$MODE  service user=$SVC_USER"

echo "==> install OS packages"
apt-get update
apt-get install -y \
  python3 python3-venv python3-pip \
  i2c-tools \
  libnfc-bin libnfc-dev \
  libusb-1.0-0 libusb-1.0-0-dev
if [ "$MODE" = "kiosk" ]; then
  # PyQt5 from apt (pip-building it on a Pi is painful) + xset for the
  # no-blank screen tweak. The venv is created with --system-site-packages
  # below so it can see this PyQt5.
  apt-get install -y python3-pyqt5 x11-xserver-utils
fi

echo "==> create service user"
if [ "$MODE" = "headless" ]; then
  id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$SVC_USER"
else
  id -u "$SVC_USER" >/dev/null 2>&1 || { echo "kiosk user '$SVC_USER' does not exist — create it or set KIOSK_USER"; exit 1; }
fi

echo "==> create dirs"
mkdir -p "$APP_DIR" "$CFG_DIR" "$LOG_DIR"
chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR" "$LOG_DIR"
chmod 755 "$APP_DIR"

echo "==> copy timeclock.py + kiosk.py + sample config"
SRC_DIR="$(dirname "$(readlink -f "$0")")/.."
install -m 0755 "$SRC_DIR/timeclock.py" "$APP_DIR/timeclock.py"
install -m 0755 "$SRC_DIR/kiosk.py"     "$APP_DIR/kiosk.py"
# config.ini holds the device bearer token → keep it private to the service user.
[ -e "$CFG_DIR/config.ini" ] || install -m 0600 -o "$SVC_USER" -g "$SVC_USER" "$SRC_DIR/config.example.ini" "$CFG_DIR/config.ini"

echo "==> Python venv (--system-site-packages so apt PyQt5 is visible)"
sudo -u "$SVC_USER" python3 -m venv --system-site-packages "$APP_DIR/.venv"
sudo -u "$SVC_USER" "$APP_DIR/.venv/bin/pip" install --upgrade pip
sudo -u "$SVC_USER" "$APP_DIR/.venv/bin/pip" install nfcpy requests luma.oled pillow

echo "==> systemd unit"
if [ "$MODE" = "kiosk" ]; then
  sed "s/__KIOSK_USER__/${SVC_USER}/g" "$SRC_DIR/systemd/beacon-kiosk.service" \
    > /etc/systemd/system/beacon-kiosk.service
  UNIT=beacon-kiosk
else
  install -m 0644 "$SRC_DIR/systemd/timeclock.service" /etc/systemd/system/beacon-timeclock.service
  UNIT=beacon-timeclock
fi
systemctl daemon-reload

echo
echo "Provisioned ($MODE). Next steps:"
echo "  1. Edit /etc/beacon-timeclock/config.ini (bearer token, endpoint URL, [ui] mode=$MODE)"
if [ "$MODE" = "kiosk" ]; then
  echo "  2. Ensure the Pi boots to Desktop with autologin as '$SVC_USER':"
  echo "       sudo raspi-config  → System Options → Boot/Auto Login → Desktop Autologin"
  echo "     and enable I2C:  raspi-config → Interface Options → I2C → Yes"
fi
echo "  3. sudo systemctl enable --now $UNIT"
echo "  4. journalctl -u $UNIT -f"
