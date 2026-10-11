//! YouTube streams its M4A audio "fragmented" (many small moof/mdat pieces).
//! Players can usually play that, but tag editors, length detection and some
//! players can't. This rebuilds such a file into an ordinary M4A: the same
//! audio frames, byte for byte, in one block with a normal sample table.
//! Nothing is re-encoded.

use std::fs;
use std::path::Path;

#[derive(Debug)]
struct BoxRef<'a> {
    kind: [u8; 4],
    start: usize,
    /// The whole box, header included.
    bytes: &'a [u8],
    header: usize,
}

impl<'a> BoxRef<'a> {
    fn body(&self) -> &'a [u8] {
        &self.bytes[self.header..]
    }
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn be64(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

/// Boxes directly inside `data` (which starts at absolute `base`).
fn children(data: &[u8], base: usize) -> Result<Vec<BoxRef<'_>>, String> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off + 8 <= data.len() {
        let size32 = be32(data, off).unwrap() as u64;
        let kind: [u8; 4] = data[off + 4..off + 8].try_into().unwrap();
        let (size, header) = match size32 {
            1 => (be64(data, off + 8).ok_or("truncated box")?, 16usize),
            0 => ((data.len() - off) as u64, 8usize),
            n => (n, 8usize),
        };
        let size = usize::try_from(size).map_err(|_| "box too large")?;
        if size < header || off + size > data.len() {
            return Err(format!("damaged box {}", String::from_utf8_lossy(&kind)));
        }
        out.push(BoxRef { kind, start: base + off, bytes: &data[off..off + size], header });
        off += size;
    }
    Ok(out)
}

fn find<'a>(boxes: &'a [BoxRef<'a>], kind: &[u8; 4]) -> Option<&'a BoxRef<'a>> {
    boxes.iter().find(|b| &b.kind == kind)
}

fn make_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(body.len() + 8);
    v.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
    v.extend_from_slice(kind);
    v.extend_from_slice(body);
    v
}

/// True if the file is a fragmented MP4 (has movie fragments).
pub fn is_fragmented(data: &[u8]) -> bool {
    let Ok(top) = children(data, 0) else { return false };
    let has_moof = top.iter().any(|b| &b.kind == b"moof");
    let mvex = find(&top, b"moov")
        .and_then(|m| children(m.body(), 0).ok())
        .is_some_and(|c| c.iter().any(|b| &b.kind == b"mvex"));
    has_moof || mvex
}

struct Sample {
    offset: usize,
    size: u32,
    duration: u32,
}

/// Rebuilds a fragmented single-track MP4 (an M4A) into a regular one.
pub fn defragment(data: &[u8]) -> Result<Vec<u8>, String> {
    let top = children(data, 0)?;
    let moov = find(&top, b"moov").ok_or("no moov box")?;
    let moov_kids = children(moov.body(), 0)?;
    let traks: Vec<&BoxRef> = moov_kids.iter().filter(|b| &b.kind == b"trak").collect();
    if traks.len() != 1 {
        return Err(format!("expected one track, found {}", traks.len()));
    }
    let trak = traks[0];
    let trak_kids = children(trak.body(), 0)?;
    let tkhd = find(&trak_kids, b"tkhd").ok_or("no tkhd")?.body();
    let track_id = if tkhd[0] == 1 { be32(tkhd, 20) } else { be32(tkhd, 12) }.ok_or("bad tkhd")?;

    // Defaults for the track from mvex/trex.
    let (mut def_dur, mut def_size) = (0u32, 0u32);
    if let Some(mvex) = find(&moov_kids, b"mvex") {
        for trex in children(mvex.body(), 0)?.iter().filter(|b| &b.kind == b"trex") {
            let t = trex.body();
            if be32(t, 4) == Some(track_id) {
                def_dur = be32(t, 12).unwrap_or(0);
                def_size = be32(t, 16).unwrap_or(0);
            }
        }
    }

    // Collect every sample from every fragment, in order.
    let mut samples: Vec<Sample> = Vec::new();
    for moof in top.iter().filter(|b| &b.kind == b"moof") {
        let moof_start = moof.start;
        for traf in children(moof.body(), 0)?.iter().filter(|b| &b.kind == b"traf") {
            let parts = children(traf.body(), 0)?;
            let tfhd = find(&parts, b"tfhd").ok_or("no tfhd")?.body();
            let flags = be32(tfhd, 0).ok_or("bad tfhd")? & 0x00ff_ffff;
            if be32(tfhd, 4) != Some(track_id) {
                continue;
            }
            let mut at = 8;
            let mut base = moof_start as u64;
            if flags & 0x01 != 0 {
                base = be64(tfhd, at).ok_or("bad tfhd")?;
                at += 8;
            }
            if flags & 0x02 != 0 {
                at += 4;
            }
            let (mut t_dur, mut t_size) = (def_dur, def_size);
            if flags & 0x08 != 0 {
                t_dur = be32(tfhd, at).ok_or("bad tfhd")?;
                at += 4;
            }
            if flags & 0x10 != 0 {
                t_size = be32(tfhd, at).ok_or("bad tfhd")?;
            }
            let mut next = base;
            for trun in parts.iter().filter(|b| &b.kind == b"trun") {
                let t = trun.body();
                let tflags = be32(t, 0).ok_or("bad trun")? & 0x00ff_ffff;
                let count = be32(t, 4).ok_or("bad trun")? as usize;
                let mut p = 8;
                if tflags & 0x01 != 0 {
                    let off = be32(t, p).ok_or("bad trun")? as i32 as i64;
                    next = (base as i64 + off) as u64;
                    p += 4;
                }
                if tflags & 0x04 != 0 {
                    p += 4;
                }
                for _ in 0..count {
                    let mut d = t_dur;
                    let mut s = t_size;
                    if tflags & 0x100 != 0 {
                        d = be32(t, p).ok_or("bad trun")?;
                        p += 4;
                    }
                    if tflags & 0x200 != 0 {
                        s = be32(t, p).ok_or("bad trun")?;
                        p += 4;
                    }
                    if tflags & 0x400 != 0 {
                        p += 4;
                    }
                    if tflags & 0x800 != 0 {
                        p += 4;
                    }
                    let offset = usize::try_from(next).map_err(|_| "bad offset")?;
                    if offset + s as usize > data.len() {
                        return Err("sample outside the file (download incomplete?)".into());
                    }
                    samples.push(Sample { offset, size: s, duration: d });
                    next += s as u64;
                }
            }
        }
    }
    if samples.is_empty() {
        return Err("no audio samples found".into());
    }

    // ---- new sample table ----
    let total: u64 = samples.iter().map(|s| s.duration as u64).sum();
    let mut stts_entries: Vec<(u32, u32)> = Vec::new();
    for s in &samples {
        match stts_entries.last_mut() {
            Some((n, d)) if *d == s.duration => *n += 1,
            _ => stts_entries.push((1, s.duration)),
        }
    }
    let mut stts = vec![0u8; 4];
    stts.extend_from_slice(&(stts_entries.len() as u32).to_be_bytes());
    for (n, d) in &stts_entries {
        stts.extend_from_slice(&n.to_be_bytes());
        stts.extend_from_slice(&d.to_be_bytes());
    }
    let mut stsc = vec![0u8; 4];
    stsc.extend_from_slice(&1u32.to_be_bytes());
    stsc.extend_from_slice(&1u32.to_be_bytes());
    stsc.extend_from_slice(&(samples.len() as u32).to_be_bytes());
    stsc.extend_from_slice(&1u32.to_be_bytes());
    let mut stsz = vec![0u8; 4];
    stsz.extend_from_slice(&0u32.to_be_bytes());
    stsz.extend_from_slice(&(samples.len() as u32).to_be_bytes());
    for s in &samples {
        stsz.extend_from_slice(&s.size.to_be_bytes());
    }

    // Timescales, to patch the durations.
    let mvhd_ts = {
        let m = find(&moov_kids, b"mvhd").ok_or("no mvhd")?.body();
        if m[0] == 1 { be32(m, 20) } else { be32(m, 12) }.ok_or("bad mvhd")?
    };
    let mdia = find(&trak_kids, b"mdia").ok_or("no mdia")?;
    let mdhd_ts = {
        let kids = children(mdia.body(), 0)?;
        let m = find(&kids, b"mdhd").ok_or("no mdhd")?.body();
        if m[0] == 1 { be32(m, 20) } else { be32(m, 12) }.ok_or("bad mdhd")?
    };
    let movie_dur = if mdhd_ts > 0 { total * mvhd_ts as u64 / mdhd_ts as u64 } else { 0 };

    // ---- rebuild moov (stco offset patched once sizes are known) ----
    let build = |chunk_offset: u32| -> Result<Vec<u8>, String> {
        let mut stco = vec![0u8; 4];
        stco.extend_from_slice(&1u32.to_be_bytes());
        stco.extend_from_slice(&chunk_offset.to_be_bytes());
        rebuild(moov.body(), b"moov", &|path, kind, body| {
            match kind {
                b"mvex" if path == "moov" => Edit::Drop,
                b"mvhd" => Edit::Replace(set_duration(body, movie_dur, 16, 24)),
                b"tkhd" => Edit::Replace(set_duration(body, movie_dur, 20, 28)),
                b"mdhd" => Edit::Replace(set_duration(body, total, 16, 24)),
                b"elst" => Edit::Replace(fix_elst(body, movie_dur)),
                b"stts" | b"stsc" | b"stsz" | b"stco" | b"co64" | b"stss" | b"ctts" | b"sdtp" | b"stz2" if path.ends_with("stbl") => {
                    Edit::Drop
                }
                _ => Edit::Keep,
            }
        }, &|path| {
            if path.ends_with("stbl") {
                vec![make_box(b"stts", &stts), make_box(b"stsc", &stsc), make_box(b"stsz", &stsz), make_box(b"stco", &stco)]
            } else {
                vec![]
            }
        })
    };
    let mut ftyp_body = Vec::new();
    ftyp_body.extend_from_slice(b"M4A ");
    ftyp_body.extend_from_slice(&0u32.to_be_bytes());
    for b in [b"M4A ", b"mp42", b"isom"] {
        ftyp_body.extend_from_slice(b);
    }
    let ftyp = make_box(b"ftyp", &ftyp_body);
    let audio_len: usize = samples.iter().map(|s| s.size as usize).sum();
    let moov_len = build(0)?.len();
    let offset = ftyp.len() + moov_len + 8;
    let new_moov = build(u32::try_from(offset).map_err(|_| "file too large")?)?;
    if new_moov.len() != moov_len {
        return Err("internal size mismatch".into());
    }

    let mut out = Vec::with_capacity(offset + audio_len);
    out.extend_from_slice(&ftyp);
    out.extend_from_slice(&new_moov);
    out.extend_from_slice(&u32::try_from(audio_len + 8).map_err(|_| "file too large")?.to_be_bytes());
    out.extend_from_slice(b"mdat");
    for s in &samples {
        out.extend_from_slice(&data[s.offset..s.offset + s.size as usize]);
    }
    Ok(out)
}

enum Edit {
    Keep,
    Drop,
    Replace(Vec<u8>),
    /// Replace with a box of another type.
    ReplaceAs([u8; 4], Vec<u8>),
}

const CONTAINERS: &[&[u8; 4]] = &[b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"dinf"];

/// Rewrites a container box tree, letting `edit` keep/drop/replace boxes and
/// `append` add boxes at the end of a container.
fn rebuild(
    body: &[u8],
    kind: &[u8; 4],
    edit: &dyn Fn(&str, &[u8; 4], &[u8]) -> Edit,
    append: &dyn Fn(&str) -> Vec<Vec<u8>>,
) -> Result<Vec<u8>, String> {
    fn walk(
        body: &[u8],
        path: &str,
        edit: &dyn Fn(&str, &[u8; 4], &[u8]) -> Edit,
        append: &dyn Fn(&str) -> Vec<Vec<u8>>,
    ) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        for b in children(body, 0)? {
            match edit(path, &b.kind, b.body()) {
                Edit::Drop => {}
                Edit::Replace(new_body) => out.extend(make_box(&b.kind, &new_body)),
                Edit::ReplaceAs(kind, new_body) => out.extend(make_box(&kind, &new_body)),
                Edit::Keep if CONTAINERS.contains(&&b.kind) => {
                    let child_path = format!("{path}/{}", String::from_utf8_lossy(&b.kind));
                    let inner = walk(b.body(), &child_path, edit, append)?;
                    out.extend(make_box(&b.kind, &inner));
                }
                Edit::Keep => out.extend_from_slice(b.bytes),
            }
        }
        for extra in append(path) {
            out.extend(extra);
        }
        Ok(out)
    }
    let path = String::from_utf8_lossy(kind).into_owned();
    Ok(make_box(kind, &walk(body, &path, edit, append)?))
}

/// Sets the duration field of mvhd/tkhd/mdhd (offset differs for version 0 and 1).
fn set_duration(body: &[u8], dur: u64, v0_at: usize, v1_at: usize) -> Vec<u8> {
    let mut b = body.to_vec();
    if b.first() == Some(&1) {
        if b.len() >= v1_at + 8 {
            b[v1_at..v1_at + 8].copy_from_slice(&dur.to_be_bytes());
        }
    } else if b.len() >= v0_at + 4 {
        b[v0_at..v0_at + 4].copy_from_slice(&(dur.min(u32::MAX as u64) as u32).to_be_bytes());
    }
    b
}

/// Edit-list entries with a zero length mean "until the end" in fragmented
/// files; in a regular file they need the real length.
fn fix_elst(body: &[u8], movie_dur: u64) -> Vec<u8> {
    let mut b = body.to_vec();
    let v1 = b.first() == Some(&1);
    let n = be32(&b, 4).unwrap_or(0) as usize;
    let entry = if v1 { 20 } else { 12 };
    for i in 0..n {
        let at = 8 + i * entry;
        if v1 {
            if be64(&b, at) == Some(0) && b.len() >= at + 8 {
                b[at..at + 8].copy_from_slice(&movie_dur.to_be_bytes());
            }
        } else if be32(&b, at) == Some(0) && b.len() >= at + 4 {
            b[at..at + 4].copy_from_slice(&(movie_dur.min(u32::MAX as u64) as u32).to_be_bytes());
        }
    }
    b
}

/// Where the chunk-offset tables (stco/co64) of every track are: (absolute
/// position of the first entry, entry count, 8-byte entries?), plus the size
/// of each track's last sample.
fn offset_tables<'a>(data: &'a [u8], moov: &BoxRef<'a>) -> Result<Vec<(usize, usize, bool, u64)>, String> {
    let mut out = Vec::new();
    let base = moov.start + moov.header;
    for trak in children(moov.body(), base)?.into_iter().filter(|b| &b.kind == b"trak") {
        let mut b: BoxRef<'a> = trak;
        for kind in [b"mdia", b"minf", b"stbl"] {
            let next = children(b.body(), b.start + b.header)?.into_iter().find(|k| &k.kind == kind);
            b = next.ok_or("no sample table")?;
        }
        let kids = children(b.body(), b.start + b.header)?;
        let last_size = match find(&kids, b"stsz") {
            Some(s) => {
                let body = s.body();
                let fixed = be32(body, 4).unwrap_or(0) as u64;
                let n = be32(body, 8).unwrap_or(0) as usize;
                if fixed > 0 || n == 0 { fixed } else { be32(body, 12 + (n - 1) * 4).unwrap_or(0) as u64 }
            }
            None => 0,
        };
        for k in &kids {
            let wide = match &k.kind {
                b"stco" => false,
                b"co64" => true,
                _ => continue,
            };
            let n = be32(k.body(), 4).ok_or("short offset table")? as usize;
            let first = k.start + k.header + 8;
            if first + n * if wide { 8 } else { 4 } > data.len() {
                return Err("short offset table".into());
            }
            out.push((first, n, wide, last_size));
        }
    }
    Ok(out)
}

/// Files whose tags were rewritten by a tool that moved the audio without
/// updating the sample table's chunk offsets: the player then reads the wrong
/// bytes and plays nothing. If every offset is off by the same amount and
/// shifting them puts all chunks back inside the audio block, returns the
/// fixed file (only the offset numbers change).
pub fn repair_offsets(data: &[u8]) -> Option<Vec<u8>> {
    let top = children(data, 0).ok()?;
    let moov = find(&top, b"moov")?;
    let mdats: Vec<(u64, u64)> =
        top.iter().filter(|b| &b.kind == b"mdat").map(|b| ((b.start + b.header) as u64, (b.start + b.bytes.len()) as u64)).collect();
    if mdats.len() != 1 {
        return None;
    }
    let (lo, hi) = mdats[0];
    let tables = offset_tables(data, moov).ok()?;
    if tables.is_empty() {
        return None;
    }
    let read = |at: usize, wide: bool| if wide { be64(data, at).unwrap() } else { be32(data, at).unwrap() as u64 };
    let mut all = Vec::new();
    for &(first, n, wide, _) in &tables {
        for i in 0..n {
            all.push(read(first + i * if wide { 8 } else { 4 }, wide));
        }
    }
    if all.is_empty() || all.iter().all(|&o| o >= lo && o < hi) {
        return None; // fine as it is
    }
    let min = *all.iter().min()?;
    let delta = lo as i64 - min as i64;
    let fits = |o: u64| {
        let s = o as i64 + delta;
        s >= lo as i64 && (s as u64) < hi
    };
    if !all.iter().all(|&o| fits(o)) {
        return None;
    }
    // The last chunk of each track must still end inside the audio block.
    for &(first, n, wide, last) in &tables {
        let o = read(first + (n - 1) * if wide { 8 } else { 4 }, wide) as i64 + delta;
        if n == 0 || o as u64 + last > hi {
            return None;
        }
    }
    let mut out = data.to_vec();
    for &(first, n, wide, _) in &tables {
        for i in 0..n {
            let at = first + i * if wide { 8 } else { 4 };
            let v = (read(at, wide) as i64 + delta) as u64;
            if wide {
                out[at..at + 8].copy_from_slice(&v.to_be_bytes());
            } else {
                out[at..at + 4].copy_from_slice(&u32::try_from(v).ok()?.to_be_bytes());
            }
        }
    }
    Some(out)
}

/// Tag editors (lofty among them) mishandle the 64-bit chunk-offset table
/// (co64) and can leave the audio pointing at the wrong place when they add a
/// cover. Files under 4 GB never need it, so this swaps it for the ordinary
/// 32-bit table (stco). The saved bytes become a `free` box right after the
/// movie header, so the audio doesn't move. Returns None if there's no co64.
pub fn narrow_co64(data: &[u8]) -> Option<Vec<u8>> {
    let top = children(data, 0).ok()?;
    let moov = find(&top, b"moov")?;
    let tables = offset_tables(data, moov).ok()?;
    if !tables.iter().any(|t| t.2) {
        return None;
    }
    let mut saved = 0usize;
    for &(first, n, wide, _) in &tables {
        if !wide {
            continue;
        }
        saved += 4 * n;
        for i in 0..n {
            u32::try_from(be64(data, first + i * 8)?).ok()?;
        }
    }
    let mdat_after = top.iter().any(|b| &b.kind == b"mdat" && b.start > moov.start);
    // A free box needs at least 8 bytes; with less, shift the offsets instead.
    let shift = if mdat_after && saved < 8 { saved as u64 } else { 0 };
    let edit = |_: &str, kind: &[u8; 4], body: &[u8]| {
        if kind != b"co64" {
            return Edit::Keep;
        }
        let n = be32(body, 4).unwrap_or(0) as usize;
        let mut b = body[..8].to_vec();
        for i in 0..n {
            let v = be64(body, 8 + i * 8).unwrap_or(0) - shift;
            b.extend_from_slice(&(v as u32).to_be_bytes());
        }
        Edit::ReplaceAs(*b"stco", b)
    };
    let new_moov = rebuild(moov.body(), b"moov", &edit, &|_| Vec::new()).ok()?;
    let mut out = Vec::with_capacity(data.len());
    out.extend_from_slice(&data[..moov.start]);
    out.extend_from_slice(&new_moov);
    if mdat_after && shift == 0 {
        let pad = moov.bytes.len() - new_moov.len();
        out.extend_from_slice(&make_box(b"free", &vec![0u8; pad - 8]));
    }
    out.extend_from_slice(&data[moov.start + moov.bytes.len()..]);
    Some(out)
}

/// True if the file's chunk offsets point outside its audio block (see `repair_offsets`).
#[cfg(test)]
pub fn offsets_broken(data: &[u8]) -> bool {
    let Ok(top) = children(data, 0) else { return false };
    let (Some(moov), Some(mdat)) = (find(&top, b"moov"), find(&top, b"mdat")) else { return false };
    let (lo, hi) = ((mdat.start + mdat.header) as u64, (mdat.start + mdat.bytes.len()) as u64);
    if top.iter().filter(|b| &b.kind == b"mdat").count() != 1 {
        return false;
    }
    let Ok(tables) = offset_tables(data, moov) else { return false };
    tables.iter().any(|&(first, n, wide, _)| {
        (0..n).any(|i| {
            let o = if wide { be64(data, first + i * 8).unwrap() } else { be32(data, first + i * 4).unwrap() as u64 };
            o < lo || o >= hi
        })
    })
}

/// Repairs an M4A in place (via a temp file and a rename): rebuilds a
/// fragmented file, or puts back chunk offsets that a tag edit left pointing
/// at the wrong place. Returns true if it changed the file.
pub fn fix_file(path: &Path) -> Result<bool, String> {
    let is_m4a = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("m4a") || e.eq_ignore_ascii_case("mp4"));
    if !is_m4a {
        return Ok(false);
    }
    let data = fs::read(path).map_err(|e| e.to_string())?;
    let fixed = if is_fragmented(&data) {
        defragment(&data)?
    } else {
        let repaired = repair_offsets(&data);
        let base = repaired.as_deref().unwrap_or(&data);
        match (narrow_co64(base), repaired.is_some()) {
            (Some(f), _) => f,
            (None, true) => repaired.unwrap(),
            (None, false) => return Ok(false),
        }
    };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!("{}{name}", crate::storage::TMP_PREFIX));
    fs::write(&tmp, &fixed).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    /// AURORA_FRAG_SAMPLE=path cargo test mp4fix -- --ignored
    /// (a fragmented .m4a, e.g. from ffmpeg -movflags +frag_keyframe+empty_moov+default_base_moof)
    #[test]
    #[ignore]
    fn rebuilds_sample() {
        let p = std::path::PathBuf::from(std::env::var("AURORA_FRAG_SAMPLE").unwrap());
        let data = std::fs::read(&p).unwrap();
        assert!(super::is_fragmented(&data));
        let out = super::defragment(&data).unwrap();
        assert!(!super::is_fragmented(&out));
        std::fs::write(p.with_extension("fixed.m4a"), out).unwrap();
    }

    #[test]
    fn plain_files_are_left_alone() {
        assert!(!super::is_fragmented(b"\x00\x00\x00\x10ftypM4A \x00\x00\x00\x00"));
        assert!(!super::is_fragmented(b"not an mp4 at all"));
    }
}

#[cfg(test)]
mod offset_tests {
    /// AURORA_BROKEN_SAMPLE=path cargo test offset_tests -- --ignored
    /// (an M4A whose chunk offsets were left pointing at the wrong place)
    #[test]
    #[ignore]
    fn repairs_sample() {
        let p = std::path::PathBuf::from(std::env::var("AURORA_BROKEN_SAMPLE").unwrap());
        let data = std::fs::read(&p).unwrap();
        assert!(super::offsets_broken(&data));
        let out = super::repair_offsets(&data).expect("repairable");
        assert!(!super::offsets_broken(&out));
        assert_eq!(out.len(), data.len());
        assert!(super::repair_offsets(&out).is_none());
        std::fs::write(p.with_extension("repaired.m4a"), &out).unwrap();
        let narrow = super::narrow_co64(&out).expect("has co64");
        assert!(!super::offsets_broken(&narrow));
        assert!(super::narrow_co64(&narrow).is_none());
        std::fs::write(p.with_extension("narrow.m4a"), narrow).unwrap();
    }
}

#[cfg(test)]
mod lofty_tests {
    /// AURORA_TAG_SAMPLE=path cargo test lofty_tests -- --ignored --nocapture
    /// Tags a copy the way downloads are tagged and reports whether the chunk offsets survive.
    #[test]
    #[ignore]
    fn tagging_keeps_offsets() {
        let src = std::path::PathBuf::from(std::env::var("AURORA_TAG_SAMPLE").unwrap());
        let p = src.with_extension("tagtest.m4a");
        std::fs::copy(&src, &p).unwrap();
        let meta = |album: Option<&str>| crate::yt::TagMeta {
            title: "T".into(), artist: "A".into(), album: album.map(Into::into), album_artist: None,
            track_no: Some(1), track_total: Some(2), year: Some(2007), cover_url: None,
        };
        let mut report = Vec::new();
        for (i, (cover, album)) in [(30_000usize, Some("X")), (120_000, Some("X")), (5_000, None), (200_000, Some("Y"))].into_iter().enumerate() {
            let r = crate::yt::write_tags(&p, &meta(album), Some(vec![0xFFu8; cover]));
            if album.is_none() { crate::yt::strip_album(&p); }
            let broken = super::offsets_broken(&std::fs::read(&p).unwrap());
            report.push(format!("step {i} cover {cover} -> {r:?} broken={broken}"));
        }
        println!("{}", report.join("\n"));
        assert!(!report.iter().any(|l| l.contains("broken=true")), "{report:?}");
    }
}
