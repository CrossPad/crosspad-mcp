#!/usr/bin/env bash
# Install ST-Link udev rules so pyOCD/libusb can claim the probe without root.
# Requires sudo. Without these, pyOCD may fail with permission/USB errors even
# though `lsusb` shows the device (st-info succeeding only proves the CURRENT
# user already happens to have access).
set -euo pipefail

RULE=/etc/udev/rules.d/49-stlink.rules
echo "[udev] writing $RULE (needs sudo)"
sudo tee "$RULE" >/dev/null <<'EOF'
# ST-Link/V1
SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="3744", MODE="0666", TAG+="uaccess"
# ST-Link/V2
SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="3748", MODE="0666", TAG+="uaccess"
# ST-Link/V2-1
SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="374b", MODE="0666", TAG+="uaccess"
# ST-Link/V3
SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="374d", MODE="0666", TAG+="uaccess"
SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="374e", MODE="0666", TAG+="uaccess"
SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="374f", MODE="0666", TAG+="uaccess"
SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="3753", MODE="0666", TAG+="uaccess"
EOF
sudo udevadm control --reload-rules
sudo udevadm trigger
echo "[udev] DONE. Replug the ST-Link for the new rules to take effect."
