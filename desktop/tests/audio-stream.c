#include <pipewire/pipewire.h>
#include <dbus/dbus.h>
#include <spa/param/audio/format-utils.h>
#include <stdio.h>
#include <string.h>
#include <signal.h>
#include <time.h>
#include <math.h>

static struct pw_main_loop *loop;
static struct pw_stream *stream;
static unsigned buffers;
static bool failed;
static bool capture;
static bool captured_signal;
static bool manual, missing;
static bool activated;
static unsigned channels = 2, target_buffers = 1500;
static void process(void *data)
{
    (void)data;
    struct pw_buffer *buffer = pw_stream_dequeue_buffer(stream);
    if (!buffer) return;
    struct spa_data *output = &buffer->buffer->datas[0];
    if (output->data) {
        if (capture) {
            if (output->chunk->size && output->chunk->offset <= output->maxsize &&
                output->chunk->size <= output->maxsize - output->chunk->offset) {
                buffers++;
                if (buffers == 1) {
                    struct pw_time timing = {0};
                    if (pw_stream_get_time_n(stream, &timing, sizeof(timing)) == 0)
                        fprintf(stderr, "Audio capture: %u frames, clock %u/%u\n",
                            output->chunk->size / (channels * (unsigned)sizeof(float)),
                            timing.rate.num, timing.rate.denom);
                }
                const float *samples = (const float *)((const char *)output->data + output->chunk->offset);
                for (unsigned i = 0; i < output->chunk->size / sizeof(float); i++)
                    if (isfinite(samples[i]) && fabsf(samples[i]) > 0.001f) captured_signal = true;
            }
        } else {
            unsigned size = SPA_MIN(output->maxsize, 256u * channels * sizeof(float));
            memset(output->data, 0, size);
            output->chunk->offset = 0; output->chunk->stride = channels * sizeof(float); output->chunk->size = size;
            buffers++;
        }
    }
    pw_stream_queue_buffer(stream, buffer);
    if (buffers >= target_buffers) pw_main_loop_quit(loop);
}
static void state_changed(void *data, enum pw_stream_state old, enum pw_stream_state state, const char *error)
{
    (void)data; (void)old;
    if (state == PW_STREAM_STATE_STREAMING) activated = true;
    if (state == PW_STREAM_STATE_ERROR) {
        fprintf(stderr, "FAIL: audio fixture stream: %s\n", error);
        failed = true; pw_main_loop_quit(loop);
    }
}
static void timed_out(void *data, uint64_t expirations)
{
    (void)data; (void)expirations;
    if (!manual && !missing) { failed = true; fprintf(stderr, "FAIL: audio routing timed out (%u buffers)\n", buffers); }
    pw_main_loop_quit(loop);
}
static const struct pw_stream_events events = { PW_VERSION_STREAM_EVENTS, .state_changed = state_changed, .process = process };
int main(int argc, char **argv)
{
    capture = argc == 2 && !strcmp(argv[1], "capture");
    manual = argc == 2 && !strcmp(argv[1], "manual");
    missing = argc == 2 && !strcmp(argv[1], "missing");
    if (argc == 2 && !strcmp(argv[1], "mono")) channels = 1;
    if (capture || channels == 1) target_buffers = 100;
    pw_init(NULL, NULL);
    loop = pw_main_loop_new(NULL);
    if (!loop) { pw_deinit(); dbus_shutdown(); return 1; }
    struct spa_source *timer = pw_loop_add_timer(pw_main_loop_get_loop(loop), timed_out, NULL);
    struct timespec timeout = { .tv_sec = manual || missing ? 2 : 35 };
    pw_loop_update_timer(pw_main_loop_get_loop(loop), timer, &timeout, NULL, false);
    struct pw_properties *props = pw_properties_new(
        PW_KEY_MEDIA_TYPE, "Audio", PW_KEY_MEDIA_CATEGORY, capture ? "Capture" : "Playback", PW_KEY_MEDIA_ROLE, "Test",
        PW_KEY_NODE_NAME, capture ? "Polly-Test-Capture" : manual ? "Polly-Test-Manual" :
            missing ? "Polly-Test-Missing" : "Polly-Test-Stream",
        PW_KEY_APP_NAME, "Polly audio stream fixture", NULL);
    if (missing) pw_properties_set(props, PW_KEY_TARGET_OBJECT, "Polly-Test-B");
    stream = pw_stream_new_simple(pw_main_loop_get_loop(loop), "Polly test playback", props, &events, NULL);
    if (!stream) {
        pw_loop_destroy_source(pw_main_loop_get_loop(loop), timer);
        pw_main_loop_destroy(loop); pw_deinit(); dbus_shutdown(); return 1;
    }
    uint8_t buffer[512];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    struct spa_audio_info_raw info = { .format = SPA_AUDIO_FORMAT_F32, .rate = 48000, .channels = channels,
        .position = { SPA_AUDIO_CHANNEL_FL, SPA_AUDIO_CHANNEL_FR } };
    if (channels == 1) info.position[0] = SPA_AUDIO_CHANNEL_MONO;
    const struct spa_pod *params[] = { spa_format_audio_raw_build(&builder, SPA_PARAM_EnumFormat, &info) };
    int result = pw_stream_connect(stream, capture ? PW_DIRECTION_INPUT : PW_DIRECTION_OUTPUT, PW_ID_ANY,
        (manual ? 0 : PW_STREAM_FLAG_AUTOCONNECT) | PW_STREAM_FLAG_MAP_BUFFERS, params, 1);
    if (result >= 0) pw_main_loop_run(loop);
    pw_stream_destroy(stream);
    pw_loop_destroy_source(pw_main_loop_get_loop(loop), timer);
    pw_main_loop_destroy(loop); pw_deinit();
    /* The standalone fixture owns all users of libdbus, including PipeWire's RT module. */
    dbus_shutdown();
    if (manual || missing) {
        if (!failed && result >= 0 && !buffers && !activated) {
            puts("PASS: policy respects manual routing and unavailable explicit targets");
            return 0;
        }
        fprintf(stderr, "FAIL: explicitly unrouted stream activated or failed (%u buffers)\n", buffers);
        return 1;
    }
    if (!failed && result >= 0 && buffers >= target_buffers && (!capture || captured_signal)) {
        puts("PASS: real PipeWire stream processed audio through Polly-owned routes"); return 0;
    }
    return 1;
}
