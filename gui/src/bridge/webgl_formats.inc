struct StorageFormat {
    GLenum format, type;
    unsigned bytes;
    bool depth, stencil, integer, unsign;
};
bool storage_format(GLenum internal, StorageFormat* result)
{
    StorageFormat value = { };
#define FORMAT(name, transfer_format, transfer_type, size)                                         \
    case GL_##name:                                                                                \
        value = { GL_##transfer_format, GL_##transfer_type, size, false, false, false, false };    \
        break;
    switch (internal) {
        FORMAT(R8, RED, UNSIGNED_BYTE, 1)
    FORMAT(R8_SNORM, RED, BYTE, 1)
    FORMAT(R16F, RED, HALF_FLOAT, 2) FORMAT(R32F, RED, FLOAT, 4) FORMAT(R8I, RED_INTEGER, BYTE, 1)
        FORMAT(R8UI, RED_INTEGER, UNSIGNED_BYTE, 1) FORMAT(R16I, RED_INTEGER, SHORT, 2) FORMAT(
            R16UI, RED_INTEGER, UNSIGNED_SHORT, 2) FORMAT(R32I, RED_INTEGER, INT, 4) FORMAT(R32UI,
            RED_INTEGER, UNSIGNED_INT, 4) FORMAT(RG8, RG, UNSIGNED_BYTE, 2) FORMAT(RG8_SNORM, RG,
            BYTE, 2) FORMAT(RG16F, RG, HALF_FLOAT, 4) FORMAT(RG32F, RG, FLOAT, 8) FORMAT(RG8I,
            RG_INTEGER, BYTE, 2) FORMAT(RG8UI, RG_INTEGER, UNSIGNED_BYTE, 2) FORMAT(RG16I,
            RG_INTEGER, SHORT, 4) FORMAT(RG16UI, RG_INTEGER, UNSIGNED_SHORT, 4) FORMAT(RG32I,
            RG_INTEGER, INT, 8) FORMAT(RG32UI, RG_INTEGER, UNSIGNED_INT, 8) FORMAT(RGB8, RGB,
            UNSIGNED_BYTE, 3) FORMAT(SRGB8, RGB, UNSIGNED_BYTE, 3) FORMAT(RGB565, RGB,
            UNSIGNED_SHORT_5_6_5, 2) FORMAT(RGB8_SNORM, RGB, BYTE, 3) FORMAT(R11F_G11F_B10F, RGB,
            UNSIGNED_INT_10F_11F_11F_REV, 4) FORMAT(RGB9_E5, RGB, UNSIGNED_INT_5_9_9_9_REV,
            4) FORMAT(RGB16F, RGB, HALF_FLOAT, 6) FORMAT(RGB32F, RGB, FLOAT, 12) FORMAT(RGB8I,
            RGB_INTEGER, BYTE, 3) FORMAT(RGB8UI, RGB_INTEGER, UNSIGNED_BYTE, 3) FORMAT(RGB16I,
            RGB_INTEGER, SHORT, 6) FORMAT(RGB16UI, RGB_INTEGER, UNSIGNED_SHORT, 6) FORMAT(RGB32I,
            RGB_INTEGER, INT, 12) FORMAT(RGB32UI, RGB_INTEGER, UNSIGNED_INT, 12)
            FORMAT(RGBA8, RGBA, UNSIGNED_BYTE, 4) FORMAT(SRGB8_ALPHA8, RGBA, UNSIGNED_BYTE, 4)
                FORMAT(RGBA8_SNORM, RGBA, BYTE, 4) FORMAT(RGB5_A1, RGBA, UNSIGNED_SHORT_5_5_5_1, 2)
                    FORMAT(RGBA4, RGBA, UNSIGNED_SHORT_4_4_4_4, 2)
                        FORMAT(RGB10_A2, RGBA, UNSIGNED_INT_2_10_10_10_REV, 4)
                            FORMAT(RGBA16F, RGBA, HALF_FLOAT, 8) FORMAT(RGBA32F, RGBA, FLOAT, 16)
                                FORMAT(RGBA8I, RGBA_INTEGER, BYTE, 4)
                                    FORMAT(RGBA8UI, RGBA_INTEGER, UNSIGNED_BYTE, 4)
                                        FORMAT(RGBA16I, RGBA_INTEGER, SHORT, 8)
                                            FORMAT(RGBA16UI, RGBA_INTEGER, UNSIGNED_SHORT, 8)
                                                FORMAT(RGBA32I, RGBA_INTEGER, INT, 16)
                                                    FORMAT(RGBA32UI, RGBA_INTEGER, UNSIGNED_INT, 16)
                                                        FORMAT(RGB10_A2UI, RGBA_INTEGER,
                                                            UNSIGNED_INT_2_10_10_10_REV,
                                                            4) case GL_DEPTH_COMPONENT16:
        value = { GL_DEPTH_COMPONENT, GL_UNSIGNED_SHORT, 2, true, false, false, false };
        break;
    case GL_DEPTH_COMPONENT24:
        value = { GL_DEPTH_COMPONENT, GL_UNSIGNED_INT, 4, true, false, false, false };
        break;
    case GL_DEPTH_COMPONENT32F:
        value = { GL_DEPTH_COMPONENT, GL_FLOAT, 4, true, false, false, false };
        break;
    case GL_DEPTH24_STENCIL8:
        value = { GL_DEPTH_STENCIL, GL_UNSIGNED_INT_24_8, 4, true, true, false, false };
        break;
    case GL_DEPTH32F_STENCIL8:
        value
            = { GL_DEPTH_STENCIL, GL_FLOAT_32_UNSIGNED_INT_24_8_REV, 8, true, true, false, false };
        break;
    case GL_STENCIL_INDEX8:
        value = { 0, GL_UNSIGNED_BYTE, 1, false, true, false, false };
        break;
    default:
        return false;
    }
#undef FORMAT
    value.integer = value.format == GL_RED_INTEGER || value.format == GL_RG_INTEGER
        || value.format == GL_RGB_INTEGER || value.format == GL_RGBA_INTEGER;
    value.unsign = value.integer
        && (value.type == GL_UNSIGNED_BYTE || value.type == GL_UNSIGNED_SHORT
            || value.type == GL_UNSIGNED_INT || value.type == GL_UNSIGNED_INT_2_10_10_10_REV);
    *result = value;
    return true;
}
unsigned transfer_bytes(GLenum format, GLenum type)
{
    unsigned channels = format == GL_RED || format == GL_RED_INTEGER || format == GL_DEPTH_COMPONENT
            || format == GL_ALPHA || format == GL_LUMINANCE
        ? 1
        : format == GL_RG || format == GL_RG_INTEGER || format == GL_LUMINANCE_ALPHA ? 2
        : format == GL_RGB || format == GL_RGB_INTEGER                               ? 3
        : format == GL_RGBA || format == GL_RGBA_INTEGER                             ? 4
        : format == GL_DEPTH_STENCIL                                                 ? 1
                                                                                     : 0;
    if (!channels)
        return 0;
    switch (type) {
    case GL_BYTE:
    case GL_UNSIGNED_BYTE:
        return channels;
    case GL_SHORT:
    case GL_UNSIGNED_SHORT:
    case GL_HALF_FLOAT:
        return channels * 2;
    case GL_INT:
    case GL_UNSIGNED_INT:
    case GL_FLOAT:
        return channels * 4;
    case GL_UNSIGNED_SHORT_5_6_5:
        return format == GL_RGB ? 2 : 0;
    case GL_UNSIGNED_SHORT_4_4_4_4:
    case GL_UNSIGNED_SHORT_5_5_5_1:
        return format == GL_RGBA ? 2 : 0;
    case GL_UNSIGNED_INT_2_10_10_10_REV:
        return format == GL_RGBA || format == GL_RGBA_INTEGER ? 4 : 0;
    case GL_UNSIGNED_INT_10F_11F_11F_REV:
    case GL_UNSIGNED_INT_5_9_9_9_REV:
        return format == GL_RGB ? 4 : 0;
    case GL_UNSIGNED_INT_24_8:
        return format == GL_DEPTH_STENCIL ? 4 : 0;
    case GL_FLOAT_32_UNSIGNED_INT_24_8_REV:
        return format == GL_DEPTH_STENCIL ? 8 : 0;
    default:
        return 0;
    }
}
bool transfer_type(int array_type, GLenum type)
{
    switch (type) {
    case GL_BYTE:
        return array_type == JS_TYPED_ARRAY_INT8;
    case GL_UNSIGNED_BYTE:
        return array_type == JS_TYPED_ARRAY_UINT8 || array_type == JS_TYPED_ARRAY_UINT8C;
    case GL_SHORT:
        return array_type == JS_TYPED_ARRAY_INT16;
    case GL_UNSIGNED_SHORT:
    case GL_HALF_FLOAT:
    case GL_UNSIGNED_SHORT_5_6_5:
    case GL_UNSIGNED_SHORT_4_4_4_4:
    case GL_UNSIGNED_SHORT_5_5_5_1:
        return array_type == JS_TYPED_ARRAY_UINT16;
    case GL_INT:
        return array_type == JS_TYPED_ARRAY_INT32;
    case GL_FLOAT:
        return array_type == JS_TYPED_ARRAY_FLOAT32;
    default:
        return array_type == JS_TYPED_ARRAY_UINT32;
    }
}
unsigned compressed_block(GLenum format)
{
    switch (format) {
    case GL_COMPRESSED_R11_EAC:
    case GL_COMPRESSED_SIGNED_R11_EAC:
    case GL_COMPRESSED_RGB8_ETC2:
    case GL_COMPRESSED_SRGB8_ETC2:
    case GL_COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2:
    case GL_COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2:
        return 8;
    case GL_COMPRESSED_RG11_EAC:
    case GL_COMPRESSED_SIGNED_RG11_EAC:
    case GL_COMPRESSED_RGBA8_ETC2_EAC:
    case GL_COMPRESSED_SRGB8_ALPHA8_ETC2_EAC:
        return 16;
    default:
        return 0;
    }
}
bool core_renderable(GLenum format)
{
    switch (format) {
    case GL_R8:
    case GL_RG8:
    case GL_RGB8:
    case GL_RGB565:
    case GL_RGBA4:
    case GL_RGB5_A1:
    case GL_RGBA8:
    case GL_RGB10_A2:
    case GL_SRGB8_ALPHA8:
    case GL_R8I:
    case GL_R8UI:
    case GL_R16I:
    case GL_R16UI:
    case GL_R32I:
    case GL_R32UI:
    case GL_RG8I:
    case GL_RG8UI:
    case GL_RG16I:
    case GL_RG16UI:
    case GL_RG32I:
    case GL_RG32UI:
    case GL_RGBA8I:
    case GL_RGBA8UI:
    case GL_RGBA16I:
    case GL_RGBA16UI:
    case GL_RGBA32I:
    case GL_RGBA32UI:
    case GL_RGB10_A2UI:
    case GL_DEPTH_COMPONENT16:
    case GL_DEPTH_COMPONENT24:
    case GL_DEPTH_COMPONENT32F:
    case GL_DEPTH24_STENCIL8:
    case GL_DEPTH32F_STENCIL8:
    case GL_STENCIL_INDEX8:
    case GL_RGBA:
    case GL_RGB:
        return true;
    default:
        return false;
    }
}
