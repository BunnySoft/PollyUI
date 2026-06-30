// HostEngine — macOS native title-bar helper for PollyUI.
//
// Built only on Apple. Lets the SDL host turn an SDL-created NSWindow into a
// "transparent title bar, full-size content" window (like Electron/Tauri
// titleBarStyle:'hidden'): the app's Skia content fills the whole window, while
// macOS keeps drawing its real traffic-light buttons (close/minimize/zoom) in
// the top-left with fully native appearance and behavior. The app reserves a
// little space on the left so its own content doesn't sit under the buttons.

#import <Cocoa/Cocoa.h>

extern "C" void pu_macos_titlebar_overlay(void *nswindow, int on)
{
    if (!nswindow) return;
    NSWindow *win = (__bridge NSWindow *)nswindow;

    void (^apply)(void) = ^{
        if (on) {
            win.styleMask |= NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                             NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable |
                             NSWindowStyleMaskFullSizeContentView;
            win.titlebarAppearsTransparent = YES;
            win.titleVisibility = NSWindowTitleHidden;
            win.movableByWindowBackground = NO;   /* dragging via SDL hit-test */
            /* Make sure the native window buttons are visible. */
            [win standardWindowButton:NSWindowCloseButton].hidden = NO;
            [win standardWindowButton:NSWindowMiniaturizeButton].hidden = NO;
            [win standardWindowButton:NSWindowZoomButton].hidden = NO;
        } else {
            win.titlebarAppearsTransparent = NO;
            win.titleVisibility = NSWindowTitleVisible;
            win.styleMask &= ~NSWindowStyleMaskFullSizeContentView;
        }
    };

    if ([NSThread isMainThread]) apply();
    else dispatch_async(dispatch_get_main_queue(), apply);
}
