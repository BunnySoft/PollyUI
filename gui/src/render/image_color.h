#ifndef POLLYUI_RENDER_IMAGE_COLOR_H
#define POLLYUI_RENDER_IMAGE_COLOR_H
#include "include/core/SkColorSpace.h"

inline sk_sp<SkColorSpace> pu_image_color_space(unsigned primaries, unsigned transfer)
{
    skcms_Matrix3x3 gamut=SkNamedGamut::kSRGB;
    switch(primaries) {
        case 1:gamut=SkNamedGamut::kRec2020;break;
        case 2:gamut=SkNamedGamut::kDisplayP3;break;
        case 3: {
            SkColorSpacePrimaries p={.64f,.33f,.29f,.60f,.15f,.06f,.3127f,.3290f};
            if(!p.toXYZD50(&gamut))return nullptr;
            break;
        }
        case 4: {
            SkColorSpacePrimaries p={.63f,.34f,.31f,.595f,.155f,.07f,.3127f,.3290f};
            if(!p.toXYZD50(&gamut))return nullptr;
            break;
        }
        case 0:break;
        default:return nullptr;
    }
    skcms_TransferFunction function=SkNamedTransferFn::kSRGB;
    switch(transfer) {
        case 1:function={1.f/.45f,1.f/1.099f,.099f/1.099f,1.f/4.5f,.081f,0,0};break;
        case 2:function=SkNamedTransferFn::kLinear;break;
        case 3:function=SkNamedTransferFn::kPQ;break;
        case 4:function=SkNamedTransferFn::kHLG;break;
        case 0:break;
        default:return nullptr;
    }
    return SkColorSpace::MakeRGB(function,gamut);
}
#endif
