#ifndef POLLYUI_APPLICATION_H
#define POLLYUI_APPLICATION_H

typedef struct PuLaunchOptions {
    const char *script;
    const char *app_id;
    int argc;
    char **argv;
    int desktop_mode;
    int input_method_mode;
    int lock_mode;
    int greeter_mode;
} PuLaunchOptions;

int pu_application_run(const PuLaunchOptions *options);
int pu_application_test(const char *script);
int pu_application_demo(void);

#endif
