// src-tauri/src/claude_cli.rs
// Tauri command that runs the Claude CLI (claude -p) in non-interactive mode.
// The user must have `claude` installed and logged in via `claude auth login`.
// This lets Enterprise subscribers use their subscription without needing an API key.

#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

/// Invoke the Claude CLI with a system prompt and user prompt, returning the text response.
///
/// Requires the `claude` CLI to be on PATH and authenticated.
/// Install: https://claude.ai/code
#[tauri::command]
pub async fn call_claude_cli(
    system_prompt: String,
    user_prompt: String,
    model: Option<String>,
) -> Result<String, String> {
    let model = model.unwrap_or_else(|| "sonnet".to_string());

    let mut cmd = tokio::process::Command::new("claude");
    cmd.args([
        "-p",
        &user_prompt,
        "--output-format",
        "text",
        "--system-prompt",
        &system_prompt,
        "--model",
        &model,
    ]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output().await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Claude CLI not found on PATH. Install it from https://claude.ai/code and run `claude auth login`.".to_string()
        } else {
            format!("Failed to launch Claude CLI: {e}")
        }
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Claude CLI sometimes puts error details in stdout
        let detail = if !stderr.trim().is_empty() { stderr } else { stdout };
        return Err(format!("Claude CLI exited with error: {}", detail.trim()));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err("Claude CLI returned an empty response.".to_string());
    }

    Ok(text)
}
