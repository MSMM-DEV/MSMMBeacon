#!/usr/bin/env bash
# Provision a fresh Raspberry Pi for the MSMM Beacon Timeclock.
#
# Run as root on a clean Raspbian / Ubuntu Server install:
#   sudo bash provision.sh
#
# Then:
#   1. Copy your config to /etc/beacon-timeclock/config.ini
#   2. systemctl enable --now beacon-timeclock

set -euo pipefail

APP_DIR=/opt/beacon-timeclock
CFG_DIR=/etc/beacon-timeclock
LOG_DIR=/var/log/beacon-timeclock
SVC_USER=beacon

echo "==> install OS packages"
apt-get update
apt-get install -y \
  python3 python3-venv python3-pip \
  i2c-tools \
  libnfc-bin libnfc-dev \
  libusb-1.0-0 libusb-1.0-0-dev

echo "==> create service user"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$SVC_USER"

echo "==> create dirs"
mkdir -p "$APP_DIR" "$CFG_DIR" "$LOG_DIR"
chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR" "$LOG_DIR"
chmod 755 "$APP_DIR"

echo "==> copy timeclock.py + sample config"
SRC_DIR="$(dirname "$(readlink -f "$0")")/.."
install -m 0755 "$SRC_DIR/timeclock.py" "$APP_DIR/timeclock.py"
[ -e "$CFG_DIR/config.ini" ] || install -m 0640 -o "$SVC_USER" -g "$SVC_USER" "$SRC_DIR/config.example.ini" "$CFG_DIR/config.ini"

echo "==> Python venv"
sudo -u "$SVC_USER" python3 -m venv "$APP_DIR/.venv"
sudo -u "$SVC_USER" "$APP_DIR/.venv/bin/pip" install --upgrade pip
sudo -u "$SVC_USER" "$APP_DIR/.venv/bin/pip" install nfcpy requests luma.oled pillow

echo "==> systemd unit"
install -m 0644 "$SRC_DIR/systemd/timeclock.service" /etc/systemd/system/beacon-timeclock.service
systemctl daemon-reload

echo
echo "Provisioned. Next steps:"
echo "  1. Edit /etc/beacon-timeclock/config.ini (bearer token + endpoint URL)"
echo "  2. sudo systemctl enable --now beacon-timeclock"
echo "  3. journalctl -u beacon-timeclock -f"
