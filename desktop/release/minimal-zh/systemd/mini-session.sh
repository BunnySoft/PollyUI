#!/bin/busybox sh
# Root wrapper: open a PAM session and drop to UID 1000.
exec /usr/sbin/runuser -u polly -- /usr/local/bin/polly-user-session.sh
