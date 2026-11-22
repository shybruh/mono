//! A decoder over a file held entirely in memory. Always yields interleaved
//! stereo f32 at the file's native sample rate.

use std::io::Cursor;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::{Time, TimeBase};

pub struct Source {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    time_base: Option<TimeBase>,
    pub sample_rate: u32,
    pub duration: f64,
    /// Current read position in source frames.
    pub pos_frames: u64,
    /// Frames to drop after an accurate seek, until this timestamp.
    skip_until_ts: Option<u64>,
    sample_buf: Option<SampleBuffer<f32>>,
}

impl Source {
    pub fn open(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
        Self::from_bytes(bytes, path.extension().and_then(|e| e.to_str()))
    }

    pub fn from_bytes(bytes: Vec<u8>, ext: Option<&str>) -> Result<Self> {
        let mss = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = ext {
            hint.with_extension(ext);
        }
        let fmt_opts = FormatOptions { enable_gapless: true, ..Default::default() };
        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &fmt_opts, &MetadataOptions::default())
            .map_err(|e| anyhow!("unsupported format: {e}"))?;
        let format = probed.format;
        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or_else(|| anyhow!("no audio track"))?;
        let params = track.codec_params.clone();
        let decoder = symphonia::default::get_codecs()
            .make(&params, &DecoderOptions::default())
            .map_err(|e| anyhow!("unsupported codec: {e}"))?;
        let sample_rate = params.sample_rate.unwrap_or(44_100);
        let duration = match (params.n_frames, params.time_base) {
            (Some(n), Some(tb)) => {
                let t = tb.calc_time(n);
                t.seconds as f64 + t.frac
            }
            (Some(n), None) => n as f64 / sample_rate as f64,
            _ => 0.0,
        };
        Ok(Self {
            track_id: track.id,
            time_base: params.time_base,
            format,
            decoder,
            sample_rate,
            duration,
            pos_frames: 0,
            skip_until_ts: None,
            sample_buf: None,
        })
    }

    pub fn position(&self) -> f64 {
        self.pos_frames as f64 / self.sample_rate as f64
    }

    fn ts_to_frames(&self, ts: u64) -> u64 {
        match self.time_base {
            Some(tb) => {
                let t = tb.calc_time(ts);
                ((t.seconds as f64 + t.frac) * self.sample_rate as f64).round() as u64
            }
            None => ts,
        }
    }

    pub fn seek(&mut self, secs: f64) -> Result<()> {
        let secs = secs.clamp(0.0, (self.duration - 0.05).max(0.0));
        let seeked = self
            .format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time { time: Time::from(secs), track_id: Some(self.track_id) },
            )
            .map_err(|e| anyhow!("seek failed: {e}"))?;
        self.decoder.reset();
        self.skip_until_ts = Some(seeked.required_ts);
        self.pos_frames = self.ts_to_frames(seeked.required_ts);
        Ok(())
    }

    /// Appends the next decoded chunk (interleaved stereo) to `out`.
    /// Returns `Ok(false)` at end of stream.
    pub fn next_chunk(&mut self, out: &mut Vec<f32>) -> Result<bool> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return Ok(false)
                }
                Err(SymError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(e) => return Err(anyhow!("demux error: {e}")),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(SymError::DecodeError(_)) | Err(SymError::IoError(_)) => continue,
                Err(e) => return Err(anyhow!("decode error: {e}")),
            };
            let spec = *decoded.spec();
            let frames = decoded.frames();
            if frames == 0 {
                continue;
            }
            let needs_new = self
                .sample_buf
                .as_ref()
                .map(|b| b.capacity() < frames * spec.channels.count())
                .unwrap_or(true);
            if needs_new {
                self.sample_buf = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
            }
            let buf = self.sample_buf.as_mut().unwrap();
            buf.copy_interleaved_ref(decoded);
            let samples = buf.samples();
            let ch = spec.channels.count().max(1);

            // Accurate-seek trimming.
            let mut skip = 0usize;
            if let Some(req) = self.skip_until_ts {
                let ts = packet.ts();
                if ts + frames as u64 <= req {
                    continue;
                }
                if ts < req {
                    skip = (req - ts) as usize;
                }
                self.skip_until_ts = None;
            }

            out.reserve((frames - skip) * 2);
            for f in skip..frames {
                let i = f * ch;
                let (l, r) = if ch == 1 {
                    (samples[i], samples[i])
                } else {
                    (samples[i], samples[i + 1])
                };
                out.push(l);
                out.push(r);
            }
            self.pos_frames += (frames - skip) as u64;
            return Ok(true);
        }
    }
}
