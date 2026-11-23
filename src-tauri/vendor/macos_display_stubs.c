// Local definitions of five CoreGraphics display functions that tao (the
// window library) references for exclusive "video mode" fullscreen.
//
// Newer macOS releases no longer export them, and a binary that imports a
// missing symbol is refused at launch. Mono only ever uses borderless
// fullscreen, so these are never called; defining them here keeps the
// executable from importing them at all. Each reports failure or does
// nothing, which tao already handles (it skips the fade when the
// reservation fails).

#include <stdint.h>

typedef int32_t CGError;
typedef int32_t CGWindowLevel;
typedef uint32_t CGDisplayFadeReservationToken;
typedef float CGDisplayFadeInterval;
typedef float CGDisplayReservationInterval;
typedef float CGDisplayBlendFraction;
typedef uint8_t Boolean;

enum { kCGErrorFailure = 1000 };

CGError CGAcquireDisplayFadeReservation(CGDisplayReservationInterval seconds, CGDisplayFadeReservationToken *token) {
    (void)seconds;
    if (token) *token = 0;
    return kCGErrorFailure;
}

CGError CGDisplayFade(CGDisplayFadeReservationToken token, CGDisplayFadeInterval duration,
                      CGDisplayBlendFraction start, CGDisplayBlendFraction end,
                      float red, float green, float blue, Boolean synchronous) {
    (void)token; (void)duration; (void)start; (void)end;
    (void)red; (void)green; (void)blue; (void)synchronous;
    return kCGErrorFailure;
}

CGError CGReleaseDisplayFadeReservation(CGDisplayFadeReservationToken token) {
    (void)token;
    return kCGErrorFailure;
}

void CGRestorePermanentDisplayConfiguration(void) {}

// Above every normal window, like the real shielding level.
CGWindowLevel CGShieldingWindowLevel(void) {
    return INT32_MAX - 1;
}
