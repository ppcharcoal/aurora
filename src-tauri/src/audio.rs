//! Song analysis for transitions (Windows and Linux): waveforms for the
//! transition editor and where the sound really starts and ends (so the
//! "Smooth" transition skips silent intros and outros). Read-only: FFmpeg
//! decodes the file into memory, the file itself is never changed.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::rt::AppHandle;

const AUDIO: &[&str] = &["mp3", "m4a", "mp4", "aac", "opus", "ogg", "oga", "flac", "wav", "webm"];

fn check(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let ok = p.extension().and_then(|e| e.to_str()).map(|e| AUDIO.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false);
    if !ok || !p.is_file() {
        return Err("That song file isn't there any more.".into());
    }
    Ok(p)
}

fn ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    let r = crate::tools::resolve(app)?;
    let exe = format!("ffmpeg{}", std::env::consts::EXE_SUFFIX);
    Ok(r.ffmpeg_dir.map(|d| d.join(&exe)).unwrap_or_else(|| PathBuf::from(exe)))
}

const RATE: u32 = 8000;

/// Decodes `dur_ms` of the song from `start_ms` as 8 kHz mono samples.
async fn decode(app: &AppHandle, path: &Path, start_ms: u64, dur_ms: u64) -> Result<Vec<i16>, String> {
    let out = crate::tools::command(&ffmpeg(app)?)
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-ss"])
        .arg(format!("{:.3}", start_ms as f64 / 1000.0))
        .arg("-t")
        .arg(format!("{:.3}", dur_ms as f64 / 1000.0))
        .arg("-i")
        .arg(path)
        .args(["-vn", "-ac", "1", "-ar", &RATE.to_string(), "-f", "s16le", "-"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("FFmpeg is needed to read the song ({e}). Settings → Download tools."))?;
    if !out.status.success() && out.stdout.is_empty() {
        return Err(format!("Couldn't read the song: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(out.stdout.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect())
}

/// Loudness outline of part of a song: `points` values from 0 to 255.
#[tauri::command]
pub async fn audio_peaks(app: AppHandle, path: String, start_ms: u64, dur_ms: u64, points: usize) -> Result<Vec<u8>, String> {
    let p = check(&path)?;
    let points = points.clamp(16, 4000);
    let samples = decode(&app, &p, start_ms, dur_ms.min(10 * 60_000)).await?;
    Ok(peaks(&samples, (dur_ms * RATE as u64 / 1000) as usize, points))
}

fn peaks(samples: &[i16], expected: usize, points: usize) -> Vec<u8> {
    let total = expected.max(samples.len()).max(1);
    let per = (total as f64 / points as f64).max(1.0);
    (0..points)
        .map(|i| {
            let a = (i as f64 * per) as usize;
            let b = (((i + 1) as f64 * per) as usize).min(samples.len());
            if a >= b {
                return 0;
            }
            let peak = samples[a..b].iter().map(|s| s.unsigned_abs()).max().unwrap_or(0) as f64 / 32768.0;
            // A gentle curve so quiet parts still show.
            (peak.sqrt() * 255.0).round().min(255.0) as u8
        })
        .collect()
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    /// Silence at the start, ms.
    lead_ms: u64,
    /// Where the sound ends, ms from the start.
    end_ms: u64,
}

/// Where the music starts and stops (ignoring silence at either end).
#[tauri::command]
pub async fn audio_bounds(app: AppHandle, path: String, duration_ms: u64) -> Result<Bounds, String> {
    let p = check(&path)?;
    const LOOK: u64 = 20_000;
    let head = decode(&app, &p, 0, LOOK.min(duration_ms.max(1))).await?;
    let tail_from = duration_ms.saturating_sub(LOOK);
    let tail = decode(&app, &p, tail_from, LOOK).await?;
    Ok(bounds(&head, &tail, tail_from, duration_ms))
}

/// -48 dBFS: quieter than this counts as silence.
const QUIET: u16 = 130;

fn bounds(head: &[i16], tail: &[i16], tail_from: u64, duration_ms: u64) -> Bounds {
    let ms = |i: usize| i as u64 * 1000 / RATE as u64;
    let lead = head.iter().position(|s| s.unsigned_abs() > QUIET).map(ms).unwrap_or(0);
    let end = tail
        .iter()
        .rposition(|s| s.unsigned_abs() > QUIET)
        .map(|i| tail_from + ms(i + 1))
        .unwrap_or(duration_ms);
    // Keep a sliver of the natural decay, and never trim more than half the song.
    Bounds { lead_ms: lead.saturating_sub(40).min(duration_ms / 2), end_ms: (end + 150).min(duration_ms).max(duration_ms / 2) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_silence_and_peaks() {
        // 0.5 s silence, 1 s tone, 0.25 s silence at 8 kHz.
        let mut s = vec![0i16; 4000];
        s.extend((0..8000).map(|i| if i % 2 == 0 { 9000 } else { -9000 }));
        s.extend(vec![0i16; 2000]);
        let b = bounds(&s, &s, 0, 1750);
        assert!((440..=500).contains(&b.lead_ms), "{b:?}");
        assert!((1500..=1700).contains(&b.end_ms), "{b:?}");
        let p = peaks(&s, s.len(), 7);
        assert_eq!(p.len(), 7);
        assert_eq!(p[0], 0);
        assert!(p[3] > 100);
    }
}
