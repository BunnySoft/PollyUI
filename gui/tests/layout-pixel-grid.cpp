#include <yoga/Yoga.h>
#include <cmath>
#include <cstdio>

struct Box {
    float left, top, width, height;
};

static bool close(float actual, float expected)
{
    return std::fabs(actual - expected) < 0.0001f;
}

static void readBoxes(YGNodeRef nodes[3], Box boxes[3])
{
    float x = 0, y = 0;
    for (int i = 0; i < 3; i++) {
        x += YGNodeLayoutGetLeft(nodes[i]); y += YGNodeLayoutGetTop(nodes[i]);
        boxes[i] = {x, y, YGNodeLayoutGetWidth(nodes[i]), YGNodeLayoutGetHeight(nodes[i])};
    }
}

static bool same(const Box actual[3], const Box expected[3])
{
    for (int i = 0; i < 3; i++)
        if (!close(actual[i].left, expected[i].left) || !close(actual[i].top, expected[i].top) ||
            !close(actual[i].width, expected[i].width) || !close(actual[i].height, expected[i].height))
            return false;
    return true;
}

static bool check(const float scales[3], bool textParent, float shift, Box result[3], bool cache)
{
    YGConfigRef configs[3];
    YGNodeRef nodes[3];
    const float starts[3] = {0, 13.4f + shift, 7.6f};
    const float sizes[3] = {300, 100.4f, 20.6f};
    for (int i = 0; i < 3; i++) {
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
    Box raw[3];
    for (int i = 0; i < 3; i++)
        raw[i] = {YGNodeLayoutGetLeft(nodes[i]), YGNodeLayoutGetTop(nodes[i]),
            YGNodeLayoutGetWidth(nodes[i]), YGNodeLayoutGetHeight(nodes[i])};
    for (int i = 0; i < 3; i++) YGConfigSetPointScaleFactor(configs[i], scales[i]);
    YGNodeStyleSetWidth(nodes[0], 301);
    YGNodeStyleSetWidth(nodes[0], 300);
    YGNodeCalculateLayout(nodes[0], 300, 300, YGDirectionLTR);
    float rawLeft = 0, rawTop = 0, actualLeft = 0, actualTop = 0;
    bool passed = true;
    for (int i = 0; i < 3; i++) {
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
        Box repeated[3], changed[3], fresh[3];
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
            std::fputs("FAIL: ancestor-only fractional move differs from fresh layout\n", stderr);
            passed = false;
        }
    }
    YGNodeFreeRecursive(nodes[0]);
    for (YGConfigRef config : configs) YGConfigFree(config);
    return passed;
}

int main()
{
    const float cases[][3] = {{0, 0, 0}, {1, 1, 1}, {1.25f, 1.25f, 1.25f},
        {1, 0, 1.25f}, {1.25f, 1, 0}, {0, 1.25f, 1}};
    Box result[3];
    for (const auto& scales : cases)
        if (!check(scales, false, 0, result, true) || !check(scales, true, 0, result, true)) return 1;
    std::puts("PASS: absolute starts, existing dimensions, scale 0/1/1.25/mixed/Text parent, repeated layout and ancestor-only cached move match fresh layout");
    return 0;
}
