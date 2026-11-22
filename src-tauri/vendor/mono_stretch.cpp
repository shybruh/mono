// Thin C ABI over Signalsmith Stretch (MIT, see vendor/signalsmith/*/LICENSE.txt).
// Buffers are interleaved; lengths are in frames.

#include <cstddef>
#include "signalsmith-stretch/signalsmith-stretch.h"

namespace {

struct Interleaved {
    float *data;
    int channels;

    struct Channel {
        float *data;
        int channel;
        int stride;
        float &operator[](size_t i) { return data[i * stride + channel]; }
        const float &operator[](size_t i) const { return data[i * stride + channel]; }
    };

    Channel operator[](size_t c) { return Channel{data, static_cast<int>(c), channels}; }
};

struct Handle {
    signalsmith::stretch::SignalsmithStretch<float> inner;
    int channels;
};

} // namespace

extern "C" {

void *mono_stretch_new(int channels, float sample_rate) {
    auto *h = new Handle;
    h->channels = channels;
    h->inner.presetDefault(channels, sample_rate);
    return h;
}

void mono_stretch_free(void *handle) { delete static_cast<Handle *>(handle); }

void mono_stretch_reset(void *handle) { static_cast<Handle *>(handle)->inner.reset(); }

void mono_stretch_set_semitones(void *handle, float semitones) {
    static_cast<Handle *>(handle)->inner.setTransposeSemitones(semitones, 0.0f);
}

void mono_stretch_process(void *handle, float *input, size_t in_frames, float *output, size_t out_frames) {
    auto *h = static_cast<Handle *>(handle);
    Interleaved in{input, h->channels};
    Interleaved out{output, h->channels};
    h->inner.process(in, static_cast<int>(in_frames), out, static_cast<int>(out_frames));
}

}
