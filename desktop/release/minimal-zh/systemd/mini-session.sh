#!/bin/busybox sh
# Root wrapper: drop to UID 1000 for the graphical session.
exec /usr/bin/setpriv --reuid=1000 --regid=1000 --init-groups /usr/local/bin/polly-user-session.sh
