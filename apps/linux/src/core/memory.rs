// Memory's files by folder, paths for new ones, and diffs: git's, and between a proposal's before and
// after (Memory.swift and LineDiff in Looking.swift on iOS, diff.ts on the web).
use std::collections::BTreeMap;

use super::models::MemoryFile;

/// Files by folder: the top level first, then folders by name. `a/b/c.md` is under `a/b`.
pub fn groups(files: &[MemoryFile]) -> Vec<(String, Vec<&MemoryFile>)> {
    let mut by: BTreeMap<String, Vec<&MemoryFile>> = BTreeMap::new();
    for f in files {
        let folder = f.path.rsplit_once('/').map_or("", |(d, _)| d);
        by.entry(folder.into()).or_default().push(f);
    }
    // The empty top level sorts first already.
    by.into_iter()
        .map(|(folder, mut list)| {
            list.sort_by(|a, b| a.path.cmp(&b.path));
            (folder, list)
        })
        .collect()
}

/// "notes/x.md" → "x.md".
pub fn name(path: &str) -> &str {
    path.rsplit('/').find(|p| !p.is_empty()).unwrap_or(path)
}

/// A path for a new file: ".md" added, leading slashes dropped. None when it can't be one.
pub fn new_path(input: &str) -> Option<String> {
    let p = input.trim().trim_start_matches('/');
    if p.is_empty() || p.split('/').any(|s| matches!(s, ".." | "." | ".git")) {
        return None;
    }
    Some(if p.ends_with(".md") {
        p.into()
    } else {
        format!("{p}.md")
    })
}

/// A new file's first line: "garden-plan.md" → "# Garden plan".
pub fn new_file(path: &str) -> String {
    let title = name(path).replace(".md", "").replace('-', " ");
    let mut chars = title.chars();
    let title = match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => title,
    };
    format!("# {title}\n")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffKind {
    Added,
    Removed,
    Hunk,
    Context,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DiffLine {
    pub kind: DiffKind,
    pub text: String,
}

impl DiffLine {
    fn new(kind: DiffKind, text: String) -> DiffLine {
        DiffLine { kind, text }
    }
}

/// `git show` output without its headers.
pub fn parse_diff(diff: &str) -> Vec<DiffLine> {
    const HEADERS: [&str; 6] = [
        "diff --git",
        "index ",
        "--- ",
        "+++ ",
        "new file",
        "deleted file",
    ];
    diff.split('\n')
        .filter(|l| !HEADERS.iter().any(|h| l.starts_with(h)))
        .map(|l| {
            let kind = if l.starts_with('+') {
                DiffKind::Added
            } else if l.starts_with('-') {
                DiffKind::Removed
            } else if l.starts_with("@@") {
                DiffKind::Hunk
            } else {
                DiffKind::Context
            };
            DiffLine::new(kind, l.into())
        })
        .collect()
}

/// Lines kept around each change; the rest fold into "…".
const CONTEXT: usize = 2;
/// Past this many edits the middle shows as all removed, then all added: Myers' cost grows with it.
const MOST_EDITS: usize = 2_000;

/// What changed between two versions of a file, line by line, with a little context.
pub fn line_diff(before: Option<&str>, after: Option<&str>) -> Vec<DiffLine> {
    fn lines(s: Option<&str>) -> Vec<&str> {
        match s {
            None => vec![],
            Some(s) => s.strip_suffix('\n').unwrap_or(s).split('\n').collect(),
        }
    }
    let (wa, wb) = (lines(before), lines(after));
    let shortest = wa.len().min(wb.len());
    let head = (0..shortest).take_while(|&i| wa[i] == wb[i]).count();
    let tail = (0..shortest - head)
        .take_while(|&i| wa[wa.len() - 1 - i] == wb[wb.len() - 1 - i])
        .count();
    let (a, b) = (&wa[head..wa.len() - tail], &wb[head..wb.len() - tail]);
    let context = |l: &&str| DiffLine::new(DiffKind::Context, format!(" {l}"));
    let mut all: Vec<DiffLine> = wa[..head].iter().map(context).collect();
    match edits(a, b) {
        Some(middle) => all.extend(middle),
        None => {
            all.extend(
                a.iter()
                    .map(|l| DiffLine::new(DiffKind::Removed, format!("-{l}"))),
            );
            all.extend(
                b.iter()
                    .map(|l| DiffLine::new(DiffKind::Added, format!("+{l}"))),
            );
        }
    }
    all.extend(wa[wa.len() - tail..].iter().map(context));

    let mut out: Vec<DiffLine> = vec![];
    for (k, l) in all.iter().enumerate() {
        let near = all[k.saturating_sub(CONTEXT)..(k + CONTEXT + 1).min(all.len())]
            .iter()
            .any(|x| x.kind != DiffKind::Context);
        if l.kind != DiffKind::Context || near {
            out.push(l.clone());
        } else if out.last().map(|x| x.kind) != Some(DiffKind::Hunk) {
            out.push(DiffLine::new(DiffKind::Hunk, "…".into()));
        }
    }
    out
}

/// Myers' diff of the lines between the common head and tail; None past `MOST_EDITS`.
fn edits(a: &[&str], b: &[&str]) -> Option<Vec<DiffLine>> {
    let (n, m) = (a.len() as isize, b.len() as isize);
    let most = (n + m).min(MOST_EDITS as isize);
    let off = most + 1;
    let mut v = vec![0isize; (2 * off + 1) as usize];
    let mut trace: Vec<Vec<isize>> = vec![];
    let mut found = None;
    let mut d = 0;
    while d <= most && found.is_none() {
        let mut k = -d;
        while k <= d {
            let at = |k: isize| v[(off + k) as usize];
            let mut x = if k == -d || (k != d && at(k - 1) < at(k + 1)) {
                at(k + 1)
            } else {
                at(k - 1) + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[(off + k) as usize] = x;
            if x >= n && y >= m {
                found = Some(d);
                break;
            }
            k += 2;
        }
        trace.push(v[(off - d) as usize..=(off + d) as usize].to_vec());
        d += 1;
    }
    let found = found?;
    let mut all = vec![];
    let (mut x, mut y) = (n, m);
    for d in (1..=found).rev() {
        let prev = &trace[(d - 1) as usize];
        let at = |k: isize| prev[(k + d - 1) as usize];
        let k = x - y;
        let down = k == -d || (k != d && at(k - 1) < at(k + 1));
        let px = if down { at(k + 1) } else { at(k - 1) };
        let py = px - if down { k + 1 } else { k - 1 };
        while x > if down { px } else { px + 1 } {
            x -= 1;
            all.push(DiffLine::new(
                DiffKind::Context,
                format!(" {}", a[x as usize]),
            ));
        }
        all.push(if down {
            DiffLine::new(DiffKind::Added, format!("+{}", b[py as usize]))
        } else {
            DiffLine::new(DiffKind::Removed, format!("-{}", a[px as usize]))
        });
        x = px;
        y = py;
    }
    all.extend(
        a[..x as usize]
            .iter()
            .rev()
            .map(|l| DiffLine::new(DiffKind::Context, format!(" {l}"))),
    );
    all.reverse();
    // Each run's deletions before what replaces them.
    let mut out = vec![];
    let mut run: Vec<DiffLine> = vec![];
    for l in all
        .into_iter()
        .chain([DiffLine::new(DiffKind::Hunk, String::new())])
    {
        if matches!(l.kind, DiffKind::Added | DiffKind::Removed) {
            run.push(l);
            continue;
        }
        let (removed, added): (Vec<_>, Vec<_>) =
            run.drain(..).partition(|r| r.kind == DiffKind::Removed);
        out.extend(removed);
        out.extend(added);
        if l.kind == DiffKind::Context {
            out.push(l);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(lines: &[DiffLine]) -> Vec<&str> {
        lines.iter().map(|l| l.text.as_str()).collect()
    }

    #[test]
    fn a_change_shows_with_two_lines_around_it_and_the_rest_folded() {
        let before = "# Home\na\nb\nc\nd\ne\nf\nRouter: old\n";
        let after = "# Home\na\nb\nc\nd\ne\nf\nRouter: new\nAlso\n";
        assert_eq!(
            texts(&line_diff(Some(before), Some(after))),
            ["…", " e", " f", "-Router: old", "+Router: new", "+Also"]
        );
        assert_eq!(texts(&line_diff(None, Some("x\n"))), ["+x"]);
    }

    #[test]
    fn a_big_file_diffs_quickly_and_a_rewrite_past_the_limit_is_removed_then_added() {
        let before: String = (0..20_000).map(|i| format!("line {i}\n")).collect();
        let after = before
            .replace("line 5000\n", "changed\n")
            .replace("line 15000\n", "also changed\n");
        let started = std::time::Instant::now();
        let diff = line_diff(Some(&before), Some(&after));
        assert!(started.elapsed().as_secs_f64() < 1.0);
        assert_eq!(diff.iter().filter(|l| l.kind == DiffKind::Added).count(), 2);

        let old: String = (0..3000).map(|i| format!("a{i}\n")).collect();
        let new: String = (0..3000).map(|i| format!("b{i}\n")).collect();
        let rewrite = line_diff(Some(&old), Some(&new));
        assert!(rewrite[..3000].iter().all(|l| l.kind == DiffKind::Removed));
    }
}
