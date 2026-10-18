#include <yoga/Yoga.h>
#include <yoga/algorithm/PixelGridBackend.h>
#include <cmath>
#include <cstdio>
#include <cstring>

struct Box {
    float left, top, width, height;
};

static bool close(float actual, float expected)
{
    return std::fabs(actual - expected) < 0.0001f;
}

static void readBoxes(YGNodeRef nodes[4], Box boxes[4])
{
    float x = 0, y = 0;
    for (int i = 0; i < 4; i++) {
        x += YGNodeLayoutGetLeft(nodes[i]); y += YGNodeLayoutGetTop(nodes[i]);
        boxes[i] = {x, y, YGNodeLayoutGetWidth(nodes[i]), YGNodeLayoutGetHeight(nodes[i])};
    }
}

static bool same(const Box actual[4], const Box expected[4])
{
    for (int i = 0; i < 4; i++)
        if (!close(actual[i].left, expected[i].left) || !close(actual[i].top, expected[i].top) ||
            !close(actual[i].width, expected[i].width) || !close(actual[i].height, expected[i].height))
            return false;
    return true;
}

static bool check(const float scales[4], bool textParent, float shift, Box result[4], bool cache,
    float leafSize = 5.4f)
{
    YGConfigRef configs[4];
    YGNodeRef nodes[4];
    const float starts[4] = {0, 13.4f + shift, 7.6f, 5.4f};
    const float sizes[4] = {300, 100.4f, 20.6f, leafSize};
    for (int i = 0; i < 4; i++) {
        configs[i] = YGConfigNew();
        YGConfigSetPointScaleFactor(configs[i], 0);
        nodes[i] = YGNodeNewWithConfig(configs[i]);
        YGNodeStyleSetWidth(nodes[i], sizes[i]);
        YGNodeStyleSetHeight(nodes[i], sizes[i]);
        YGNodeStyleSetPositionType(nodes[i], YGPositionTypeAbsolute);
        YGNodeStyleSetPosition(nodes[i], YGEdgeLeft, starts[i]);
        YGNodeStyleSetPosition(nodes[i], YGEdgeTop, starts[i]);
        if (i) YGNodeInsertChild(nodes[i - 1], nodes[i], 0);
    }
    if (textParent) YGNodeSetNodeType(nodes[1], YGNodeTypeText);
    YGNodeCalculateLayout(nodes[0], 300, 300, YGDirectionLTR);
    Box raw[4];
    for (int i = 0; i < 4; i++)
        raw[i] = {YGNodeLayoutGetLeft(nodes[i]), YGNodeLayoutGetTop(nodes[i]),
            YGNodeLayoutGetWidth(nodes[i]), YGNodeLayoutGetHeight(nodes[i])};
    for (int i = 0; i < 4; i++) YGConfigSetPointScaleFactor(configs[i], scales[i]);
    YGNodeStyleSetWidth(nodes[0], 301);
    YGNodeStyleSetWidth(nodes[0], 300);
    YGNodeCalculateLayout(nodes[0], 300, 300, YGDirectionLTR);
    float rawLeft = 0, rawTop = 0, actualLeft = 0, actualTop = 0;
    bool passed = true;
    for (int i = 0; i < 4; i++) {
        rawLeft += raw[i].left; rawTop += raw[i].top;
        bool text = textParent && i == 1;
        float expectedLeft = scales[i] == 0 ? actualLeft + raw[i].left :
            YGRoundValueToPixelGrid(rawLeft, scales[i], false, text);
        float expectedTop = scales[i] == 0 ? actualTop + raw[i].top :
            YGRoundValueToPixelGrid(rawTop, scales[i], false, text);
        actualLeft += YGNodeLayoutGetLeft(nodes[i]);
        actualTop += YGNodeLayoutGetTop(nodes[i]);
        if (!close(actualLeft, expectedLeft) || !close(actualTop, expectedTop)) {
            std::fprintf(stderr, "FAIL: scales=%g,%g,%g textParent=%d node=%d actual=%g,%g expected=%g,%g\n",
                scales[0], scales[1], scales[2], textParent, i,
                actualLeft, actualTop, expectedLeft, expectedTop);
            passed = false;
        }
        bool fractionalWidth = std::fmod(raw[i].width * scales[i], 1) > 0.0001f;
        bool fractionalHeight = std::fmod(raw[i].height * scales[i], 1) > 0.0001f;
        float expectedWidth = scales[i] == 0 ? raw[i].width :
            YGRoundValueToPixelGrid(rawLeft + raw[i].width, scales[i], text && fractionalWidth,
                text && !fractionalWidth) - YGRoundValueToPixelGrid(rawLeft, scales[i], false, text);
        float expectedHeight = scales[i] == 0 ? raw[i].height :
            YGRoundValueToPixelGrid(rawTop + raw[i].height, scales[i], text && fractionalHeight,
                text && !fractionalHeight) - YGRoundValueToPixelGrid(rawTop, scales[i], false, text);
        if (!close(YGNodeLayoutGetWidth(nodes[i]), expectedWidth) ||
            !close(YGNodeLayoutGetHeight(nodes[i]), expectedHeight)) {
            std::fprintf(stderr, "FAIL: existing dimension rounding changed at node %d\n", i);
            passed = false;
        }
    }
    readBoxes(nodes, result);
    if (cache) {
        Box repeated[4], changed[4], fresh[4];
        for (int repeat = 0; repeat < 3; repeat++) {
            YGNodeCalculateLayout(nodes[0], 300, 300, YGDirectionLTR);
            readBoxes(nodes, repeated);
            if (!same(repeated, result)) {
                std::fputs("FAIL: repeated cached layout drifted\n", stderr);
                passed = false;
            }
        }
        YGNodeStyleSetPosition(nodes[1], YGEdgeLeft, 13.4f + shift + 0.2f);
        YGNodeStyleSetPosition(nodes[1], YGEdgeTop, 13.4f + shift + 0.2f);
        YGNodeCalculateLayout(nodes[0], 300, 300, YGDirectionLTR);
        readBoxes(nodes, changed);
        if (!check(scales, textParent, shift + 0.2f, fresh, false) || !same(changed, fresh)) {
            std::fprintf(stderr, "FAIL: ancestor-only fractional move differs from fresh layout: C=%g,%g fresh=%g,%g scales=%g,%g,%g,%g textParent=%d\n",
                changed[3].left, changed[3].top, fresh[3].left, fresh[3].top,
                scales[0], scales[1], scales[2], scales[3], textParent);
            passed = false;
        }
        if (passed && !textParent && scales[0] == 1 && scales[1] == 1 && scales[2] == 1 && scales[3] == 1)
            std::printf("PASS: four-layer ancestor move C=%g,%g fresh=%g,%g\n",
                changed[3].left, changed[3].top, fresh[3].left, fresh[3].top);
        YGNodeRef cloned[4] = {YGNodeClone(nodes[0]), nullptr, nullptr, nullptr};
        YGNodeCalculateLayout(cloned[0], 300, 300, YGDirectionLTR);
        for (int i = 1; i < 4; i++) cloned[i] = YGNodeGetChild(cloned[i - 1], 0);
        readBoxes(cloned, repeated);
        if (!same(repeated, fresh)) {
            std::fputs("FAIL: cloned cached layout lost raw geometry\n", stderr);
            passed = false;
        }
        YGNodeFreeRecursive(cloned[0]);
        readBoxes(nodes, repeated);
        if (!same(repeated, changed)) {
            std::fputs("FAIL: cloned layout changed its source tree\n", stderr);
            passed = false;
        }
        YGNodeStyleSetDisplay(nodes[2], YGDisplayNone);
        YGNodeCalculateLayout(nodes[0], 300, 300, YGDirectionLTR);
        if (YGNodeLayoutGetWidth(nodes[2]) != 0 || YGNodeLayoutGetHeight(nodes[3]) != 0) {
            std::fputs("FAIL: raw snapshot overwrote display:none\n", stderr);
            passed = false;
        }
        YGNodeStyleSetDisplay(nodes[2], YGDisplayFlex);
        YGNodeCalculateLayout(nodes[0], 300, 300, YGDirectionLTR);
        readBoxes(nodes, repeated);
        if (!same(repeated, fresh)) {
            std::fputs("FAIL: restored display differs from fresh layout\n", stderr);
            passed = false;
        }
        YGNodeStyleSetWidth(nodes[3], 6.6f);
        YGNodeStyleSetHeight(nodes[3], 6.6f);
        YGNodeCalculateLayout(nodes[0], 300, 300, YGDirectionLTR);
        readBoxes(nodes, repeated);
        if (!check(scales, textParent, shift + 0.2f, fresh, false, 6.6f) || !same(repeated, fresh)) {
            std::fputs("FAIL: raw snapshot overwrote dirty dimensions\n", stderr);
            passed = false;
        }
        YGNodeRemoveChild(nodes[2], nodes[3]);
        YGNodeReset(nodes[3]);
        YGNodeStyleSetPositionType(nodes[3], YGPositionTypeAbsolute);
        YGNodeStyleSetPosition(nodes[3], YGEdgeLeft, 5.4f);
        YGNodeStyleSetPosition(nodes[3], YGEdgeTop, 5.4f);
        YGNodeStyleSetWidth(nodes[3], 5.4f);
        YGNodeStyleSetHeight(nodes[3], 5.4f);
        YGNodeInsertChild(nodes[2], nodes[3], 0);
        YGNodeCalculateLayout(nodes[0], 300, 300, YGDirectionLTR);
        readBoxes(nodes, repeated);
        if (!check(scales, textParent, shift + 0.2f, fresh, false) || !same(repeated, fresh)) {
            std::fputs("FAIL: reset reused stale raw dimensions or positions\n", stderr);
            passed = false;
        }
        const float unrounded[4] = {0, 0, 0, 0};
        for (YGConfigRef config : configs) YGConfigSetPointScaleFactor(config, 0);
        YGNodeCalculateLayout(nodes[0], 300, 300, YGDirectionLTR);
        readBoxes(nodes, repeated);
        if (!check(unrounded, textParent, shift + 0.2f, fresh, false) || !same(repeated, fresh)) {
            std::fputs("FAIL: scale zero retained rounded geometry\n", stderr);
            passed = false;
        }
        for (int i = 0; i < 4; i++) YGConfigSetPointScaleFactor(configs[i], scales[i]);
        YGNodeCalculateLayout(nodes[0], 300, 300, YGDirectionLTR);
        readBoxes(nodes, repeated);
        if (!check(scales, textParent, shift + 0.2f, fresh, false) || !same(repeated, fresh)) {
            std::fputs("FAIL: restored point scale differs from fresh layout\n", stderr);
            passed = false;
        }
        YGNodeSetHasNewLayout(nodes[3], false);
        YGNodeCalculateLayout(nodes[0], 300, 300, YGDirectionLTR);
        if (YGNodeGetHasNewLayout(nodes[3])) {
            std::fputs("FAIL: projection marked a cached descendant as new layout\n", stderr);
            passed = false;
        }
    }
    YGNodeFreeRecursive(nodes[0]);
    for (YGConfigRef config : configs) YGConfigFree(config);
    return passed;
}

static bool legacy()
{
    YGNodeRef root = YGNodeNew(), parent = YGNodeNew(), bottom = YGNodeNew();
    YGNodeStyleSetWidth(root, 640);
    YGNodeStyleSetHeight(root, 480);
    YGNodeStyleSetPositionType(parent, YGPositionTypeAbsolute);
    YGNodeStyleSetPosition(parent, YGEdgeLeft, 64);
    YGNodeStyleSetPosition(parent, YGEdgeTop, 86.4f);
    YGNodeStyleSetWidth(parent, 512);
    YGNodeStyleSetHeight(parent, 374.4f);
    YGNodeInsertChild(root, parent, 0);
    YGNodeStyleSetPositionType(bottom, YGPositionTypeAbsolute);
    YGNodeStyleSetPosition(bottom, YGEdgeBottom, 0);
    YGNodeStyleSetHeight(bottom, 1);
    YGNodeStyleSetWidth(bottom, 8);
    YGNodeInsertChild(parent, bottom, 0);
    YGNodeCalculateLayout(root, 640, 480, YGDirectionLTR);
    bool unchanged = YGNodeLayoutGetTop(parent) == 86 &&
        YGNodeLayoutGetHeight(parent) == 375 && YGNodeLayoutGetTop(bottom) == 373;
    YGNodeSetHasNewLayout(bottom, false);
    YGNodeCalculateLayout(root, 640, 480, YGDirectionLTR);
    unchanged = unchanged && !YGNodeGetHasNewLayout(bottom) &&
        YGNodeLayoutGetTop(bottom) == 373;
    YGNodeFreeRecursive(root);
    if (!unchanged) {
        std::fputs("FAIL: legacy backend changed the original fractional edge result\n", stderr);
        return false;
    }
    std::puts("PASS: legacy backend retains original parent86+375 and child bottom459, including known one-pixel gap");
    return true;
}

int main(int argc, char** argv)
{
    if (argc > 2 || (argc == 2 && std::strcmp(argv[1], "--coherent") &&
        std::strcmp(argv[1], "--legacy"))) return 2;
    bool coherent = argc == 2 && !std::strcmp(argv[1], "--coherent");
    if (!YGPixelGridInitializeCoherentBackend(coherent) ||
        !YGPixelGridInitializeCoherentBackend(coherent) ||
        YGPixelGridInitializeCoherentBackend(!coherent) ||
        YGPixelGridUsesCoherentBackend() != coherent) {
        std::fputs("FAIL: layout backend selection is not immutable\n", stderr);
        return 1;
    }
    if (!coherent) return legacy() ? 0 : 1;
    const float cases[][4] = {{0, 0, 0, 0}, {1, 1, 1, 1}, {1.25f, 1.25f, 1.25f, 1.25f},
        {1, 0, 1.25f, 1}, {1.25f, 1, 0, 1.25f}, {0, 1.25f, 1, 0}};
    Box result[4];
    for (const auto& scales : cases)
        if (!check(scales, false, 0, result, true) || !check(scales, true, 0, result, true)) return 1;
    std::puts("PASS: four-layer starts/dimensions, scale 0/1/1.25/mixed/Text parent, repeated/ancestor-move cache, clone/reset/display and dirty dimensions match fresh layout");
    return 0;
}
