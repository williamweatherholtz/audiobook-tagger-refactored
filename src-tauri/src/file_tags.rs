// src-tauri/src/file_tags.rs
// Read embedded audio tags (ID3v2, MP4, Vorbis, FLAC, Opus) from audiobook files.
// Uses the `lofty` crate which handles all common audiobook formats.

use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::ItemKey;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct FileTags {
    pub path: String,
    pub filename: String,

    // Standard tags — field name reflects audiobook meaning, not raw tag name
    pub title: Option<String>,        // track title (often chapter/book title)
    pub artist: Option<String>,       // track artist (often the author)
    pub album: Option<String>,        // album (usually the book title)
    pub album_artist: Option<String>, // album artist (usually the author, more reliable)
    pub comment: Option<String>,
    pub year: Option<u32>,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub genre: Option<String>,
    pub composer: Option<String>,     // sometimes used for narrator in older rips
    pub copyright: Option<String>,
    pub description: Option<String>,  // long description / synopsis
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub narrator: Option<String>,     // from NARRATOR or ©nar or TPE3 tags

    // Audio properties
    pub duration_secs: Option<f64>,
    pub bit_rate_kbps: Option<u32>,
    pub sample_rate_hz: Option<u32>,
    pub channels: Option<u8>,
    pub file_size_bytes: Option<u64>,
}

fn get_str(tag: &lofty::tag::Tag, key: &ItemKey) -> Option<String> {
    tag.get_string(key)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn read_tags_inner(path: &str) -> Result<FileTags, String> {
    let path_obj = Path::new(path);
    let filename = path_obj
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let mut out = FileTags {
        path: path.to_string(),
        filename,
        ..Default::default()
    };

    if let Ok(meta) = std::fs::metadata(path) {
        out.file_size_bytes = Some(meta.len());
    }

    let tagged_file = Probe::open(path)
        .map_err(|e| format!("Cannot open {path}: {e}"))?
        .guess_file_type()
        .map_err(|e| format!("Cannot guess type for {path}: {e}"))?
        .read()
        .map_err(|e| format!("Cannot read tags for {path}: {e}"))?;

    // Audio properties
    let props = tagged_file.properties();
    out.duration_secs = Some(props.duration().as_secs_f64());
    out.bit_rate_kbps = props.audio_bitrate();
    out.sample_rate_hz = props.sample_rate();
    out.channels = props.channels();

    // Tag data — use primary tag, fall back to first available
    let tag = if let Some(t) = tagged_file.primary_tag() {
        t
    } else if let Some(t) = tagged_file.first_tag() {
        t
    } else {
        return Ok(out); // no tags at all
    };

    out.title = get_str(tag, &ItemKey::TrackTitle);
    out.artist = get_str(tag, &ItemKey::TrackArtist);
    out.album = get_str(tag, &ItemKey::AlbumTitle);
    out.album_artist = get_str(tag, &ItemKey::AlbumArtist);
    out.comment = get_str(tag, &ItemKey::Comment);
    out.composer = get_str(tag, &ItemKey::Composer);
    out.genre = get_str(tag, &ItemKey::Genre);
    out.copyright = get_str(tag, &ItemKey::CopyrightMessage);
    out.publisher = get_str(tag, &ItemKey::Label);
    out.language = get_str(tag, &ItemKey::Language);
    out.description = get_str(tag, &ItemKey::Description);

    // Year — try typed accessor first, then string
    out.year = tag.year().or_else(|| {
        get_str(tag, &ItemKey::Year)
            .and_then(|s| s.chars().take(4).collect::<String>().parse().ok())
    });

    out.track_number = tag.track();
    out.disc_number = tag.disk();

    // Narrator — check several common tag locations in order of reliability
    //
    // 1. NARRATOR custom tag (Vorbis, some MP4 taggers)
    out.narrator = get_str(tag, &ItemKey::Unknown("NARRATOR".to_string()));

    // 2. TPE3 / Conductor (used by some rippers to store narrator)
    if out.narrator.is_none() {
        out.narrator = get_str(tag, &ItemKey::Conductor);
    }

    // 3. Scan the comment field for "Narrator: ..." text
    if out.narrator.is_none() {
        if let Some(ref comment) = out.comment {
            let lc = comment.to_lowercase();
            if let Some(pos) = lc.find("narrator:") {
                let after = &comment[pos + "narrator:".len()..];
                let name = after
                    .split(&['\n', '\r', ',', ';'][..])
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !name.is_empty() {
                    out.narrator = Some(name);
                }
            }
        }
    }

    Ok(out)
}

/// Read embedded audio tags for all files in a book group.
/// Returns one `FileTags` record per path. Files that fail are returned with minimal info
/// (path + filename only) so the caller can still use the results from other files.
#[tauri::command]
pub async fn read_book_tags(file_paths: Vec<String>) -> Result<Vec<FileTags>, String> {
    let mut results = Vec::with_capacity(file_paths.len());
    for path in &file_paths {
        match read_tags_inner(path) {
            Ok(t) => results.push(t),
            Err(e) => {
                eprintln!("read_book_tags: {e}");
                results.push(FileTags {
                    path: path.clone(),
                    filename: Path::new(path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string(),
                    ..Default::default()
                });
            }
        }
    }
    Ok(results)
}
