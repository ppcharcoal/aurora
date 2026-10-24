//! Volume sync (Windows and Linux): measures how loud each song is (EBU
//! R128 / ITU-R BS.1770 integrated loudness, like ReplayGain and the big
//! streaming apps) so the player can bring every song to the same level.
//! FFmpeg decodes the song into memory; the file itself is never changed.
//! Results are kept in `loudness.json` (path → loudness, peak, file size and
//! date), which isn't put in backups: it's simply measured again.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::rt::AppHandle;
use crate::store::data_dir;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Loudness {
    /// Integrated loudness, LUFS.
    pub lufs: f64,
    /// Sample peak, 0–1 (1 = full scale).
    pub peak: f64,
}

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    lufs: f64,
    peak: f64,
    size: u64,
    mtime: u64,
}

#[derive(Default)]
pub struct LoudnessCache(Mutex<Option<HashMap<String, Entry>>>);

const FILE: &str = "loudness.json";

fn stamp(p: &Path) -> Option<(u64, u64)> {
    let m = std::fs::metadata(p).ok()?;
    let t = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some((m.len(), t))
}

fn with_cache<T>(app: &AppHandle, state: &LoudnessCache, f: impl FnOnce(&mut HashMap<String, Entry>, &PathBuf) -> T) -> Result<T, String> {
    let file = data_dir(app)?.join(FILE);
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let map = guard.get_or_insert_with(|| {
        std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    });
    Ok(f(map, &file))
}

/// Everything already measured (still matching the files), for a quick start.
#[tauri::command]
pub fn loudness_known(app: AppHandle, state: tauri::State<'_, LoudnessCache>) -> Result<HashMap<String, Loudness>, String> {
    with_cache(&app, &state, |map, _| {
        map.iter()
            .filter(|(p, e)| stamp(Path::new(p)) == Some((e.size, e.mtime)))
            .map(|(p, e)| (p.clone(), Loudness { lufs: e.lufs, peak: e.peak }))
            .collect()
    })
}

/// Measures one song (or returns the saved result).
#[tauri::command]
pub async fn loudness_measure(app: AppHandle, state: tauri::State<'_, LoudnessCache>, path: String) -> Result<Loudness, String> {
    let p = PathBuf::from(&path);
    let st = stamp(&p).ok_or("That song file isn't there any more.")?;
    if let Some(hit) = with_cache(&app, &state, |map, _| map.get(&path).filter(|e| (e.size, e.mtime) == st).map(|e| Loudness { lufs: e.lufs, peak: e.peak }))? {
        return Ok(hit);
    }
    let r = crate::tools::resolve(&app)?;
    let exe = format!("ffmpeg{}", std::env::consts::EXE_SUFFIX);
    let ffmpeg = r.ffmpeg_dir.map(|d| d.join(&exe)).unwrap_or_else(|| PathBuf::from(exe));
    let out = crate::tools::command(&ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"])
        .arg(&p)
        .args(["-vn", "-ac", "2", "-ar", "48000", "-f", "f32le", "-"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("FFmpeg is needed to measure songs ({e})."))?;
    if out.stdout.len() < 8 {
        return Err(format!("Couldn't read the song: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let samples: Vec<f32> = out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let l = measure(&samples, 2, 48000.0);
    with_cache(&app, &state, |map, file| {
        map.insert(path.clone(), Entry { lufs: l.lufs, peak: l.peak, size: st.0, mtime: st.1 });
        // Forget songs that are gone, now and then.
        if map.len() % 50 == 0 {
            map.retain(|p, _| Path::new(p).exists());
        }
        if let Ok(text) = serde_json::to_vec(map) {
            let _ = std::fs::write(file, text);
        }
    })?;
    Ok(l)
}

/// One K-weighting stage (BS.1770), designed for the sample rate (as in libebur128).
struct Stage {
    b: [f64; 3],
    a: [f64; 2],
    z: Vec<[f64; 2]>,
}

impl Stage {
    fn shelf(rate: f64, ch: usize) -> Self {
        let (f0, g, q) = (1681.974450955533, 3.999843853973347, 0.7071752369554196);
        let k = (std::f64::consts::PI * f0 / rate).tan();
        let vh = 10f64.powf(g / 20.0);
        let vb = vh.powf(0.4996667741545416);
        let a0 = 1.0 + k / q + k * k;
        Stage {
            b: [(vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0],
            a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
            z: vec![[0.0; 2]; ch],
        }
    }
    fn highpass(rate: f64, ch: usize) -> Self {
        let (f0, q) = (38.13547087602444, 0.5003270373238773);
        let k = (std::f64::consts::PI * f0 / rate).tan();
        let a0 = 1.0 + k / q + k * k;
        Stage { b: [1.0, -2.0, 1.0], a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0], z: vec![[0.0; 2]; ch] }
    }
    /// Direct form II transposed.
    fn run(&mut self, x: f64, c: usize) -> f64 {
        let z = &mut self.z[c];
        let y = self.b[0] * x + z[0];
        z[0] = self.b[1] * x - self.a[0] * y + z[1];
        z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

/// Integrated loudness (gated, 400 ms blocks, 75% overlap) and sample peak of interleaved samples.
pub fn measure(samples: &[f32], channels: usize, rate: f64) -> Loudness {
    let ch = channels.max(1);
    let mut s1 = Stage::shelf(rate, ch);
    let mut s2 = Stage::highpass(rate, ch);
    let step = (rate * 0.1) as usize; // 100 ms
    let mut sums: Vec<f64> = Vec::new(); // energy per 100 ms
    let mut acc = 0.0;
    let mut n = 0usize;
    let mut peak = 0f64;
    for frame in samples.chunks_exact(ch) {
        for (c, &v) in frame.iter().enumerate() {
            let v = v as f64;
            peak = peak.max(v.abs());
            let y = s2.run(s1.run(v, c), c);
            acc += y * y;
        }
        n += 1;
        if n == step {
            sums.push(acc);
            acc = 0.0;
            n = 0;
        }
    }
    // 400 ms blocks from four 100 ms parts.
    let blocks: Vec<f64> = sums.windows(4).map(|w| w.iter().sum::<f64>() / (4 * step) as f64).collect();
    let lk = |z: f64| -0.691 + 10.0 * z.max(1e-12).log10();
    let abs: Vec<f64> = blocks.iter().copied().filter(|&z| lk(z) > -70.0).collect();
    if abs.is_empty() {
        return Loudness { lufs: -70.0, peak };
    }
    let rel = lk(abs.iter().sum::<f64>() / abs.len() as f64) - 10.0;
    let gated: Vec<f64> = abs.iter().copied().filter(|&z| lk(z) > rel).collect();
    let z = if gated.is_empty() { abs.iter().sum::<f64>() / abs.len() as f64 } else { gated.iter().sum::<f64>() / gated.len() as f64 };
    Loudness { lufs: lk(z), peak }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_a_tone_like_bs1770() {
        // A 1 kHz sine at -20 dBFS in both channels measures about -20 LUFS + 3 dB (two channels).
        let rate = 48000.0;
        let amp = 10f64.powf(-20.0 / 20.0);
        let s: Vec<f32> = (0..(rate as usize * 5))
            .flat_map(|i| {
                let v = (amp * (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / rate).sin()) as f32;
                [v, v]
            })
            .collect();
        let l = measure(&s, 2, rate);
        assert!((l.lufs - (-20.0 + 3.0 - 3.01 + 0.0)).abs() < 0.6, "{l:?}");
        assert!((l.peak - amp).abs() < 0.01);
        // Quieter song → lower loudness, by the same amount.
        let q: Vec<f32> = s.iter().map(|v| v * 0.5).collect();
        let lq = measure(&q, 2, rate);
        assert!((l.lufs - lq.lufs - 6.02).abs() < 0.1, "{l:?} {lq:?}");
    }
}
