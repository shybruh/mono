//! The cpal output stream. It only reads from a lock-free ring buffer, applies
//! a smoothed volume ramp and optionally taps samples for the meters.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use rtrb::{Consumer, Producer, RingBuffer};

use super::Shared;

pub struct Output {
    /// The device stream: kept alive here, paused while playback is.
    pub stream: cpal::Stream,
    pub producer: Producer<f32>,
    pub sample_rate: u32,
}

/// Seconds of audio held between the decoder and the device.
const RING_SECONDS: f32 = 0.2;

pub fn open(shared: Arc<Shared>, analysis: Producer<f32>) -> Result<Output> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or_else(|| anyhow!("no output device"))?;
    let supported = device.default_output_config()?;
    let sample_rate = supported.sample_rate();
    let channels = supported.channels() as usize;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    let cap = ((sample_rate as f32 * RING_SECONDS) as usize).max(4096) * 2;
    let (producer, consumer) = RingBuffer::<f32>::new(cap);

    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, &config, channels, consumer, analysis, shared)?,
        SampleFormat::I16 => build::<i16>(&device, &config, channels, consumer, analysis, shared)?,
        SampleFormat::U16 => build::<u16>(&device, &config, channels, consumer, analysis, shared)?,
        SampleFormat::I32 => build::<i32>(&device, &config, channels, consumer, analysis, shared)?,
        other => return Err(anyhow!("unsupported device sample format {other:?}")),
    };
    stream.play()?;
    Ok(Output { stream, producer, sample_rate })
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    mut cons: Consumer<f32>,
    mut analysis: Producer<f32>,
    shared: Arc<Shared>,
) -> Result<cpal::Stream>
where
    T: SizedSample + FromSample<f32>,
{
    let sr = config.sample_rate as f32;
    // ~4 ms one-pole ramp: click-free pause / volume changes.
    let k = 1.0 - (-1.0 / (0.004 * sr)).exp();
    let mut gain = 0.0f32;
    let err_shared = shared.clone();

    let stream = device.build_output_stream(
        config,
        move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
            let frames = data.len() / channels;
            let mut consumed = shared.consumed.load(Ordering::Acquire);
            let target = shared.discard_until.load(Ordering::Acquire);

            if consumed < target {
                let want = (((target - consumed) as usize) * 2).min(cons.slots()) & !1;
                if want > 0 {
                    if let Ok(c) = cons.read_chunk(want) {
                        c.commit_all();
                    }
                    consumed += (want / 2) as u64;
                }
            }
            let behind = consumed < target;
            let paused = shared.paused.load(Ordering::Relaxed);
            let volume = f32::from_bits(shared.volume.load(Ordering::Relaxed));
            let target_gain = if paused { 0.0 } else { volume };
            let meters = shared.meters_on.load(Ordering::Relaxed);

            let avail = if behind { 0 } else { cons.slots() / 2 };
            let take = if paused && gain < 1e-4 { 0 } else { frames.min(avail) };
            let chunk = if take > 0 { cons.read_chunk(take * 2).ok() } else { None };
            let (a, b): (&[f32], &[f32]) = match &chunk {
                Some(c) => c.as_slices(),
                None => (&[], &[]),
            };

            for f in 0..frames {
                let (l, r) = if f < take {
                    let i = f * 2;
                    let s = |j: usize| if j < a.len() { a[j] } else { b[j - a.len()] };
                    (s(i), s(i + 1))
                } else {
                    (0.0, 0.0)
                };
                gain += (target_gain - gain) * k;
                if meters && f < take {
                    let _ = analysis.push(l);
                    let _ = analysis.push(r);
                }
                let out = &mut data[f * channels..(f + 1) * channels];
                match channels {
                    1 => out[0] = T::from_sample((l + r) * 0.5 * gain),
                    _ => {
                        out[0] = T::from_sample(l * gain);
                        out[1] = T::from_sample(r * gain);
                        for o in out.iter_mut().skip(2) {
                            *o = T::from_sample(0.0f32);
                        }
                    }
                }
            }
            if let Some(c) = chunk {
                c.commit_all();
            }
            shared.consumed.store(consumed + take as u64, Ordering::Release);
        },
        move |err| {
            eprintln!("audio stream error: {err}");
            err_shared.stream_dead.store(true, Ordering::Release);
        },
        None,
    )?;
    Ok(stream)
}
