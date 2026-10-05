/* Generated schema, not theme values. */
#ifndef POLLY_APPEARANCE_FIELDS_H
#define POLLY_APPEARANCE_FIELDS_H
#define PU_APPEARANCE_METRICS(X) \
    X(int, border_width, borderWidth, 0, 8, 1) \
    X(int, title_height, titleHeight, 16, 96, 1) \
    X(int, radius, radius, 0, 64, 1) \
    X(int, control_size, controlSize, 8, 64, 1) \
    X(int, control_gap, controlGap, 0, 32, 1) \
    X(int, control_inset, controlInset, 0, 32, 1) \
    X(int, control_radius, controlRadius, 0, 32, 1) \
    X(int, text_inset, textInset, 0, 64, 1) \
    X(int, text_gap, textGap, 0, 32, 1) \
    X(int, font_size, fontSize, 8, 32, 1) \
    X(int, font_weight, fontWeight, 100, 900, 1) \
    X(int, stripe_spacing, stripeSpacing, 1, 32, 1) \
    X(int, stripe_width, stripeWidth, 1, 16, 1) \
    X(double, glyph_radius, glyphRadius, 1, 16, 1000) \
    X(double, glyph_thickness, glyphThickness, 0.1, 4, 1000) \
    X(double, close_thickness, closeThickness, 0.1, 4, 1000) \
    X(double, hover_opacity, hoverOpacity, 0, 1, 1000) \
    X(double, inactive_opacity, inactiveOpacity, 0, 1, 1000) \
    X(double, stripe_opacity, stripeOpacity, 0, 1, 1000)
#define PU_APPEARANCE_COLORS(X) \
    X(border) \
    X(titleFrom) \
    X(titleTo) \
    X(titleText) \
    X(inactiveFrom) \
    X(inactiveTo) \
    X(inactiveText) \
    X(controlFrom) \
    X(controlTo) \
    X(closeFrom) \
    X(closeTo) \
    X(controlText) \
    X(minimizeFrom) \
    X(minimizeTo) \
    X(maximizeFrom) \
    X(maximizeTo) \
    X(hoverColor) \
    X(stripeColor)
#endif
