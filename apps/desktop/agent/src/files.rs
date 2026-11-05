//! Files in and out: into ~/Downloads/Hatbot unless the brain names a path (which the owner approved
//! there), and any of the owner's files out.

use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

/// The brain's attachment limit.
pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| "/".into())
}

/// "~/x" and "x" are the owner's home's.
pub fn expand(path: &str, home: &Path) -> PathBuf {
    match path.strip_prefix("~") {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => home.join(rest.trim_start_matches('/')),
        _ if Path::new(path).is_absolute() => PathBuf::from(path),
        _ => home.join(path),
    }
}

/// A file name that stays in its folder.
fn safe_name(name: &str) -> Result<String, String> {
    let base = name.rsplit('/').next().unwrap_or("").trim();
    if base.is_empty() || base == "." || base == ".." || base.contains('\0') {
        return Err("That file name can't be used.".into());
    }
    Ok(base.to_owned())
}

/// "a.pdf", then "a (1).pdf", so nothing already there is overwritten.
fn free(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).expect("a free name")
}

pub async fn put(name: &str, data: &str, path: Option<&str>) -> Result<String, String> {
    put_in(&home(), name, data, path).await
}

pub async fn put_in(home: &Path, name: &str, data: &str, path: Option<&str>) -> Result<String, String> {
    let bytes = STANDARD.decode(data).map_err(|_| "The file's data isn't base64.".to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("That file is over 25 MB.".into());
    }
    let name = safe_name(name)?;
    let target = match path {
        None => {
            let dir = home.join("Downloads/Hatbot");
            tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("Can't make {}: {e}.", dir.display()))?;
            free(&dir, &name)
        }
        Some(p) => {
            let p = expand(p, home);
            if tokio::fs::metadata(&p).await.is_ok_and(|m| m.is_dir()) {
                free(&p, &name)
            } else {
                if let Some(parent) = p.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| format!("Can't make {}: {e}.", parent.display()))?;
                }
                p
            }
        }
    };
    tokio::fs::write(&target, bytes).await.map_err(|e| format!("Can't write {}: {e}.", target.display()))?;
    Ok(target.display().to_string())
}

/// A file's name and contents, base64.
pub async fn get(path: &str) -> Result<(String, String), String> {
    let p = expand(path, &home());
    let meta = tokio::fs::metadata(&p).await.map_err(|_| format!("There's no file at {}.", p.display()))?;
    if !meta.is_file() {
        return Err(format!("{} isn't a file.", p.display()));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("{} is over 25 MB.", p.display()));
    }
    let bytes = tokio::fs::read(&p).await.map_err(|e| format!("Can't read {}: {e}.", p.display()))?;
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok((name, STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn puts_files_in_downloads_without_overwriting_or_leaving_it() {
        let home = std::env::temp_dir().join(format!("hatbot-files-{}", std::process::id()));
        let data = STANDARD.encode(b"hi");
        let a = put_in(&home, "../../a.txt", &data, None).await.unwrap();
        let b = put_in(&home, "a.txt", &data, None).await.unwrap();
        assert_eq!(a, home.join("Downloads/Hatbot/a.txt").display().to_string());
        assert_eq!(b, home.join("Downloads/Hatbot/a (1).txt").display().to_string());
        let c = put_in(&home, "a.txt", &data, Some("~/docs/b.txt")).await.unwrap();
        assert_eq!(c, home.join("docs/b.txt").display().to_string());
        assert!(put_in(&home, "..", &data, None).await.is_err());
        let _ = std::fs::remove_dir_all(home);
    }
}
