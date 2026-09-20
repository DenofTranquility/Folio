#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod document;

use document::Document;
use std::path::PathBuf;

#[tauri::command]
fn initial_path() -> Option<String> {
    std::env::args_os()
        .nth(1)
        .map(|s| s.to_string_lossy().into_owned())
}

#[tauri::command]
async fn pick_file() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Open a Markdown document")
            .add_filter(
                "Markdown & text",
                &["md", "markdown", "mdown", "mkd", "mdx", "txt"],
            )
            .add_filter("All files", &["*"])
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_document(path: String) -> Result<Document, String> {
    tauri::async_runtime::spawn_blocking(move || document::load(&PathBuf::from(path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn modified(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || document::stamp(&PathBuf::from(path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn resolve_link(base: String, target: String) -> Result<String, String> {
    document::resolve_local(&PathBuf::from(base), &target).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_external(target: String) -> Result<(), String> {
    let url = url::Url::parse(&target).map_err(|_| "This link is not a valid URL.")?;
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return Err("Only web and email links can be opened externally.".into());
    }
    webbrowser::open(url.as_str()).map_err(|e| format!("Could not open the link: {e}"))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            initial_path,
            pick_file,
            open_document,
            modified,
            resolve_link,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("Folio could not start. Check that Microsoft Edge WebView2 is installed.");
}
