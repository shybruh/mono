//! Independent tempo / pitch via Signalsmith Stretch (vendored C++).

use std::ffi::c_void;

extern "C" {
    fn mono_stretch_new(channels: i32, sample_rate: f32) -> *mut c_void;
    fn mono_stretch_free(handle: *mut c_void);
    fn mono_stretch_reset(handle: *mut c_void);
    fn mono_stretch_set_semitones(handle: *mut c_void, semitones: f32);
    fn mono_stretch_process(
        handle: *mut c_void,
        input: *mut f32,
        in_frames: usize,
        output: *mut f32,
        out_frames: usize,
    );
}

pub struct Stretch {
    ptr: *mut c_void,
    channels: usize,
    semitones: f32,
    /// Fractional output frames carried between calls so long-run tempo is exact.
    carry: f64,
    scratch_in: Vec<f32>,
}

// The handle is only ever touched from the decode thread.
unsafe impl Send for Stretch {}

impl Stretch {
    pub fn new(channels: usize, sample_rate: u32) -> Self {
        let ptr = unsafe { mono_stretch_new(channels as i32, sample_rate as f32) };
        Self { ptr, channels, semitones: 0.0, carry: 0.0, scratch_in: Vec::new() }
    }

    pub fn reset(&mut self) {
        unsafe { mono_stretch_reset(self.ptr) };
        self.carry = 0.0;
    }

    pub fn set_semitones(&mut self, semitones: f32) {
        if (semitones - self.semitones).abs() > f32::EPSILON {
            self.semitones = semitones;
            unsafe { mono_stretch_set_semitones(self.ptr, semitones) };
        }
    }

    /// Stretches interleaved `input` by `speed` (2.0 = twice as fast) into `out`.
    pub fn process(&mut self, input: &[f32], speed: f64, out: &mut Vec<f32>) {
        let in_frames = input.len() / self.channels;
        if in_frames == 0 {
            return;
        }
        let exact = in_frames as f64 / speed + self.carry;
        let out_frames = exact.floor() as usize;
        self.carry = exact - out_frames as f64;
        if out_frames == 0 {
            return;
        }
        self.scratch_in.clear();
        self.scratch_in.extend_from_slice(input);
        let start = out.len();
        out.resize(start + out_frames * self.channels, 0.0);
        unsafe {
            mono_stretch_process(
                self.ptr,
                self.scratch_in.as_mut_ptr(),
                in_frames,
                out[start..].as_mut_ptr(),
                out_frames,
            );
        }
    }
}

impl Drop for Stretch {
    fn drop(&mut self) {
        unsafe { mono_stretch_free(self.ptr) };
    }
}
