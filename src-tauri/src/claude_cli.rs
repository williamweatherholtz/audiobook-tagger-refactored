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
///
/// On Windows, `claude` is installed as a `.cmd` batch file (e.g. by npm or the Claude Code
/// installer). `Command::new("claude")` can only spawn `.exe` files directly — `.cmd` files
/// require the shell (`cmd.exe`) to execute them. We therefore route through `cmd /c` on
/// Windows, which also picks up any user-level PATH entries that a GUI app might not inherit.
#[tauri::command]
pub async fn call_claude_cli(
    system_prompt: String,
    user_prompt: String,
    model: Option<String>,
) -> Result<String, String> {
    let model = model.unwrap_or_else(|| "sonnet".to_string());

    // Build the command differently per platform.
    // Windows: spawn via `cmd /c` so the shell resolves .cmd files and user-level PATH.
    //   IMPORTANT: We pass `-p -` (stdin mode) instead of `-p "<prompt>"` because
    //   cmd.exe parses embedded `"` characters as argument delimiters, truncating any
    //   multi-KB prompt that contains escaped quotes (e.g. from book descriptions).
    //   Writing the prompt to stdin bypasses all shell argument escaping issues.
    // Unix/macOS: spawn `claude` directly; also use stdin to avoid shell quoting issues
    //   with very long prompts.
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args([
            "/c",
            "claude",
            "-p",
            "-", // read user prompt from stdin
            "--output-format",
            "text",
            "--system-prompt",
            &system_prompt,
            "--model",
            &model,
        ]);
        c.stdin(std::process::Stdio::piped());
        // Suppress the console window that would otherwise flash when cmd.exe starts.
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    };

    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("claude");
        c.args([
            "-p",
            "-", // read user prompt from stdin
            "--output-format",
            "text",
            "--system-prompt",
            &system_prompt,
            "--model",
            &model,
        ]);
        c.stdin(std::process::Stdio::piped());
        c
    };

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        // On Windows we're spawning cmd.exe itself, so NotFound here means cmd.exe is missing —
        // extremely unlikely. The more common "claude not found" case surfaces as a non-zero
        // exit code with a descriptive stderr message, handled below.
        format!("Failed to launch Claude CLI: {e}")
    })?;

    // Write the user prompt to stdin, then close the pipe so the CLI sees EOF.
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(user_prompt.as_bytes()).await.map_err(|e| {
            format!("Failed to write prompt to Claude CLI stdin: {e}")
        })?;
        // Drop closes the pipe → EOF signal to the child process.
    }

    let output = child.wait_with_output().await.map_err(|e| {
        format!("Failed to wait for Claude CLI: {e}")
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Claude CLI (and cmd.exe on Windows) sometimes put error details in stdout.
        let detail = if !stderr.trim().is_empty() { stderr } else { stdout };
        let msg = detail.trim();

        // Surface a friendly message for the common "command not found" case on Windows.
        if msg.contains("is not recognized") || msg.contains("cannot find") || msg.is_empty() {
            return Err(
                "Claude CLI not found. Install it from https://claude.ai/code, then run \
                 `claude auth login` in a terminal. Make sure the installation directory \
                 is in your PATH (restart the app after installing)."
                    .to_string(),
            );
        }

        return Err(format!("Claude CLI exited with error: {msg}"));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err("Claude CLI returned an empty response.".to_string());
    }

    Ok(text)
}
