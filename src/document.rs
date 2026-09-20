use base64::{Engine, engine::general_purpose::STANDARD};
use pulldown_cmark::{CowStr, Event, Options, Parser, Tag, TagEnd, html};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const MAX_DOCUMENT: u64 = 20 * 1024 * 1024;
const MAX_IMAGE: u64 = 8 * 1024 * 1024;
const IMAGE_BUDGET: usize = 24 * 1024 * 1024;

#[derive(Serialize)]
pub struct Document {
    path: String,
    name: String,
    html: String,
    words: usize,
    bytes: usize,
    modified: String,
}

pub fn stamp(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Cannot access this file: {e}"))?;
    let time = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    Ok(format!("{time}:{}", meta.len()))
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file =
        fs::File::open(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Choose a Markdown file, rather than a folder.".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(format!(
            "This file exceeds the {} MB limit.",
            limit / 1024 / 1024
        ));
    }
    Ok(bytes)
}

fn decode(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if bytes.len() % 2 != 0 {
            return Err("This UTF-16 file has an incomplete character.".into());
        }
        let little = bytes[0] == 0xff;
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|b| {
                if little {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect();
        return String::from_utf16(&units)
            .map_err(|_| "This file contains invalid UTF-16 text.".into());
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "This is not a UTF-8 or UTF-16 text file. Save it as UTF-8 and try again.")?;
    if text.contains('\0') {
        return Err("This appears to be a binary file. Choose a Markdown or text file.".into());
    }
    Ok(text.trim_start_matches('\u{feff}').to_owned())
}

pub fn load(path: &Path) -> Result<Document, String> {
    let path = path
        .canonicalize()
        .map_err(|e| format!("Could not find this document: {e}"))?;
    let modified = stamp(&path)?;
    let bytes = read_limited(&path, MAX_DOCUMENT)?;
    let text = decode(&bytes)?;
    let (html, words) = render(&text, &path);
    Ok(Document {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        html,
        words,
        bytes: bytes.len(),
        modified,
    })
}

pub fn resolve_local(base: &Path, target: &str) -> Result<PathBuf, String> {
    // Resolve URL escapes and relative paths without interpreting shell commands.
    if target.starts_with("\\\\") || target.starts_with("//") {
        return Err("Network file links are not supported. Open a local copy instead.".into());
    }
    let base_url = url::Url::from_file_path(base).map_err(|_| "The document path is invalid.")?;
    let mut joined = base_url
        .join(target)
        .map_err(|_| "The linked path is invalid.")?;
    if joined.scheme() != "file"
        || joined
            .host_str()
            .is_some_and(|h| !h.is_empty() && h != "localhost")
    {
        return Err("This is not a local file link.".into());
    }
    joined.set_fragment(None);
    joined.set_query(None);
    joined
        .to_file_path()
        .map_err(|_| "The linked path is invalid.".into())
}

fn image_uri(base: &Path, source: &str, budget: &mut usize) -> Option<String> {
    let path = resolve_local(base, source).ok()?;
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        _ => return None,
    };
    let bytes = read_limited(
        &path,
        MAX_IMAGE.min(IMAGE_BUDGET.saturating_sub(*budget) as u64),
    )
    .ok()?;
    *budget += bytes.len();
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn slug(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter_map(|c| {
            if c.is_whitespace() {
                Some('-')
            } else if c.is_alphanumeric() || c == '-' || c == '_' {
                Some(c)
            } else {
                None
            }
        })
        .collect()
}

pub fn render(text: &str, base: &Path) -> (String, usize) {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_SMART_PUNCTUATION
        | Options::ENABLE_GFM;
    let mut events: Vec<Event<'_>> = Parser::new_ext(text, options).collect();
    let mut slugs = HashMap::<String, usize>::new();
    let mut budget = 0;
    let mut words = 0;
    for i in 0..events.len() {
        if matches!(events[i], Event::Start(Tag::Heading { .. })) {
            let title: String = events[i + 1..]
                .iter()
                .take_while(|e| !matches!(e, Event::End(TagEnd::Heading(_))))
                .filter_map(|e| match e {
                    Event::Text(t) | Event::Code(t) => Some(t.as_ref()),
                    _ => None,
                })
                .collect();
            let mut id = slug(&title);
            if id.is_empty() {
                id = "section".into();
            }
            // Reserve every generated ID, including suffixes, to prevent collisions.
            let root = id.clone();
            let mut suffix = 0;
            while slugs.contains_key(&id) {
                suffix += 1;
                id = format!("{root}-{suffix}");
            }
            slugs.insert(id.clone(), 1);
            if let Event::Start(Tag::Heading { id: heading_id, .. }) = &mut events[i] {
                *heading_id = Some(CowStr::from(id));
            }
        }
        if let Event::Start(Tag::Image { dest_url, .. }) = &mut events[i] {
            if !dest_url.starts_with("https://") && !dest_url.starts_with("http://") {
                *dest_url =
                    CowStr::from(image_uri(base, dest_url, &mut budget).unwrap_or_default());
            }
        }
        if let Event::Text(t) | Event::Code(t) = &events[i] {
            words += t.split_whitespace().count();
        }
    }
    let mut output = String::with_capacity(text.len() + text.len() / 2);
    html::push_html(&mut output, events.into_iter());
    let safe = ammonia::Builder::default()
        .add_tags(&["input"])
        .add_tag_attributes("input", &["type", "checked", "disabled"])
        .add_tag_attributes("a", &["id"])
        .add_tag_attributes("sup", &["id"])
        .add_tag_attributes("div", &["class", "id"])
        .add_tag_attributes("code", &["class"])
        .add_tag_attributes("th", &["align"])
        .add_tag_attributes("td", &["align"])
        .add_tag_attributes("h1", &["id"])
        .add_tag_attributes("h2", &["id"])
        .add_tag_attributes("h3", &["id"])
        .add_tag_attributes("h4", &["id"])
        .add_tag_attributes("h5", &["id"])
        .add_tag_attributes("h6", &["id"])
        .add_url_schemes(&["data"])
        .clean(&output)
        .to_string();
    (safe, words)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_gfm_and_unique_headings() {
        let (html, _) = render(
            "# Hello\n# Hello\n# Hello-1\n\n- [x] Done\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n~~gone~~",
            Path::new("C:\\test.md"),
        );
        for expected in [
            "id=\"hello\"",
            "id=\"hello-1\"",
            "id=\"hello-1-1\"",
            "<table>",
            "<del>gone</del>",
            "checked",
        ] {
            assert!(html.contains(expected), "Missing {expected}: {html}");
        }
        let (footnote, _) = render("A note.[^a]\n\n[^a]: Details.", Path::new("C:\\test.md"));
        assert!(footnote.contains("href=\"#a\""));
        assert!(footnote.contains("id=\"a\""));
    }

    #[test]
    fn untrusted_markdown_cannot_run_scripts() {
        let (html, _) = render(
            "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29)\n\n<iframe src='https://example.com'></iframe>",
            Path::new("C:\\test.md"),
        );
        for unsafe_text in ["<script", "onerror", "javascript:", "<iframe"] {
            assert!(!html.contains(unsafe_text));
        }
    }

    #[test]
    fn decodes_text_and_rejects_binary() {
        assert_eq!(decode(&[0xff, 0xfe, 0x48, 0, 0x69, 0]).unwrap(), "Hi");
        assert_eq!(decode(b"\xef\xbb\xbfHello").unwrap(), "Hello");
        assert!(decode(b"a\0b").is_err());
        assert!(decode(&[0xff, 0xfe, 0]).is_err());
    }

    #[test]
    fn local_links_decode_without_allowing_remote_shares() {
        let base = if cfg!(windows) {
            Path::new("C:\\docs\\guide.md")
        } else {
            Path::new("/docs/guide.md")
        };
        assert!(
            resolve_local(base, "chapter%20one.md#start")
                .unwrap()
                .ends_with("chapter one.md")
        );
        assert!(resolve_local(base, "https://example.com/x.md").is_err());
        assert!(resolve_local(base, "file://server/private.md").is_err());
    }
}
