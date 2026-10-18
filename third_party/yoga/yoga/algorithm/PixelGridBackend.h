/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include <stdbool.h>

/* Private static-library integration: select once, before the first layout.
 * Repeating the same choice is harmless; changing the frozen choice fails. */
#ifdef __cplusplus
extern "C" {
#endif
bool YGPixelGridInitializeCoherentBackend(bool coherent);
bool YGPixelGridUsesCoherentBackend(void);
#ifdef __cplusplus
}
#endif
