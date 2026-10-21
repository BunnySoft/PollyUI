#define _GNU_SOURCE
#include "shared/video-wallpaper.h"
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/imgutils.h>
#include <libavutil/dict.h>
#include <libavutil/mem.h>
#include <libswscale/swscale.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static bool paused, stopped, waiting;
static int64_t origin, pause_started;
static int64_t clock_us(void)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
    return (int64_t)now.tv_sec * 1000000 + now.tv_nsec / 1000;
}
static bool publish(struct PuVideoMessage *message)
{
    message->magic = PU_VIDEO_MAGIC;
    message->version = PU_VIDEO_VERSION;
    return send(4, message, sizeof(*message), MSG_NOSIGNAL) == sizeof(*message);
}
static bool commands(int timeout)
{
    struct pollfd channel = {.fd = 4, .events = POLLIN};
    int ready;
    do { ready = poll(&channel, 1, timeout); } while (ready < 0 && errno == EINTR);
    if (ready < 0 || (ready && (channel.revents & (POLLERR | POLLHUP | POLLNVAL)))) return false;
    if (!ready) return true;
    struct PuVideoMessage message;
    ssize_t bytes = recv(4, &message, sizeof(message), 0);
    if (bytes != sizeof(message) || message.magic != PU_VIDEO_MAGIC || message.version != PU_VIDEO_VERSION)
        return false;
    if (message.operation == PU_VIDEO_STOP) stopped = true;
    else if (message.operation == PU_VIDEO_ACK) waiting = false;
    else if (message.operation == PU_VIDEO_PAUSE && !paused) {
        paused = true; pause_started = clock_us();
        struct PuVideoMessage status = {.operation = PU_VIDEO_STATUS, .flags = 1};
        if (!publish(&status)) return false;
    } else if (message.operation == PU_VIDEO_PLAY && paused) {
        int64_t now = clock_us();
        if (now < 0 || pause_started < 0) return false;
        origin += now - pause_started;
        paused = false;
        struct PuVideoMessage status = {.operation = PU_VIDEO_STATUS};
        if (!publish(&status)) return false;
    } else if (message.operation != PU_VIDEO_PAUSE && message.operation != PU_VIDEO_PLAY) return false;
    return !stopped;
}
static int read_input(void *opaque, uint8_t *buffer, int length)
{
    (void)opaque;
    if (!commands(0)) return AVERROR_EXIT;
    ssize_t bytes;
    do { bytes = read(3, buffer, (size_t)length); } while (bytes < 0 && errno == EINTR);
    return bytes > 0 ? (int)bytes : bytes == 0 ? AVERROR_EOF : AVERROR(errno);
}
static int64_t seek_input(void *opaque, int64_t offset, int whence)
{
    (void)opaque;
    if (whence == AVSEEK_SIZE) {
        off_t current = lseek(3, 0, SEEK_CUR), size = lseek(3, 0, SEEK_END);
        if (current < 0 || size < 0 || lseek(3, current, SEEK_SET) < 0) return AVERROR(errno);
        return size;
    }
    whence &= ~AVSEEK_FORCE;
    if (whence != SEEK_SET && whence != SEEK_CUR && whence != SEEK_END) return AVERROR(EINVAL);
    off_t position = lseek(3, offset, whence);
    return position < 0 ? AVERROR(errno) : position;
}
static int interrupt_input(void *opaque)
{
    (void)opaque;
    return stopped || !commands(0);
}
static int decode(bool loop, uint8_t *pixels)
{
    int result = AVERROR_UNKNOWN;
    AVFormatContext *format = avformat_alloc_context();
    AVIOContext *io = NULL;
    AVCodecContext *codec = NULL;
    AVPacket *packet = av_packet_alloc();
    AVFrame *frame = av_frame_alloc();
    struct SwsContext *scale = NULL;
    AVDictionary *probe_options[16] = {0};
    uint8_t *buffer = av_malloc(32768);
    const char *failure = "Cannot allocate the bounded local decoder";
    if (!format || !packet || !frame || !buffer) goto done;
    io = avio_alloc_context(buffer, 32768, 0, NULL, read_input, NULL, seek_input);
    if (!io) goto done;
    buffer = NULL;
    format->pb = io;
    format->flags |= AVFMT_FLAG_CUSTOM_IO;
    format->interrupt_callback = (AVIOInterruptCB){interrupt_input, NULL};
    format->probesize = 1024 * 1024;
    format->max_analyze_duration = 3000000;
    format->max_streams = 16;
    failure = "The selected file is not a supported local MP4/WebM video";
    result = avformat_open_input(&format, "file:polly-local-video", NULL, NULL);
    if (result < 0) goto done;
    if (format->nb_streams > 16) { result = AVERROR(EFBIG); goto done; }
    for (unsigned index = 0; index < format->nb_streams; index++) {
        AVCodecParameters *parameters = format->streams[index]->codecpar;
        if (parameters->codec_type == AVMEDIA_TYPE_VIDEO &&
            (parameters->width > 1920 || parameters->height > 1080)) {
            result = AVERROR(EFBIG); failure = "Video metadata exceeds the 1920x1080 source budget"; goto done;
        }
        if (av_dict_set(&probe_options[index], "max_pixels", "2073600", 0) < 0 ||
            av_dict_set(&probe_options[index], "threads", "2", 0) < 0) { result = AVERROR(ENOMEM); goto done; }
    }
    if ((result = avformat_find_stream_info(format, probe_options)) < 0) goto done;
    const AVCodec *decoder = NULL;
    int stream_index = av_find_best_stream(format, AVMEDIA_TYPE_VIDEO, -1, -1, &decoder, 0);
    if (stream_index < 0 || !decoder) {
        result = stream_index < 0 ? stream_index : AVERROR_DECODER_NOT_FOUND;
        goto done;
    }
    if (decoder->id != AV_CODEC_ID_H264 && decoder->id != AV_CODEC_ID_VP8 && decoder->id != AV_CODEC_ID_VP9) {
        result = AVERROR(ENOTSUP); goto done;
    }
    codec = avcodec_alloc_context3(decoder);
    if (!codec) { result = AVERROR(ENOMEM); goto done; }
    if ((result = avcodec_parameters_to_context(codec, format->streams[stream_index]->codecpar)) < 0)
        goto done;
    codec->max_pixels = PU_VIDEO_SOURCE_PIXELS;
    codec->thread_count = 2;
    codec->thread_type = FF_THREAD_SLICE;
    codec->pkt_timebase = format->streams[stream_index]->time_base;
    failure = "Video dimensions exceed the 1920x1080 source budget, or decoder initialization failed";
    if (codec->width < 1 || codec->height < 1 || codec->width > 1920 || codec->height > 1080) {
        result = AVERROR(EFBIG); goto done;
    }
    if ((result = avcodec_open2(codec, decoder, NULL)) < 0) goto done;
    struct PuVideoMessage initialized = {.operation = PU_VIDEO_INITIALIZED};
    if (!publish(&initialized)) { result = AVERROR(EPIPE); goto done; }
    AVStream *stream = format->streams[stream_index];
    AVRational rate = av_guess_frame_rate(format, stream, NULL);
    int64_t fallback_duration = rate.num > 0 && rate.den > 0 ?
        av_rescale_q(1, av_inv_q(rate), AV_TIME_BASE_Q) : 33333;
    if (fallback_duration < 8333 || fallback_duration > 10000000) {
        result = AVERROR(EINVAL); failure = "Video frame rate is outside the supported bound"; goto done;
    }
    int64_t first_pts = AV_NOPTS_VALUE, previous_pts = -33334, frame_index = 0, last_duration = fallback_duration;
    uint32_t loops = 0;
    bool draining = false;
    origin = clock_us();
    if (origin < 0) { result = AVERROR_EXTERNAL; goto done; }
    if (paused) pause_started = origin;
    while (!stopped) {
        failure = "Local video demuxing or decoding failed";
        while ((paused || waiting) && !stopped) if (!commands(-1)) { stopped = true; break; }
        if (stopped || !commands(0)) { result = AVERROR_EXIT; goto done; }
        result = avcodec_receive_frame(codec, frame);
        if (result == AVERROR(EAGAIN)) {
            if (draining) { result = AVERROR_INVALIDDATA; goto done; }
            do {
                av_packet_unref(packet);
                result = av_read_frame(format, packet);
            } while (result >= 0 && packet->stream_index != stream_index && commands(0));
            if (stopped) { result = AVERROR_EXIT; goto done; }
            if (result == AVERROR_EOF) {
                if (!frame_index || previous_pts < 0) { result = AVERROR_INVALIDDATA; goto done; }
                draining = true;
                result = avcodec_send_packet(codec, NULL);
            } else if (result >= 0) result = avcodec_send_packet(codec, packet);
            if (result < 0) goto done;
            continue;
        }
        if (result == AVERROR_EOF) {
            if (loops == UINT32_MAX) { result = AVERROR(EOVERFLOW); goto done; }
            int64_t end = origin + previous_pts + (last_duration < 33333 ? 33333 : last_duration);
            while (!stopped) {
                int64_t remaining = end - clock_us();
                if (!paused && remaining <= 0) break;
                if (!commands(paused ? -1 : (int)((remaining + 999) / 1000))) {
                    result = AVERROR_EXIT; goto done;
                }
                end = origin + previous_pts + (last_duration < 33333 ? 33333 : last_duration);
            }
            if (!loop) {
                struct PuVideoMessage ended = {.operation = PU_VIDEO_END};
                result = publish(&ended) ? 0 : AVERROR(EPIPE);
                goto done;
            }
            if ((result = av_seek_frame(format, stream_index, 0, AVSEEK_FLAG_BACKWARD)) < 0) goto done;
            avcodec_flush_buffers(codec);
            draining = false; first_pts = AV_NOPTS_VALUE; previous_pts = -33334; frame_index = 0; loops++;
            origin = clock_us();
            continue;
        }
        if (result < 0) goto done;
        failure = "Decoded frame geometry exceeds the source budget or has invalid timestamps";
        if (frame->width < 1 || frame->height < 1 || frame->width > 1920 || frame->height > 1080 ||
            frame->format < 0) { result = AVERROR_INVALIDDATA; goto done; }
        int64_t pts = frame->best_effort_timestamp == AV_NOPTS_VALUE ? frame_index * fallback_duration :
            av_rescale_q(frame->best_effort_timestamp, stream->time_base, AV_TIME_BASE_Q);
        frame_index++;
        if (first_pts == AV_NOPTS_VALUE) first_pts = pts;
        pts -= first_pts;
        if (pts < 0 || pts > INT64_C(86400000000)) { result = AVERROR_INVALIDDATA; goto done; }
        int64_t duration = frame->duration > 0 ? av_rescale_q(frame->duration, stream->time_base, AV_TIME_BASE_Q) :
            fallback_duration;
        if (duration < 1 || duration > 10000000) { result = AVERROR_INVALIDDATA; goto done; }
        if (pts - previous_pts < 33333) { av_frame_unref(frame); continue; }
        while (!stopped) {
            int64_t remaining = origin + pts - clock_us();
            if (!paused && remaining <= 0) break;
            int delay = paused ? -1 : (int)((remaining + 999) / 1000);
            if (!commands(delay)) { result = AVERROR_EXIT; goto done; }
        }
        double factor = (double)PU_VIDEO_WIDTH / frame->width;
        if ((double)PU_VIDEO_HEIGHT / frame->height < factor) factor = (double)PU_VIDEO_HEIGHT / frame->height;
        if (factor > 1) factor = 1;
        int width = (int)(frame->width * factor), height = (int)(frame->height * factor);
        if (width < 1) width = 1;
        if (height < 1) height = 1;
        scale = sws_getCachedContext(scale, frame->width, frame->height, frame->format,
            width, height, AV_PIX_FMT_BGRA, SWS_BILINEAR, NULL, NULL, NULL);
        if (!scale) { result = AVERROR(ENOMEM); goto done; }
        uint8_t *destination[4] = {pixels, NULL, NULL, NULL};
        int strides[4] = {width * 4, 0, 0, 0};
        if (sws_scale(scale, (const uint8_t * const *)frame->data, frame->linesize, 0, frame->height,
            destination, strides) != height) { result = AVERROR_EXTERNAL; goto done; }
        for (int index = 0; index < width * height; index++) pixels[index * 4 + 3] = 255;
        struct PuVideoMessage message = {.operation = PU_VIDEO_FRAME, .width = (uint32_t)width,
            .height = (uint32_t)height, .stride = (uint32_t)width * 4, .bytes = (uint32_t)width * height * 4,
            .timestamp = pts, .duration = duration, .loop = loops};
        if (!publish(&message)) { result = AVERROR(EPIPE); goto done; }
        waiting = true;
        previous_pts = pts;
        last_duration = duration;
        av_frame_unref(frame);
    }
    result = AVERROR_EXIT;
done:
    if (result < 0 && result != AVERROR_EXIT && !stopped) {
        char detail[96];
        av_strerror(result, detail, sizeof(detail));
        struct PuVideoMessage message = {.operation = PU_VIDEO_ERROR};
        snprintf(message.error, sizeof(message.error), "%s: %.70s", failure, detail);
        publish(&message);
        fprintf(stderr, "[video decoder] %s\n", message.error);
    }
    sws_freeContext(scale);
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&codec);
    avformat_close_input(&format);
    for (unsigned index = 0; index < 16; index++) av_dict_free(&probe_options[index]);
    if (io) av_freep(&io->buffer);
    avio_context_free(&io);
    av_free(buffer);
    return result < 0 && result != AVERROR_EXIT ? 1 : 0;
}
static bool admitted_libraries(void)
{
    const char *license = "LGPL version 2.1 or later";
    if (strcmp(avcodec_license(), license) || strcmp(avformat_license(), license) ||
        strcmp(avutil_license(), license) || strcmp(swscale_license(), license)) {
        fputs("[video decoder] Runtime libraries do not match the admitted LGPL-only closure\n", stderr);
        return false;
    }
    void *iterator = NULL;
    const AVCodec *codec;
    unsigned count = 0;
    while ((codec = av_codec_iterate(&iterator))) {
        if (!av_codec_is_decoder(codec) || (codec->id != AV_CODEC_ID_H264 &&
            codec->id != AV_CODEC_ID_VP8 && codec->id != AV_CODEC_ID_VP9)) return false;
        if (avcodec_get_hw_config(codec, 0)) return false;
        count++;
    }
    if (count != 3) return false;
    iterator = NULL;
    const AVInputFormat *format;
    count = 0;
    while ((format = av_demuxer_iterate(&iterator))) {
        if (strcmp(format->name, "mov,mp4,m4a,3gp,3g2,mj2") && strcmp(format->name, "matroska,webm"))
            return false;
        count++;
    }
    if (count != 2) return false;
    iterator = NULL;
    if (av_muxer_iterate(&iterator)) return false;
    iterator = NULL;
    return avio_enum_protocols(&iterator, 0) == NULL && avio_enum_protocols(&iterator, 1) == NULL;
}
int main(int argc, char **argv)
{
    if (!admitted_libraries()) {
        fputs("[video decoder] Codec/container/protocol inventory differs from the admitted local-only closure\n", stderr);
        return 1;
    }
    if (argc == 2 && !strcmp(argv[1], "--build-info")) {
        printf("{\"schemaVersion\":1,\"ffmpegVersion\":\"%s\",\"license\":\"LGPL-2.1-or-later\","
            "\"network\":false,\"audio\":false,\"decoders\":[\"h264\",\"vp8\",\"vp9\"],"
            "\"demuxers\":[\"mov\",\"matroska\"]}\n", av_version_info());
        return 0;
    }
    if (argc != 1) return 2;
    pid_t parent = getppid();
    if (getuid() == 0 || getuid() != geteuid() || getgid() != getegid()) {
        fputs("[video decoder] Requires the ordinary user, never root/setid\n", stderr);
        return 1;
    }
    struct rlimit memory = {.rlim_cur = 512 * 1024 * 1024, .rlim_max = 512 * 1024 * 1024};
    struct rlimit files = {.rlim_cur = 32, .rlim_max = 32};
    if (setrlimit(RLIMIT_AS, &memory) || setrlimit(RLIMIT_NOFILE, &files) ||
        prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_PDEATHSIG, SIGTERM) ||
        getppid() != parent) {
        fputs("[video decoder] Cannot establish bounded worker lifetime and resource limits\n", stderr);
        return 1;
    }
    struct stat source, shared;
    if (fstat(3, &source) || !S_ISREG(source.st_mode) || source.st_size < 1 ||
        source.st_size > INT64_C(2147483648) || fstat(5, &shared) || shared.st_size != PU_VIDEO_BYTES ||
        (fcntl(5, F_GET_SEALS) & (F_SEAL_GROW | F_SEAL_SHRINK)) != (F_SEAL_GROW | F_SEAL_SHRINK)) {
        fputs("[video decoder] Invalid local-source or sealed-frame descriptors\n", stderr);
        return 1;
    }
    close_range(6, ~0U, 0);
    av_max_alloc(64 * 1024 * 1024);
    struct PuVideoMessage message;
    if (recv(4, &message, sizeof(message), 0) != sizeof(message) ||
        message.magic != PU_VIDEO_MAGIC || message.version != PU_VIDEO_VERSION ||
        message.operation != PU_VIDEO_INIT || message.flags > (PU_VIDEO_INIT_LOOP | PU_VIDEO_INIT_PAUSED)) return 1;
    paused = (message.flags & PU_VIDEO_INIT_PAUSED) != 0;
    struct PuVideoMessage status = {.operation = PU_VIDEO_STATUS, .flags = paused ? 1u : 0u};
    if (!publish(&status)) return 1;
    uint8_t *pixels = mmap(NULL, PU_VIDEO_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, 5, 0);
    if (pixels == MAP_FAILED) return 1;
    int result = decode((message.flags & PU_VIDEO_INIT_LOOP) != 0, pixels);
    munmap(pixels, PU_VIDEO_BYTES);
    return result;
}
