# Sourced by a session owner with a private $runtime directory and $repo.
start_private_audio() {
    if ! command -v pipewire >/dev/null 2>&1; then
        echo "Private audio requires the PipeWire core daemon" >&2; return 1
    fi
    unset PIPEWIRE_REMOTE PIPEWIRE_RUNTIME_DIR PULSE_SERVER
    audio_config=${1:-"$repo/desktop/system/pipewire.conf"}
    PIPEWIRE_CONFIG_DIR=$(dirname -- "$audio_config") PIPEWIRE_CONFIG_NAME=$(basename -- "$audio_config") \
        pipewire >"$runtime/audio.log" 2>&1 &
    audio_pid=$!
    i=0
    while [ ! -S "$runtime/polly-audio" ]; do
        if ! kill -0 "$audio_pid" 2>/dev/null || [ "$i" -ge 200 ]; then
            echo "Cannot start private PipeWire core" >&2; cat "$runtime/audio.log" >&2; return 1
        fi
        sleep 0.02; i=$((i + 1))
    done
    export PIPEWIRE_REMOTE=polly-audio POLLY_AUDIO_REMOTE=polly-audio
    export PULSE_SERVER=disabled:
    printf 'Private PipeWire core ready (pid %s); log: %s/audio.log\n' "$audio_pid" "$runtime"
}
stop_private_audio() {
    if [ -n "${audio_pid:-}" ]; then
        kill -TERM "$audio_pid" 2>/dev/null || true
        wait "$audio_pid" 2>/dev/null || true
        audio_pid=
    fi
    rm -f "$runtime/polly-audio" "$runtime/polly-audio.lock" "$runtime/audio.log"
}
