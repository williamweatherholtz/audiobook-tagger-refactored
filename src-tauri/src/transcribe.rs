// src-tauri/src/transcribe.rs
// Transcribe the first and last N seconds of an audiobook using Whisper.
//
// Pipeline:
//   1. ffmpeg extracts first/last segment from audio files → temp 16kHz mono WAV
//   2. whisper CLI (openai-whisper or whisper.cpp) transcribes each WAV → text
//
// Supported whisper implementations:
//   - "openai"  — `whisper file.wav --model large-v3 --output_format txt ...`
//                  Install: pip install openai-whisper
//   - "cpp"     — `whisper-cli -m model.bin -f file.wav --output-txt -l en`
//                  Install: https://github.com/ggerganov/whisper.cpp (prebuilt releases)
//   - "auto"    — tries openai-whisper first, falls back to whisper-cli/whisper.cpp binary names
//
// ffmpeg is required for segment extraction (usually pre-installed or available via ffmpeg.org).

use serde::{Deserialize, Serialize};
use std::path::Path;
use tempfile::TempDir;
use tokio::process::Command;

#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

// ─── Public types ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranscribeConfig {
    /// Path to whisper binary. Auto-detected from PATH when None.
    pub whisper_path: Option<String>,
    /// "openai" | "cpp" | "auto". Default "auto".
    pub whisper_mode: Option<String>,
    /// Model name for openai-whisper (e.g. "large-v3", "medium", "base"). Default "large-v3".
    pub whisper_model_name: Option<String>,
    /// Path to ggml model file for whisper.cpp mode (required when mode = "cpp").
    pub whisper_model_path: Option<String>,
    /// Language code ("en", "auto", etc.). Default "en".
    pub language: Option<String>,
    /// How many seconds to capture from the start and end. Default 90.
    pub segment_secs: Option<u32>,
    /// Path to ffmpeg binary. Auto-detected from PATH when None.
    pub ffmpeg_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TranscriptResult {
    pub beginning: Option<String>,
    pub ending: Option<String>,
    pub beginning_file: String,
    pub ending_file: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolDetectResult {
    pub ffmpeg: Option<String>,
    pub whisper: Option<String>,
    pub whisper_mode: Option<String>, // "openai" or "cpp"
}

// ─── Tool detection ──────────────────────────────────────────────────────────

/// Check if a binary exists on PATH (or at an absolute path) and return its resolved path.
async fn which_tool(name: &str) -> Option<String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/c", "where", name]);
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("which");
        c.arg(name);
        c
    };

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());

    if let Ok(out) = cmd.output().await {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    None
}

/// Detect available transcription and extraction tools.
#[tauri::command]
pub async fn detect_transcription_tools() -> Result<ToolDetectResult, String> {
    // ffmpeg — try "ffmpeg" then "ffprobe" directory
    let ffmpeg = which_tool("ffmpeg").await;

    // whisper — try common binary names
    let (whisper, whisper_mode) = if let Some(p) = which_tool("whisper").await {
        (Some(p), Some("openai".to_string()))
    } else if let Some(p) = which_tool("whisper-cli").await {
        (Some(p), Some("cpp".to_string()))
    } else if let Some(p) = which_tool("main").await {
        // whisper.cpp compiled binary often named "main" — only include if in a whisper-looking path
        if p.to_lowercase().contains("whisper") {
            (Some(p), Some("cpp".to_string()))
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    Ok(ToolDetectResult { ffmpeg, whisper, whisper_mode })
}

// ─── FFmpeg extraction ───────────────────────────────────────────────────────

/// Extract a time segment from an audio file to a 16kHz mono WAV.
/// `start` is offset from start (for beginning segment) or from end in seconds if negative (not supported here —
/// we always pass a positive start and duration).
async fn extract_segment(
    ffmpeg: &str,
    input: &str,
    output: &str,
    start_secs: f64,
    duration_secs: f64,
) -> Result<(), String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args([
            "/c", ffmpeg,
            "-y",               // overwrite output
            "-ss", &start_secs.to_string(),
            "-i", input,
            "-t", &duration_secs.to_string(),
            "-vn",              // no video
            "-acodec", "pcm_s16le",
            "-ar", "16000",     // 16kHz — whisper's preferred sample rate
            "-ac", "1",         // mono
            output,
        ]);
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new(ffmpeg);
        c.args([
            "-y",
            "-ss", &start_secs.to_string(),
            "-i", input,
            "-t", &duration_secs.to_string(),
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", "16000",
            "-ac", "1",
            output,
        ]);
        c
    };

    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::piped());

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("ffmpeg launch failed: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ffmpeg error: {}", stderr.trim()));
    }
    Ok(())
}

/// Get the duration of an audio file using ffprobe (same binary dir as ffmpeg).
async fn get_duration(ffmpeg: &str, input: &str) -> Option<f64> {
    // Derive ffprobe path from ffmpeg path
    let ffprobe = if ffmpeg.ends_with("ffmpeg") || ffmpeg.ends_with("ffmpeg.exe") {
        ffmpeg.replace("ffmpeg", "ffprobe")
    } else {
        "ffprobe".to_string()
    };

    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args([
            "/c", &ffprobe,
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            input,
        ]);
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new(&ffprobe);
        c.args([
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            input,
        ]);
        c
    };

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());

    let out = cmd.output().await.ok()?;
    if out.status.success() {
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse::<f64>()
            .ok()
    } else {
        None
    }
}

// ─── Whisper transcription ────────────────────────────────────────────────────

async fn transcribe_wav(
    whisper: &str,
    mode: &str,
    wav_path: &str,
    model_name: &str,
    model_path: &str,
    language: &str,
    work_dir: &str,
) -> Result<String, String> {
    match mode {
        "openai" => transcribe_openai(whisper, wav_path, model_name, language, work_dir).await,
        "cpp" => transcribe_cpp(whisper, wav_path, model_path, language, work_dir).await,
        _ => {
            // Try openai-whisper flags first, then cpp flags
            match transcribe_openai(whisper, wav_path, model_name, language, work_dir).await {
                Ok(t) => Ok(t),
                Err(_) => transcribe_cpp(whisper, wav_path, model_path, language, work_dir).await,
            }
        }
    }
}

/// Transcribe using openai-whisper CLI.
async fn transcribe_openai(
    whisper: &str,
    wav_path: &str,
    model_name: &str,
    language: &str,
    work_dir: &str,
) -> Result<String, String> {
    let lang_args: Vec<&str> = if language == "auto" || language.is_empty() {
        vec![]
    } else {
        vec!["--language", language]
    };

    #[cfg(windows)]
    let mut cmd = {
        let mut base_args = vec![
            "/c", whisper,
            wav_path,
            "--model", model_name,
            "--output_format", "txt",
            "--output_dir", work_dir,
            "--fp16", "False",  // CPU-safe
        ];
        base_args.extend_from_slice(&lang_args);
        let mut c = Command::new("cmd");
        c.args(base_args);
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut base_args = vec![
            wav_path,
            "--model", model_name,
            "--output_format", "txt",
            "--output_dir", work_dir,
            "--fp16", "False",
        ];
        base_args.extend_from_slice(&lang_args);
        let mut c = Command::new(whisper);
        c.args(base_args);
        c
    };

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("whisper launch failed: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("whisper error: {}", stderr.trim()));
    }

    // openai-whisper writes: <work_dir>/<stem>.txt
    let stem = Path::new(wav_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("audio");
    let txt_path = format!("{work_dir}/{stem}.txt");
    std::fs::read_to_string(&txt_path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("Cannot read whisper output {txt_path}: {e}"))
}

/// Transcribe using whisper.cpp CLI (`whisper-cli`).
async fn transcribe_cpp(
    whisper: &str,
    wav_path: &str,
    model_path: &str,
    language: &str,
    work_dir: &str,
) -> Result<String, String> {
    if model_path.is_empty() {
        return Err("whisper.cpp mode requires a model path (ggml-large-v3.bin)".to_string());
    }

    // whisper.cpp: output is <input_file>.txt in same dir unless --output-file given
    let out_base = format!("{work_dir}/segment");

    let lang_flag = if language == "auto" || language.is_empty() {
        "auto".to_string()
    } else {
        language.to_string()
    };

    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args([
            "/c", whisper,
            "-m", model_path,
            "-f", wav_path,
            "--output-txt",
            "--output-file", &out_base,
            "-l", &lang_flag,
        ]);
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new(whisper);
        c.args([
            "-m", model_path,
            "-f", wav_path,
            "--output-txt",
            "--output-file", &out_base,
            "-l", &lang_flag,
        ]);
        c
    };

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("whisper-cli launch failed: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("whisper-cli error: {}", stderr.trim()));
    }

    let txt_path = format!("{out_base}.txt");
    std::fs::read_to_string(&txt_path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("Cannot read whisper-cli output {txt_path}: {e}"))
}

// ─── Main command ─────────────────────────────────────────────────────────────

/// Transcribe the first and last N seconds of an audiobook.
///
/// `file_paths` should be all files in the book group, sorted in play order (as returned by
/// the scanner). The first file provides the beginning segment, the last provides the ending.
#[tauri::command]
pub async fn transcribe_book(
    file_paths: Vec<String>,
    config: TranscribeConfig,
) -> Result<TranscriptResult, String> {
    if file_paths.is_empty() {
        return Err("No files provided".to_string());
    }

    let seg_secs = config.segment_secs.unwrap_or(90) as f64;
    let language = config.language.clone().unwrap_or_else(|| "en".to_string());
    let model_name = config.whisper_model_name.clone().unwrap_or_else(|| "large-v3".to_string());
    let model_path = config.whisper_model_path.clone().unwrap_or_default();
    let mode = config.whisper_mode.clone().unwrap_or_else(|| "auto".to_string());

    // Resolve tool paths
    let ffmpeg = if let Some(ref p) = config.ffmpeg_path {
        p.clone()
    } else {
        which_tool("ffmpeg").await.ok_or_else(|| {
            "ffmpeg not found. Install from https://ffmpeg.org or set ffmpeg_path in Settings.".to_string()
        })?
    };

    let whisper = if let Some(ref p) = config.whisper_path {
        p.clone()
    } else {
        // Try common binary names in order
        let w = which_tool("whisper").await;
        let w = if w.is_some() { w } else { which_tool("whisper-cli").await };
        w.ok_or_else(|| {
            "Whisper not found. Install openai-whisper (`pip install openai-whisper`) or \
             whisper.cpp, then set the path in Settings > Transcription.".to_string()
        })?
    };

    // Work directory for temp files
    let work_dir = TempDir::new().map_err(|e| format!("Cannot create temp dir: {e}"))?;
    let work_path = work_dir.path().to_string_lossy().to_string();

    let first_file = &file_paths[0];
    let last_file = file_paths.last().unwrap(); // safe — checked empty above

    let beginning_filename = Path::new(first_file)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(first_file)
        .to_string();
    let ending_filename = Path::new(last_file)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(last_file)
        .to_string();

    // ── Beginning segment ──────────────────────────────────────────────────
    let beginning_wav = format!("{work_path}/beginning.wav");
    let beginning = match extract_segment(&ffmpeg, first_file, &beginning_wav, 0.0, seg_secs).await {
        Ok(()) => match transcribe_wav(
            &whisper, &mode, &beginning_wav, &model_name, &model_path, &language, &work_path,
        )
        .await
        {
            Ok(t) => Some(t),
            Err(e) => {
                eprintln!("Transcribe beginning error: {e}");
                None
            }
        },
        Err(e) => {
            eprintln!("Extract beginning error: {e}");
            None
        }
    };

    // ── Ending segment ─────────────────────────────────────────────────────
    // Find the last `seg_secs` of the last file. Need the file duration.
    let ending = if first_file == last_file && seg_secs * 2.0 > 60.0 {
        // Single-file book: avoid re-transcribing the same region
        let file_duration = get_duration(&ffmpeg, last_file).await.unwrap_or(0.0);
        let end_start = (file_duration - seg_secs).max(seg_secs);
        if end_start <= 0.0 {
            None // short file, beginning covers it all
        } else {
            let ending_wav = format!("{work_path}/ending.wav");
            match extract_segment(&ffmpeg, last_file, &ending_wav, end_start, seg_secs).await {
                Ok(()) => match transcribe_wav(
                    &whisper, &mode, &ending_wav, &model_name, &model_path, &language, &work_path,
                )
                .await
                {
                    Ok(t) => Some(t),
                    Err(e) => {
                        eprintln!("Transcribe ending error: {e}");
                        None
                    }
                },
                Err(e) => {
                    eprintln!("Extract ending error: {e}");
                    None
                }
            }
        }
    } else {
        // Multi-file book: take ending from last file
        let file_duration = get_duration(&ffmpeg, last_file).await.unwrap_or(seg_secs);
        let end_start = (file_duration - seg_secs).max(0.0);
        let ending_wav = format!("{work_path}/ending.wav");
        match extract_segment(&ffmpeg, last_file, &ending_wav, end_start, seg_secs).await {
            Ok(()) => match transcribe_wav(
                &whisper, &mode, &ending_wav, &model_name, &model_path, &language, &work_path,
            )
            .await
            {
                Ok(t) => Some(t),
                Err(e) => {
                    eprintln!("Transcribe ending error: {e}");
                    None
                }
            },
            Err(e) => {
                eprintln!("Extract ending error: {e}");
                None
            }
        }
    };

    Ok(TranscriptResult {
        beginning,
        ending,
        beginning_file: beginning_filename,
        ending_file: ending_filename,
        error: None,
    })
}
