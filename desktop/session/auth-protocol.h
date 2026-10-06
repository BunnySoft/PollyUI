#ifndef POLLY_AUTH_PROTOCOL_H
#define POLLY_AUTH_PROTOCOL_H
#include <stdint.h>
#define PU_AUTH_MAGIC UINT32_C(0x50414d31)
#define PU_AUTH_PASSWORD_LIMIT 4096
enum PuAuthResult { PU_AUTH_ACCEPTED, PU_AUTH_DENIED, PU_AUTH_UNAVAILABLE };
struct PuAuthRequest { uint32_t magic, serial, length; };
struct PuAuthReply { uint32_t magic, serial, result, pam_status; };
#endif
