#!/bin/bash -e

# Clean up any locks left behind after a restart
sh -c "rm -f /tmp/.X*-lock"

# Start a virtual frame buffer X server
SCREEN_GEOM=${1:-1024x768x16}
Xvfb :${DISPLAY_NUM:-20} -screen 0 $SCREEN_GEOM &

# Start window manager
DISPLAY=:${DISPLAY_NUM:-20} fluxbox &

# Run x11vnc using the existing X server
x11vnc -display :${DISPLAY_NUM:-20} \
    -bg -forever \
    -passwd vscode \
    -logfile /var/log/x11vnc.log &

# Wait for window manager to be ready
while ! xdpyinfo -display :${DISPLAY_NUM:-20} >/dev/null 2>&1; do sleep 1; done

# Run HTTP server
DISPLAY=:${DISPLAY_NUM:-20} exec node \
    --trace-warnings \
    --experimental-specifier-resolution=node \
    dist/main.js
