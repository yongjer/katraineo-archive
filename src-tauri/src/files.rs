//! File access for game records and the user config.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use encoding_rs::{Encoding, UTF_8};
use tauri::{AppHandle, Manager};

/// Decode a game record the way pysgf does: Fox/GIB/NGF are UTF-8, otherwise trust the SGF CA[] property,
/// and fall back to statistical detection.
pub fn decode_game_bytes(bytes: &[u8], filename: &str) -> String {
    let lower = filename.to_lowercase();
    let forced_utf8 = lower.ends_with(".gib") || lower.ends_with(".ngf") || contains(bytes, b"AP[foxwq]");
    let encoding: &'static Encoding = if forced_utf8 {
        UTF_8
    } else if let Some(label) = charset_property(bytes) {
        Encoding::for_label(label.trim().as_bytes()).unwrap_or_else(|| guess(bytes))
    } else {
        guess(bytes)
    };
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned()
}

fn guess(bytes: &[u8]) -> &'static Encoding {
    if std::str::from_utf8(bytes).is_ok() {
        return UTF_8;
    }
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    detector.guess(None, true)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn charset_property(bytes: &[u8]) -> Option<String> {
    let pos = bytes.windows(3).position(|w| w == b"CA[")?;
    let rest = &bytes[pos + 3..];
    let end = rest.iter().position(|&b| b == b']')?;
    Some(String::from_utf8_lossy(&rest[..end]).into_owned())
}

#[tauri::command]
pub fn read_game_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    Ok(decode_game_bytes(&bytes, &path))
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
        }
    }
    write_atomic(p, contents.as_bytes()).map_err(|e| format!("Could not write {path}: {e}"))
}

/// Write a file so that it is never left half written, e.g. when the app is killed or the disk fills up meanwhile:
/// the contents go to a temporary file next to it, which then replaces the file in one rename. A symbolic link is
/// followed, the file keeps its permissions, and a read-only file is not replaced (as writing it in place would fail).
pub fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    let target = match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    };
    let permissions = match fs::metadata(&target) {
        Ok(meta) if meta.permissions().readonly() => {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "the file is read-only"));
        }
        Ok(meta) => Some(meta.permissions()),
        Err(_) => None,
    };
    let dir = target.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = target.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a file name"))?;
    // unique within this process; the process id keeps other processes' (and crashed runs') files apart
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let tmp = dir.join(format!(
        ".{}.{}-{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let written = write_synced(&tmp, contents, permissions).and_then(|_| rename_replacing(&tmp, &target));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written?;
    // make the rename itself durable (a directory cannot be opened like this on Windows)
    #[cfg(unix)]
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

fn write_synced(path: &Path, contents: &[u8], permissions: Option<fs::Permissions>) -> io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(contents)?;
    file.sync_all()?;
    drop(file);
    match permissions {
        Some(p) => fs::set_permissions(path, p),
        None => Ok(()),
    }
}

/// Rename `from` over `to`. On Windows a virus scanner or the search indexer that has just opened the new file can
/// make that fail for a moment, so it is retried a few times there.
fn rename_replacing(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 0;
    loop {
        match fs::rename(from, to) {
            Err(e) if cfg!(windows) && e.kind() == io::ErrorKind::PermissionDenied && attempt < 5 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(20 * attempt));
            }
            result => return result,
        }
    }
}

/// Rename a file that could not be read to `<name>.broken.<ext>` next to it (`.broken-2` and so on if that exists),
/// so that it is not replaced when a new one is written. Returns its new path.
fn move_aside(path: &Path) -> io::Result<PathBuf> {
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let mut aside = path.with_file_name(format!("{stem}.broken{ext}"));
    let mut n = 2;
    while aside.exists() {
        aside = path.with_file_name(format!("{stem}.broken-{n}{ext}"));
        n += 1;
    }
    fs::rename(path, &aside)?;
    Ok(aside)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

/// The saved user config, or None on first start.
#[tauri::command]
pub fn load_config(app: AppHandle) -> Result<Option<String>, String> {
    let path = config_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

/// Keep a saved config that could not be read, before the next save replaces it. Returns where it is now.
#[tauri::command]
pub fn keep_unreadable_config(app: AppHandle) -> Result<String, String> {
    let path = config_path(&app)?;
    move_aside(&path)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("Could not rename {}: {e}", path.display()))
}

#[tauri::command]
pub fn save_config(app: AppHandle, contents: String) -> Result<(), String> {
    let path = config_path(&app)?;
    write_text_file(path.to_string_lossy().into_owned(), contents)
}

/// Download a game record for "paste a link to an SGF". Only http(s), at most 10 MB.
#[tauri::command]
pub async fn fetch_text(url: String) -> Result<String, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) links can be imported".into());
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("Katraineo/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{url} returned {}", res.status()));
    }
    if res.content_length().is_some_and(|n| n > 10 << 20) {
        return Err(format!("{url} is too large to be a game record"));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 10 << 20 {
        return Err(format!("{url} is too large to be a game record"));
    }
    Ok(decode_game_bytes(&bytes, &url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_and_charset() {
        assert_eq!(decode_game_bytes("(;PB[李])".as_bytes(), "a.sgf"), "(;PB[李])");
        let (gbk, _, _) = encoding_rs::GBK.encode("(;CA[GB2312]PB[李昌镐])");
        assert_eq!(decode_game_bytes(&gbk, "a.sgf"), "(;CA[GB2312]PB[李昌镐])");
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("(;PB[井山裕太]PW[張栩];B[pd];W[dp];B[pp];W[dd])");
        assert!(decode_game_bytes(&sjis, "a.sgf").contains("井山裕太"));
    }

    /// An empty folder for one test.
    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("katraineo-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn writes_and_replaces_files_without_leaving_temporary_ones() {
        let dir = folder("replace");
        let path = dir.join("config.json");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        assert_eq!(names(&dir), ["config.json"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn leaves_the_old_file_and_no_temporary_one_when_replacing_fails() {
        let dir = folder("fails");
        // a folder cannot be replaced by a file: the rename fails after the new contents are written
        let path = dir.join("game.sgf");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("inside"), "old").unwrap();
        assert!(write_atomic(&path, b"(;GM[1])").is_err());
        assert_eq!(fs::read_to_string(path.join("inside")).unwrap(), "old");
        assert_eq!(names(&dir), ["game.sgf"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn does_not_replace_a_read_only_file() {
        let dir = folder("readonly");
        let path = dir.join("game.sgf");
        fs::write(&path, "old").unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
        assert_eq!(write_atomic(&path, b"new").unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        assert_eq!(names(&dir), ["game.sgf"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_permissions_and_writes_through_symbolic_links() {
        use std::os::unix::fs::PermissionsExt;
        let dir = folder("links");
        let path = dir.join("config.json");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let link = dir.join("link.json");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        write_atomic(&link, b"new").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
        assert_eq!(names(&dir), ["config.json", "link.json"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn moves_an_unreadable_file_aside_without_replacing_an_earlier_one() {
        let dir = folder("aside");
        let path = dir.join("config.json");
        fs::write(&path, "{ broken").unwrap();
        assert_eq!(move_aside(&path).unwrap(), dir.join("config.broken.json"));
        fs::write(&path, "{ broken again").unwrap();
        assert_eq!(move_aside(&path).unwrap(), dir.join("config.broken-2.json"));
        assert_eq!(names(&dir), ["config.broken-2.json", "config.broken.json"]);
        assert_eq!(fs::read_to_string(dir.join("config.broken.json")).unwrap(), "{ broken");
        let _ = fs::remove_dir_all(&dir);
    }
}
