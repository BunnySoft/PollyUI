#define _GNU_SOURCE
#include "audio.h"
#include "windows.h"
#include "shared/thread.h"
#include <pipewire/pipewire.h>
#include <pipewire/extensions/metadata.h>
#include <spa/param/props.h>
#include <spa/param/port-config.h>
#include <spa/pod/builder.h>
#include <spa/pod/iter.h>
#include <spa/utils/json.h>
#include <spa/param/audio/raw.h>
#include <spa/param/audio/format-utils.h>
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <poll.h>
#include <unistd.h>

#define MAX_AUDIO_NODES 256
#define MAX_AUDIO_PORTS 1024
#define MAX_AUDIO_LINKS 1024
struct AudioNode {
    uint32_t id, revision;
    struct pw_node *proxy;
    struct spa_hook listener;
    char name[257], description[513], media_class[64], target[257], serial[32], state[32];
    int priority;
    bool configured, can_configure, has_volume, has_mute, mute, autoconnect;
    float volume;
    float volumes[64];
    uint32_t channels;
    bool format_ready;
    struct spa_audio_info_raw format;
    struct AudioNode *next;
};
struct AudioPort {
    uint32_t id, node;
    bool output, monitor;
    char channel[32];
    struct AudioPort *next;
};
struct AudioLink {
    uint32_t id, output_node, input_node, output_port, input_port;
    bool managed;
    bool removing;
    struct AudioLink *next;
};
struct PendingLink {
    uint32_t output, input;
    uint32_t bound;
    struct pw_proxy *proxy;
    struct spa_hook listener;
    struct PendingLink *next;
};
static struct {
    JSContext *ctx;
    JSValue api;
    struct pw_main_loop *loop;
    struct pw_context *context;
    struct pw_core *core;
    struct pw_registry *registry;
    struct pw_metadata *metadata;
    uint32_t metadata_id;
    struct spa_hook core_listener, registry_listener, metadata_listener;
    struct AudioNode *nodes;
    struct AudioPort *ports;
    struct AudioLink *links;
    struct PendingLink *pending;
    uint32_t revision, sink, source, generation;
    unsigned node_count, port_count, link_count;
    bool initialized, entered, ready, changed, route, failed;
    int sync;
    long long deadline;
    struct { uint32_t output, input; } failures[256];
    unsigned failure_count;
    char default_sink[257], default_source[257], error[256];
} audio;

static void release_pending(struct PendingLink *pending);
static uint32_t advance(uint32_t *value) { if (!++*value) ++*value; return *value; }
static void error(const char *message)
{
    snprintf(audio.error, sizeof(audio.error), "%s", message);
    audio.changed = true;
    fprintf(stderr, "[audio] %s\n", message);
}
static void changed(void)
{ advance(&audio.revision); audio.changed = audio.route = true; }
static bool copy(char *out, size_t capacity, const char *text)
{
    if (!text) text = "";
    if (strlen(text) >= capacity) { error("Audio metadata exceeds supported text limits"); return false; }
    strcpy(out, text); return true;
}
static bool parse_id(const char *text, uint32_t *result)
{
    if (!text || !*text || *text < '0' || *text > '9') return false;
    char *end; errno = 0;
    unsigned long value = strtoul(text, &end, 10);
    if (*end || errno || value > UINT32_MAX) return false;
    *result = (uint32_t)value; return true;
}
static struct AudioNode *find_node(uint32_t id)
{
    for (struct AudioNode *node = audio.nodes; node; node = node->next) if (node->id == id) return node;
    return NULL;
}
static bool sink(const struct AudioNode *node) { return !strcmp(node->media_class, "Audio/Sink"); }
static bool source(const struct AudioNode *node) {
    return !strcmp(node->media_class, "Audio/Source") || !strncmp(node->media_class, "Audio/Source/", 13);
}
static bool playback(const struct AudioNode *node) { return !strcmp(node->media_class, "Stream/Output/Audio"); }
static bool capture(const struct AudioNode *node) { return !strcmp(node->media_class, "Stream/Input/Audio"); }
static uint32_t channel(const char *name)
{
    const char *names[] = { "MONO", "FL", "FR", "FC", "LFE", "RL", "RR", "SL", "SR" };
    const uint32_t values[] = { SPA_AUDIO_CHANNEL_MONO, SPA_AUDIO_CHANNEL_FL, SPA_AUDIO_CHANNEL_FR,
        SPA_AUDIO_CHANNEL_FC, SPA_AUDIO_CHANNEL_LFE, SPA_AUDIO_CHANNEL_RL, SPA_AUDIO_CHANNEL_RR,
        SPA_AUDIO_CHANNEL_SL, SPA_AUDIO_CHANNEL_SR };
    for (size_t i = 0; i < sizeof(values) / sizeof(values[0]); i++) if (!strcmp(name, names[i])) return values[i];
    return SPA_AUDIO_CHANNEL_UNKNOWN;
}
static void configure_ports(struct AudioNode *node, const struct AudioNode *target)
{
    if (!node->format_ready || node->configured) return;
    struct spa_audio_info_raw format = node->format;
    if (target) {
        format.channels = 0;
        for (struct AudioPort *port = audio.ports; port; port = port->next) {
            if (port->node != target->id || port->monitor || port->output != capture(node)) continue;
            if (format.channels >= 64) { error("Audio endpoint channel limit reached"); return; }
            uint32_t position = channel(port->channel);
            if (position == SPA_AUDIO_CHANNEL_UNKNOWN) { error("Audio endpoint requires a supported channel map"); return; }
            format.position[format.channels++] = position;
        }
        if (!format.channels) return;
        format.flags &= ~SPA_AUDIO_FLAG_UNPOSITIONED;
    }
    format.format = SPA_AUDIO_FORMAT_F32P;
    uint8_t buffer[2048];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    struct spa_pod *raw = spa_format_audio_raw_build(&builder, SPA_PARAM_Format, &format);
    struct spa_pod *pod = spa_pod_builder_add_object(&builder, SPA_TYPE_OBJECT_ParamPortConfig, SPA_PARAM_PortConfig,
        SPA_PARAM_PORT_CONFIG_direction, SPA_POD_Id(playback(node) || source(node) ? SPA_DIRECTION_OUTPUT : SPA_DIRECTION_INPUT),
        SPA_PARAM_PORT_CONFIG_mode, SPA_POD_Id(SPA_PARAM_PORT_CONFIG_MODE_dsp),
        SPA_PARAM_PORT_CONFIG_format, SPA_POD_Pod(raw));
    if (!pod || pw_node_set_param(node->proxy, SPA_PARAM_PortConfig, 0, pod) < 0) error("Cannot configure audio ports");
    else node->configured = true;
}
static void node_param(void *data, int seq, uint32_t id, uint32_t index, uint32_t next, const struct spa_pod *param)
{
    (void)seq; (void)index; (void)next;
    struct AudioNode *node = data;
    if (id == SPA_PARAM_EnumFormat && param && !node->configured && node->can_configure) {
        if (SPA_POD_SIZE(param) > 4096) { error("Audio format exceeds supported size"); return; }
        struct spa_pod *fixed = spa_pod_copy(param);
        if (!fixed) { error("Cannot allocate audio format"); return; }
        spa_pod_fixate(fixed);
        struct spa_audio_info_raw format = {0};
        int parsed = spa_format_audio_raw_parse(fixed, &format);
        free(fixed);
        if (parsed < 0 || !format.channels || format.channels > 64) { error("Unsupported stream audio format"); return; }
        if ((format.flags & SPA_AUDIO_FLAG_UNPOSITIONED) || format.position[0] == SPA_AUDIO_CHANNEL_UNKNOWN) {
            if (format.channels > 2) { error("Multichannel audio requires an explicit channel map"); return; }
            format.flags &= ~SPA_AUDIO_FLAG_UNPOSITIONED;
            format.position[0] = format.channels == 1 ? SPA_AUDIO_CHANNEL_MONO : SPA_AUDIO_CHANNEL_FL;
            if (format.channels == 2) format.position[1] = SPA_AUDIO_CHANNEL_FR;
        }
        node->format = format; node->format_ready = true;
        if (source(node) || sink(node)) configure_ports(node, NULL);
        audio.route = true;
        return;
    }
    if (id != SPA_PARAM_Props || !param || !spa_pod_is_object(param)) return;
    const struct spa_pod_prop *prop = spa_pod_find_prop(param, NULL, SPA_PROP_mute);
    if (prop) {
        bool mute;
        if (spa_pod_get_bool(&prop->value, &mute) < 0) { error("Audio node returned an invalid mute value"); return; }
        node->mute = mute; node->has_mute = true;
    }
    prop = spa_pod_find_prop(param, NULL, SPA_PROP_channelVolumes);
    if (prop) {
        if (!spa_pod_is_array(&prop->value) || SPA_POD_ARRAY_VALUE_SIZE(&prop->value) != sizeof(float) ||
            SPA_POD_ARRAY_VALUE_TYPE(&prop->value) != SPA_TYPE_Float ||
            (SPA_POD_BODY_SIZE(&prop->value) - sizeof(struct spa_pod_array_body)) % sizeof(float)) {
            error("Audio node returned invalid channel volumes"); return;
        }
        uint32_t count;
        const float *values = spa_pod_get_array(&prop->value, &count);
        if (!values || count > 64) {
            error("Audio node returned invalid channel volumes"); return;
        }
        float volume = 0;
        for (uint32_t i = 0; i < count; i++) {
            if (!isfinite(values[i]) || values[i] < 0 || values[i] > 10) { error("Audio node volume is out of bounds"); return; }
            if (values[i] > volume) volume = values[i];
        }
        memcpy(node->volumes, values, (size_t)count * sizeof(float));
        node->volume = volume; node->channels = count; node->has_volume = count != 0;
    } else {
        prop = spa_pod_find_prop(param, NULL, SPA_PROP_volume);
        if (prop) {
            float value;
            if (spa_pod_get_float(&prop->value, &value) < 0 || !isfinite(value) || value < 0 || value > 10) {
                error("Audio node returned an invalid volume"); return;
            }
            node->volume = value; node->channels = 0; node->has_volume = true;
        }
    }
    node->revision = advance(&audio.revision); audio.changed = true;
}
static void node_info(void *data, const struct pw_node_info *info)
{
    struct AudioNode *node = data;
    if (info->props && info->props->n_items > 0) {
        const char *description = spa_dict_lookup(info->props, PW_KEY_NODE_DESCRIPTION);
        if (!description) description = spa_dict_lookup(info->props, PW_KEY_NODE_NICK);
        if (description) copy(node->description, sizeof(node->description), description);
        const char *target = spa_dict_lookup(info->props, PW_KEY_TARGET_OBJECT);
        if (target) copy(node->target, sizeof(node->target), target);
        const char *autoconnect = spa_dict_lookup(info->props, PW_KEY_NODE_AUTOCONNECT);
        if (autoconnect) node->autoconnect = !strcmp(autoconnect, "true") || !strcmp(autoconnect, "1");
    }
    copy(node->state, sizeof(node->state), pw_node_state_as_string(info->state));
    bool needs_ports = (playback(node) || source(node)) ? info->n_output_ports == 0 : info->n_input_ports == 0;
    if (!node->configured && needs_ports && (((playback(node) || capture(node)) && node->autoconnect) || sink(node) || source(node))) {
        for (uint32_t i = 0; i < info->n_params; i++) {
            if (info->params[i].id != SPA_PARAM_PortConfig || !(info->params[i].flags & SPA_PARAM_INFO_WRITE)) continue;
            if (!node->can_configure) {
                node->can_configure = true;
                if (pw_node_enum_params(node->proxy, 0, SPA_PARAM_EnumFormat, 0, 1, NULL) < 0)
                    error("Cannot inspect stream audio format");
            }
            break;
        }
    }
    node->revision = advance(&audio.revision);
    audio.changed = audio.route = true;
}
static const struct pw_node_events node_events = { PW_VERSION_NODE_EVENTS, .info = node_info, .param = node_param };
static void core_done(void *data, uint32_t id, int seq)
{ (void)data; (void)id; if (seq == audio.sync) { audio.ready = true; audio.changed = audio.route = true; } }
static void core_error(void *data, uint32_t id, int seq, int result, const char *message)
{
    (void)data; (void)seq; (void)message;
    char text[128];
    snprintf(text, sizeof(text), "PipeWire request failed (%d)", result);
    error(text);
    if (id == PW_ID_CORE) { audio.failed = true; audio.ready = false; }
}
static const struct pw_core_events core_events = { PW_VERSION_CORE_EVENTS, .done = core_done, .error = core_error };
static int metadata_property(void *data, uint32_t subject, const char *key, const char *type, const char *value)
{
    (void)data;
    if (subject != PW_ID_CORE) return 0;
    if (!key) { audio.default_sink[0] = audio.default_source[0] = 0; changed(); return 0; }
    char *name = !strcmp(key, "default.audio.sink") ? audio.default_sink :
        !strcmp(key, "default.audio.source") ? audio.default_source : NULL;
    if (!name) return 0;
    if (!value) { *name = 0; changed(); return 0; }
    if (!type || strcmp(type, "Spa:String:JSON")) { error("Invalid default-audio metadata type"); return 0; }
    struct spa_json iterator, object;
    spa_json_init(&iterator, value, strlen(value));
    if (spa_json_enter_object(&iterator, &object) <= 0) { error("Invalid PipeWire default-node metadata"); return 0; }
    char field[64], parsed[257] = "";
    bool found = false;
    while (spa_json_get_string(&object, field, sizeof(field)) > 0) {
        const char *text; int length = spa_json_next(&object, &text);
        if (length <= 0) break;
        if (!strcmp(field, "name")) {
            if (!spa_json_is_string(text, length) || spa_json_parse_stringn(text, length, parsed, sizeof(parsed)) < 0) {
                error("Invalid PipeWire default-node name"); return 0;
            }
            found = true;
        }
    }
    if (!found || !*parsed) { error("Default audio metadata has no device name"); return 0; }
    copy(name, 257, parsed); changed();
    return 0;
}
static const struct pw_metadata_events metadata_events = { PW_VERSION_METADATA_EVENTS, .property = metadata_property };
static void global(void *data, uint32_t id, uint32_t permissions, const char *type, uint32_t version, const struct spa_dict *props)
{
    (void)data; (void)permissions;
    if (!props || props->n_items == 0) return;
    if (!strcmp(type, PW_TYPE_INTERFACE_Node)) {
        const char *media_class = spa_dict_lookup(props, PW_KEY_MEDIA_CLASS);
        if (!media_class || (strcmp(media_class, "Audio/Sink") && strcmp(media_class, "Audio/Source") &&
            strncmp(media_class, "Audio/Source/", 13) && strcmp(media_class, "Stream/Output/Audio") &&
            strcmp(media_class, "Stream/Input/Audio"))) return;
        if (audio.node_count >= MAX_AUDIO_NODES) { error("Audio node limit reached"); return; }
        struct AudioNode *node = calloc(1, sizeof(*node));
        if (!node) { error("Cannot allocate audio node"); return; }
        node->id = id;
        if (!copy(node->name, sizeof(node->name), spa_dict_lookup(props, PW_KEY_NODE_NAME)) ||
            !copy(node->media_class, sizeof(node->media_class), media_class) ||
            !copy(node->serial, sizeof(node->serial), spa_dict_lookup(props, PW_KEY_OBJECT_SERIAL))) { free(node); return; }
        const char *autoconnect = spa_dict_lookup(props, PW_KEY_NODE_AUTOCONNECT);
        node->autoconnect = autoconnect && (!strcmp(autoconnect, "true") || !strcmp(autoconnect, "1"));
        copy(node->target, sizeof(node->target), spa_dict_lookup(props, PW_KEY_TARGET_OBJECT));
        const char *priority = spa_dict_lookup(props, PW_KEY_PRIORITY_SESSION);
        if (priority) {
            char *end; errno = 0; long value = strtol(priority, &end, 10);
            if (!*priority || *end || errno || value < -1000000 || value > 1000000) { free(node); error("Invalid audio node priority"); return; }
            node->priority = (int)value;
        }
        node->proxy = pw_registry_bind(audio.registry, id, PW_TYPE_INTERFACE_Node, SPA_MIN(version, PW_VERSION_NODE), 0);
        if (!node->proxy) { free(node); error("Cannot bind audio node"); return; }
        node->revision = advance(&audio.revision);
        node->next = audio.nodes; audio.nodes = node; audio.node_count++;
        pw_node_add_listener(node->proxy, &node->listener, &node_events, node);
        uint32_t param = SPA_PARAM_Props;
        pw_node_subscribe_params(node->proxy, &param, 1);
        changed();
    } else if (!strcmp(type, PW_TYPE_INTERFACE_Port)) {
        if (audio.port_count >= MAX_AUDIO_PORTS) { error("Audio port limit reached"); return; }
        const char *direction = spa_dict_lookup(props, PW_KEY_PORT_DIRECTION);
        struct AudioPort *port = calloc(1, sizeof(*port));
        if (!port) { error("Cannot allocate audio port"); return; }
        if (!direction || !parse_id(spa_dict_lookup(props, PW_KEY_NODE_ID), &port->node) ||
            !copy(port->channel, sizeof(port->channel), spa_dict_lookup(props, SPA_KEY_AUDIO_CHANNEL))) { free(port); return; }
        if (strcmp(direction, "in") && strcmp(direction, "out")) { free(port); error("Invalid audio port direction"); return; }
        const char *monitor = spa_dict_lookup(props, PW_KEY_PORT_MONITOR);
        port->id = id; port->output = !strcmp(direction, "out"); port->monitor = monitor && !strcmp(monitor, "true");
        port->next = audio.ports; audio.ports = port; audio.port_count++; changed();
    } else if (!strcmp(type, PW_TYPE_INTERFACE_Link)) {
        if (audio.link_count >= MAX_AUDIO_LINKS) { error("Audio link limit reached"); return; }
        struct AudioLink *link = calloc(1, sizeof(*link));
        if (!link) { error("Cannot allocate audio link"); return; }
        if (!parse_id(spa_dict_lookup(props, PW_KEY_LINK_OUTPUT_NODE), &link->output_node) ||
            !parse_id(spa_dict_lookup(props, PW_KEY_LINK_INPUT_NODE), &link->input_node) ||
            !parse_id(spa_dict_lookup(props, PW_KEY_LINK_OUTPUT_PORT), &link->output_port) ||
            !parse_id(spa_dict_lookup(props, PW_KEY_LINK_INPUT_PORT), &link->input_port)) { free(link); error("Invalid audio link metadata"); return; }
        const char *managed = spa_dict_lookup(props, PW_KEY_OBJECT_PATH);
        unsigned out, in; int length = 0;
        link->managed = managed && sscanf(managed, "polly.route:%u:%u%n", &out, &in, &length) == 2 &&
            managed[length] == 0 && out == link->output_port && in == link->input_port;
        link->id = id;
        link->next = audio.links; audio.links = link; audio.link_count++; changed();
        for (struct PendingLink *pending = audio.pending, *next; pending; pending = next) {
            next = pending->next;
            if (pending->bound == id) release_pending(pending);
        }
    } else if (!strcmp(type, PW_TYPE_INTERFACE_Metadata) && !audio.metadata) {
        const char *name = spa_dict_lookup(props, PW_KEY_METADATA_NAME);
        if (!name || strcmp(name, "default")) return;
        audio.metadata = pw_registry_bind(audio.registry, id, PW_TYPE_INTERFACE_Metadata, SPA_MIN(version, PW_VERSION_METADATA), 0);
        if (!audio.metadata) { error("Cannot bind default audio metadata"); return; }
        audio.metadata_id = id;
        pw_metadata_add_listener(audio.metadata, &audio.metadata_listener, &metadata_events, NULL);
        changed();
    }
}
static void global_remove(void *data, uint32_t id)
{
    (void)data;
    struct AudioNode **node = &audio.nodes;
    while (*node) {
        if ((*node)->id == id) {
            struct AudioNode *old = *node; *node = old->next;
            spa_hook_remove(&old->listener); pw_proxy_destroy((struct pw_proxy *)old->proxy); free(old); audio.node_count--;
            break;
        }
        node = &(*node)->next;
    }
    struct AudioPort **port = &audio.ports;
    while (*port) {
        if ((*port)->id == id) { struct AudioPort *old = *port; *port = old->next; free(old); audio.port_count--; break; }
        port = &(*port)->next;
    }
    struct AudioLink **link = &audio.links;
    while (*link) {
        if ((*link)->id == id) { struct AudioLink *old = *link; *link = old->next; free(old); audio.link_count--; break; }
        link = &(*link)->next;
    }
    if (audio.metadata && audio.metadata_id == id) {
        spa_hook_remove(&audio.metadata_listener); pw_proxy_destroy((struct pw_proxy *)audio.metadata); audio.metadata = NULL;
    }
    for (unsigned i = 0; i < audio.failure_count;)
        if (audio.failures[i].output == id || audio.failures[i].input == id)
            audio.failures[i] = audio.failures[--audio.failure_count];
        else i++;
    changed();
}
static const struct pw_registry_events registry_events = { PW_VERSION_REGISTRY_EVENTS, .global = global, .global_remove = global_remove };

static void release_pending(struct PendingLink *pending)
{
    struct PendingLink **slot = &audio.pending;
    while (*slot && *slot != pending) slot = &(*slot)->next;
    if (*slot) *slot = pending->next;
    spa_hook_remove(&pending->listener);
    pw_proxy_destroy(pending->proxy);
    free(pending);
}
static void link_bound(void *data, uint32_t id)
{
    struct PendingLink *pending = data;
    pending->bound = id;
    for (struct AudioLink *link = audio.links; link; link = link->next)
        if (link->id == id) { release_pending(pending); break; }
}
static void link_removed(void *data)
{ release_pending(data); }
static void link_error(void *data, int seq, int result, const char *message)
{
    (void)seq; (void)message;
    struct PendingLink *pending = data;
    if (audio.failure_count < 256) {
        audio.failures[audio.failure_count].output = pending->output;
        audio.failures[audio.failure_count++].input = pending->input;
    }
    char text[128]; snprintf(text, sizeof(text), "Audio route failed (%d)", result);
    error(text);
    release_pending(pending);
}
static const struct pw_proxy_events link_events = {
    PW_VERSION_PROXY_EVENTS, .bound = link_bound, .removed = link_removed, .error = link_error,
};
static struct AudioNode *default_node(bool input)
{
    struct AudioNode *best = NULL;
    const char *wanted = input ? audio.default_source : audio.default_sink;
    for (struct AudioNode *node = audio.nodes; node; node = node->next) {
        if (input ? !source(node) : !sink(node)) continue;
        if (*wanted && !strcmp(wanted, node->name)) return node;
        if (!best || node->priority > best->priority || (node->priority == best->priority && node->id < best->id)) best = node;
    }
    return best;
}
static struct AudioNode *target_node(struct AudioNode *stream)
{
    bool input = capture(stream);
    if ((!input && !playback(stream)) || !stream->autoconnect) return NULL;
    for (struct AudioLink *link = audio.links; link; link = link->next)
        if (!link->managed && (input ? link->input_node == stream->id : link->output_node == stream->id)) return NULL;
    if (*stream->target) {
        for (struct AudioNode *node = audio.nodes; node; node = node->next)
            if ((input ? source(node) : sink(node)) &&
                (!strcmp(node->name, stream->target) || !strcmp(node->serial, stream->target))) return node;
        return NULL;
    }
    return find_node(input ? audio.source : audio.sink);
}
static bool linked(uint32_t output, uint32_t input)
{
    for (struct AudioLink *link = audio.links; link; link = link->next)
        if (link->output_port == output && link->input_port == input) return true;
    for (struct PendingLink *pending = audio.pending; pending; pending = pending->next)
        if (pending->output == output && pending->input == input) return true;
    for (unsigned i = 0; i < audio.failure_count; i++)
        if (audio.failures[i].output == output && audio.failures[i].input == input) return true;
    return false;
}
static void create_link(struct AudioPort *output, struct AudioPort *input)
{
    if (linked(output->id, input->id)) return;
    unsigned count = 0;
    for (struct PendingLink *pending = audio.pending; pending; pending = pending->next) count++;
    if (count >= 256) { error("Audio route request limit reached"); return; }
    struct PendingLink *pending = calloc(1, sizeof(*pending));
    struct pw_properties *props = pw_properties_new(NULL, NULL);
    if (!pending || !props) { free(pending); if (props) pw_properties_free(props); error("Cannot allocate audio route"); return; }
    pw_properties_setf(props, PW_KEY_LINK_OUTPUT_NODE, "%u", output->node);
    pw_properties_setf(props, PW_KEY_LINK_OUTPUT_PORT, "%u", output->id);
    pw_properties_setf(props, PW_KEY_LINK_INPUT_NODE, "%u", input->node);
    pw_properties_setf(props, PW_KEY_LINK_INPUT_PORT, "%u", input->id);
    pw_properties_setf(props, PW_KEY_OBJECT_PATH, "polly.route:%u:%u", output->id, input->id);
    pw_properties_set(props, PW_KEY_OBJECT_LINGER, "true");
    pending->proxy = pw_core_create_object(audio.core, "link-factory", PW_TYPE_INTERFACE_Link, PW_VERSION_LINK, &props->dict, 0);
    pw_properties_free(props);
    if (!pending->proxy) { free(pending); error("Cannot create audio route"); return; }
    pending->output = output->id; pending->input = input->id;
    pending->bound = PW_ID_ANY;
    pending->next = audio.pending; audio.pending = pending;
    pw_proxy_add_listener(pending->proxy, &pending->listener, &link_events, pending);
}
static void route(void)
{
    if (!audio.ready || audio.failed) return;
    struct AudioNode *sink_node = default_node(false), *source_node = default_node(true);
    uint32_t output = sink_node ? sink_node->id : PW_ID_ANY, input = source_node ? source_node->id : PW_ID_ANY;
    if (output != audio.sink || input != audio.source) {
        audio.sink = output; audio.source = input; advance(&audio.revision); audio.changed = true;
    }
    for (struct AudioLink *link = audio.links; link; link = link->next) {
        if (!link->managed || link->removing) continue;
        struct AudioNode *out = find_node(link->output_node), *in = find_node(link->input_node);
        if (!out || !in) { link->removing = true; continue; }
        struct AudioNode *stream = out && playback(out) ? out : in && capture(in) ? in : NULL;
        struct AudioNode *target = stream ? target_node(stream) : NULL;
        if (!stream || !target || (playback(stream) ? target->id != link->input_node : target->id != link->output_node)) {
            link->removing = true;
            if (pw_registry_destroy(audio.registry, link->id) < 0) error("Cannot remove obsolete audio route");
        }
    }
    for (struct AudioNode *stream = audio.nodes; stream; stream = stream->next) {
        struct AudioNode *target = target_node(stream);
        if (!target) continue;
        configure_ports(stream, target);
        uint32_t output_node = playback(stream) ? stream->id : target->id;
        uint32_t input_node = playback(stream) ? target->id : stream->id;
        for (struct AudioPort *out = audio.ports; out; out = out->next) {
            if (!out->output || out->monitor || out->node != output_node) continue;
            for (struct AudioPort *in = audio.ports; in; in = in->next) {
                if (in->output || in->monitor || in->node != input_node) continue;
                if (!strcmp(out->channel, in->channel) && *out->channel) create_link(out, in);
            }
        }
    }
}
static void stop(void)
{
    while (audio.pending) release_pending(audio.pending);
    while (audio.nodes) {
        struct AudioNode *node = audio.nodes; audio.nodes = node->next;
        spa_hook_remove(&node->listener); pw_proxy_destroy((struct pw_proxy *)node->proxy); free(node);
    }
    while (audio.ports) { struct AudioPort *next = audio.ports->next; free(audio.ports); audio.ports = next; }
    while (audio.links) { struct AudioLink *next = audio.links->next; free(audio.links); audio.links = next; }
    if (audio.metadata) {
        spa_hook_remove(&audio.metadata_listener); pw_proxy_destroy((struct pw_proxy *)audio.metadata); audio.metadata = NULL;
    }
    if (audio.registry) {
        spa_hook_remove(&audio.registry_listener); pw_proxy_destroy((struct pw_proxy *)audio.registry); audio.registry = NULL;
    }
    if (audio.core) { spa_hook_remove(&audio.core_listener); pw_core_disconnect(audio.core); audio.core = NULL; }
    if (audio.context) { pw_context_destroy(audio.context); audio.context = NULL; }
    if (audio.loop) {
        if (audio.entered) pw_loop_leave(pw_main_loop_get_loop(audio.loop));
        pw_main_loop_destroy(audio.loop); audio.loop = NULL;
    }
    if (audio.initialized) pw_deinit();
    audio.initialized = audio.entered = audio.ready = audio.failed = false;
    audio.node_count = audio.port_count = audio.link_count = audio.failure_count = 0;
    audio.default_sink[0] = audio.default_source[0] = 0;
    audio.sink = audio.source = PW_ID_ANY;
    changed();
}
static int private_audio(void)
{
    const char *runtime = getenv("XDG_RUNTIME_DIR"), *remote = getenv("PIPEWIRE_REMOTE"), *owned = getenv("POLLY_AUDIO_REMOTE");
    struct stat info;
    if (!runtime || runtime[0] != '/' || !remote || !owned || strcmp(remote, "polly-audio") || strcmp(remote, owned) ||
        lstat(runtime, &info) || !S_ISDIR(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 0777) != 0700)
        return -1;
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    int length = snprintf(address.sun_path, sizeof(address.sun_path), "%s/%s", runtime, remote);
    if (length <= 0 || length >= (int)sizeof(address.sun_path) || lstat(address.sun_path, &info) ||
        !S_ISSOCK(info.st_mode) || info.st_uid != getuid()) return -1;
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) return -1;
    int connected = connect(fd, (struct sockaddr *)&address, sizeof(address));
    if (connected < 0 && errno == EINPROGRESS) {
        struct pollfd wait = { .fd = fd, .events = POLLOUT };
        int result;
        long long deadline = pu_now_ms() + 500;
        do {
            long long remaining = deadline - pu_now_ms();
            result = remaining > 0 ? poll(&wait, 1, (int)remaining) : 0;
        } while (result < 0 && errno == EINTR);
        int failure = 0; socklen_t size = sizeof(failure);
        connected = result > 0 && !getsockopt(fd, SOL_SOCKET, SO_ERROR, &failure, &size) && !failure ? 0 : -1;
    }
    struct ucred credentials;
    socklen_t size = sizeof(credentials);
    if (connected < 0 || getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &size) ||
        credentials.uid != getuid()) { close(fd); return -1; }
    return fd;
}
static JSValue start(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    if (!pu_desktop_windows_ready(ctx)) return JS_EXCEPTION;
    if (audio.core && !audio.failed) return JS_UNDEFINED;
    stop();
    advance(&audio.generation);
    int fd = private_audio();
    if (fd < 0) return JS_ThrowTypeError(ctx, "Audio requires this desktop's private PipeWire session (--audio)");
    audio.error[0] = 0;
    pw_init(NULL, NULL); audio.initialized = true;
    audio.loop = pw_main_loop_new(NULL);
    if (!audio.loop) { close(fd); goto failed; }
    pw_loop_enter(pw_main_loop_get_loop(audio.loop)); audio.entered = true;
    audio.context = pw_context_new(pw_main_loop_get_loop(audio.loop), NULL, 0);
    if (!audio.context) { close(fd); goto failed; }
    audio.core = pw_context_connect_fd(audio.context, fd, pw_properties_new(PW_KEY_REMOTE_NAME, "polly-audio",
        PW_KEY_APP_NAME, "Polly audio policy", NULL), 0);
    if (!audio.core) goto failed;
    pw_core_add_listener(audio.core, &audio.core_listener, &core_events, NULL);
    audio.registry = pw_core_get_registry(audio.core, PW_VERSION_REGISTRY, 0);
    if (!audio.registry) goto failed;
    pw_registry_add_listener(audio.registry, &audio.registry_listener, &registry_events, NULL);
    audio.sync = pw_core_sync(audio.core, PW_ID_CORE, 0);
    audio.deadline = pu_now_ms() + 5000;
    return JS_UNDEFINED;
failed:
    stop(); return JS_ThrowInternalError(ctx, "Cannot initialize the private PipeWire client");
}
static JSValue stop_audio(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{ (void)ctx; (void)self; (void)argc; (void)argv; stop(); return JS_UNDEFINED; }
static JSValue snapshot(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self; (void)argc; (void)argv;
    JSValue result = JS_NewObject(ctx), nodes = JS_NewArray(ctx), links = JS_NewArray(ctx);
    if (JS_IsException(result) || JS_IsException(nodes) || JS_IsException(links)) {
        JS_FreeValue(ctx, result); JS_FreeValue(ctx, nodes); JS_FreeValue(ctx, links); return JS_EXCEPTION;
    }
    JS_SetPropertyStr(ctx, result, "ready", JS_NewBool(ctx, audio.ready && !audio.failed));
    JS_SetPropertyStr(ctx, result, "revision", JS_NewUint32(ctx, audio.revision));
    JS_SetPropertyStr(ctx, result, "generation", JS_NewUint32(ctx, audio.generation));
    JS_SetPropertyStr(ctx, result, "error", JS_NewString(ctx, audio.error));
    JS_SetPropertyStr(ctx, result, "defaultSink", audio.sink == PW_ID_ANY ? JS_NULL : JS_NewUint32(ctx, audio.sink));
    JS_SetPropertyStr(ctx, result, "defaultSource", audio.source == PW_ID_ANY ? JS_NULL : JS_NewUint32(ctx, audio.source));
    JS_SetPropertyStr(ctx, result, "preferredSink", JS_NewString(ctx, audio.default_sink));
    JS_SetPropertyStr(ctx, result, "preferredSource", JS_NewString(ctx, audio.default_source));
    uint32_t index = 0, managed = 0;
    for (struct AudioLink *link = audio.links; link && !JS_HasException(ctx); link = link->next) if (link->managed) {
        JSValue item = JS_NewObject(ctx);
        if (JS_IsException(item)) break;
        JS_SetPropertyStr(ctx, item, "outputNode", JS_NewUint32(ctx, link->output_node));
        JS_SetPropertyStr(ctx, item, "inputNode", JS_NewUint32(ctx, link->input_node));
        JS_SetPropertyStr(ctx, item, "outputPort", JS_NewUint32(ctx, link->output_port));
        JS_SetPropertyStr(ctx, item, "inputPort", JS_NewUint32(ctx, link->input_port));
        JS_SetPropertyUint32(ctx, links, managed++, item);
    }
    JS_SetPropertyStr(ctx, result, "routes", JS_NewUint32(ctx, managed));
    JS_SetPropertyStr(ctx, result, "connections", links);
    for (struct AudioNode *node = audio.nodes; node && !JS_HasException(ctx); node = node->next) {
        JSValue item = JS_NewObject(ctx);
        if (JS_IsException(item)) break;
        JS_SetPropertyStr(ctx, item, "id", JS_NewUint32(ctx, node->id));
        JS_SetPropertyStr(ctx, item, "revision", JS_NewUint32(ctx, node->revision));
        JS_SetPropertyStr(ctx, item, "instance", JS_NewString(ctx, node->serial));
        JS_SetPropertyStr(ctx, item, "name", JS_NewString(ctx, node->name));
        JS_SetPropertyStr(ctx, item, "description", JS_NewString(ctx, *node->description ? node->description : node->name));
        JS_SetPropertyStr(ctx, item, "class", JS_NewString(ctx, node->media_class));
        JS_SetPropertyStr(ctx, item, "state", JS_NewString(ctx, node->state));
        JS_SetPropertyStr(ctx, item, "volume", node->has_volume ? JS_NewFloat64(ctx, node->volume) : JS_NULL);
        JS_SetPropertyStr(ctx, item, "muted", node->has_mute ? JS_NewBool(ctx, node->mute) : JS_NULL);
        JS_SetPropertyUint32(ctx, nodes, index++, item);
    }
    JS_SetPropertyStr(ctx, result, "nodes", nodes);
    if (JS_HasException(ctx)) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
    return result;
}
static struct AudioNode *argument_node(JSContext *ctx, int argc, JSValueConst *argv)
{
    if (!audio.ready || audio.failed) { JS_ThrowTypeError(ctx, "Audio service is not ready"); return NULL; }
    uint32_t id, revision;
    double number, generation;
    if (argc < 2 || !JS_IsNumber(argv[0]) || !JS_IsNumber(argv[1]) ||
        JS_ToFloat64(ctx, &number, argv[0]) < 0 || JS_ToFloat64(ctx, &generation, argv[1]) < 0 ||
        !isfinite(number) || !isfinite(generation) || number < 0 || number >= UINT32_MAX || floor(number) != number ||
        generation < 1 || generation > UINT32_MAX || floor(generation) != generation) {
        JS_ThrowTypeError(ctx, "Audio operation requires node ID and revision"); return NULL;
    }
    id = (uint32_t)number; revision = (uint32_t)generation;
    struct AudioNode *node = find_node(id);
    if (!node || node->revision != revision) { JS_ThrowTypeError(ctx, "Stale audio node"); return NULL; }
    return node;
}
static JSValue set_control(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int mute)
{
    (void)self;
    struct AudioNode *node = argument_node(ctx, argc, argv);
    if (!node) return JS_EXCEPTION;
    if (argc != 3) return JS_ThrowTypeError(ctx, "Audio control requires a value");
    uint8_t buffer[512];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    struct spa_pod *pod;
    if (mute) {
        if (!node->has_mute || !JS_IsBool(argv[2])) return JS_ThrowTypeError(ctx, "Mute requires a supported node and boolean");
        pod = spa_pod_builder_add_object(&builder, SPA_TYPE_OBJECT_Props, SPA_PARAM_Props, SPA_PROP_mute, SPA_POD_Bool(JS_ToBool(ctx, argv[2])));
    } else {
        double volume;
        if (!node->has_volume || !JS_IsNumber(argv[2]) || JS_ToFloat64(ctx, &volume, argv[2]) < 0 ||
            !isfinite(volume) || volume < 0 || volume > 1)
            return JS_ThrowTypeError(ctx, "Volume must be between zero and one on a supported node");
        if (node->channels) {
            float values[64];
            for (uint32_t i = 0; i < node->channels; i++)
                values[i] = node->volume > 0 ? node->volumes[i] * (float)volume / node->volume : (float)volume;
            pod = spa_pod_builder_add_object(&builder, SPA_TYPE_OBJECT_Props, SPA_PARAM_Props, SPA_PROP_channelVolumes,
                SPA_POD_Array(sizeof(float), SPA_TYPE_Float, node->channels, values));
        } else pod = spa_pod_builder_add_object(&builder, SPA_TYPE_OBJECT_Props, SPA_PARAM_Props, SPA_PROP_volume, SPA_POD_Float((float)volume));
    }
    if (!pod || pw_node_set_param(node->proxy, SPA_PARAM_Props, 0, pod) < 0)
        return JS_ThrowInternalError(ctx, "Cannot send audio control");
    audio.error[0] = 0;
    return JS_UNDEFINED;
}
static JSValue set_default(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
    (void)self;
    struct AudioNode *node = argument_node(ctx, argc, argv);
    if (!node) return JS_EXCEPTION;
    if (argc != 2 || (!sink(node) && !source(node)) || !audio.metadata || !*node->name)
        return JS_ThrowTypeError(ctx, "Default audio device requires a named sink or source");
    char encoded[1600], value[1700];
    if (spa_json_encode_string(encoded, sizeof(encoded), node->name) < 0)
        return JS_ThrowInternalError(ctx, "Cannot encode audio device name");
    snprintf(value, sizeof(value), "{\"name\":%s}", encoded);
    if (pw_metadata_set_property(audio.metadata, PW_ID_CORE, sink(node) ? "default.audio.sink" : "default.audio.source",
        "Spa:String:JSON", value) < 0) return JS_ThrowInternalError(ctx, "Cannot select default audio device");
    audio.failure_count = 0; audio.error[0] = 0; audio.route = true;
    return JS_UNDEFINED;
}
int pu_audio_install(JSContext *ctx, JSValueConst api)
{
    audio.ctx = ctx; audio.api = JS_DupValue(ctx, api); audio.sink = audio.source = PW_ID_ANY;
    const char *remote = getenv("POLLY_AUDIO_REMOTE");
    return JS_SetPropertyStr(ctx, api, "audioAvailable", JS_NewBool(ctx, remote && !strcmp(remote, "polly-audio"))) >= 0 &&
        JS_SetPropertyStr(ctx, api, "startAudio", JS_NewCFunction(ctx, start, "startAudio", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "stopAudio", JS_NewCFunction(ctx, stop_audio, "stopAudio", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "audioState", JS_NewCFunction(ctx, snapshot, "audioState", 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "setAudioVolume", JS_NewCFunctionMagic(ctx, set_control, "setAudioVolume", 3, JS_CFUNC_generic_magic, 0)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "setAudioMute", JS_NewCFunctionMagic(ctx, set_control, "setAudioMute", 3, JS_CFUNC_generic_magic, 1)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "setDefaultAudio", JS_NewCFunction(ctx, set_default, "setDefaultAudio", 2)) >= 0 &&
        JS_SetPropertyStr(ctx, api, "onAudioChanged", JS_NULL) >= 0;
}
int pu_audio_pump(void)
{
    if (!audio.loop) return 0;
    if (!audio.failed) {
        if (pw_loop_iterate(pw_main_loop_get_loop(audio.loop), 0) < 0) { audio.failed = true; error("PipeWire event loop failed"); }
        if (!audio.ready && pu_now_ms() >= audio.deadline) { audio.failed = true; error("PipeWire discovery timed out"); }
        if (audio.route) { audio.route = false; route(); }
    }
    if (!audio.changed) return 0;
    audio.changed = false;
    JSContext *ctx = audio.ctx;
    JSValue callback = JS_GetPropertyStr(ctx, audio.api, "onAudioChanged"), result = JS_UNDEFINED;
    if (JS_IsException(callback)) result = JS_EXCEPTION;
    else if (JS_IsFunction(ctx, callback)) result = JS_Call(ctx, callback, audio.api, 0, NULL);
    else if (!JS_IsNull(callback) && !JS_IsUndefined(callback)) result = JS_ThrowTypeError(ctx, "Audio callback must be a function");
    JS_FreeValue(ctx, callback);
    if (JS_IsException(result)) {
        JSValue failure = JS_GetException(ctx); const char *message = JS_ToCString(ctx, failure);
        fprintf(stderr, "[audio] Callback failed: %s\n", message ? message : "unknown");
        JS_FreeCString(ctx, message); JS_FreeValue(ctx, failure);
    } else JS_FreeValue(ctx, result);
    return 1;
}
void pu_audio_shutdown(void)
{
    stop();
    if (audio.ctx) JS_FreeValue(audio.ctx, audio.api);
    memset(&audio, 0, sizeof(audio));
}
