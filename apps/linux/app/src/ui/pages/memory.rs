// Memory: its files, each to read and edit, what changed in it, and changes a bot proposes.
use iced::widget::{column, container, row, scrollable, text, text_editor};
use iced::{Alignment, Element, Length, Padding, Task};
use serde::Deserialize;
use serde_json::{Value, json};

use super::Msg as PageMsg;
use crate::core::api::query;
use crate::core::format;
use crate::core::models::*;
use crate::ui::app::{Message, Session, failed};
use crate::ui::confirm;
use crate::ui::icons::{self, Icon};
use crate::ui::markdown;
use crate::ui::theme::{self, FS_LG, FS_MD, FS_SM, FS_XL, SP, SP_LG, SP_MD, SP_SM, SP_XL, SP_XS};
use crate::ui::widgets::{btn, btn_sm, card, editor_keys, empty, error, fill, input, rule, small, tone};

#[derive(Debug, Clone, PartialEq)]
pub enum View {
    File(String),
    Commit(MemoryCommit),
    Proposal(i64),
}

#[derive(Debug, Clone, Deserialize)]
pub struct Conflict {
    pub sha: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub enum Msg {
    Tree(Result<Vec<MemoryFile>, String>),
    Proposals(Vec<Proposal>),
    Open(View),
    File(String, Result<MemoryContent, String>),
    Edit,
    Editing(text_editor::Action),
    Cancel,
    Save(Option<String>),
    Saved(Result<(), Conflict>),
    SaveFailed(String),
    Reload,
    Delete(String),
    DeleteSure(String),
    Deleted,
    NewName(String),
    New,
    Log(Result<Vec<MemoryCommit>, String>),
    Diff(String, Result<String, String>),
    Revert(String),
    Tidy,
    Apply(i64),
    Dismiss(i64),
    Decided(Result<Proposal, String>),
}

#[derive(Default)]
pub struct State {
    files: Option<Vec<MemoryFile>>,
    error: Option<String>,
    view: Option<View>,
    content: Option<MemoryContent>,
    draft: Option<text_editor::Content>,
    is_new: bool,
    conflict: Option<Conflict>,
    saving: bool,
    new_name: Option<String>,
    /// The open file is shown read, not in the editor.
    reading: bool,
    log: Option<Vec<MemoryCommit>>,
    diff: Option<(String, String)>,
}

fn m(msg: Msg) -> Message {
    Message::Page(PageMsg::Memory(msg))
}

pub fn opened(s: &mut Session) -> Task<Message> {
    load(s)
}

fn load(s: &Session) -> Task<Message> {
    let mut t = vec![
        s.call(
            |api| async move { api.get::<Vec<MemoryFile>>("/memory/tree").await },
            |r| match r {
                Err(e) if e.is_unauthorized() => Message::Unauthorized,
                r => m(Msg::Tree(r.map_err(|e| e.message))),
            },
        ),
        // Brains from before proposals answer 404; the files still show.
        s.call(
            |api| async move { api.get::<Vec<Proposal>>("/proposals?status=pending").await },
            |r| r.map(|l| m(Msg::Proposals(l))).unwrap_or(Message::Nothing),
        ),
    ];
    t.push(reopen(s));
    Task::batch(t)
}

/// What's open, read again: memory changed elsewhere. A file being edited is left alone.
fn reopen(s: &Session) -> Task<Message> {
    let st = &s.pages.memory;
    match &st.view {
        Some(View::File(p)) if !st.is_new && !edited(st) => Task::batch([read(s, p.clone()), log(s, Some(p.clone()))]),
        _ => Task::none(),
    }
}

/// Whether the editor holds anything that isn't saved.
fn edited(st: &State) -> bool {
    st.draft.as_ref().is_some_and(|d| Some(d.text()) != st.content.as_ref().map(|c| c.content.clone()))
}

/// Memory changed: what shows is read again.
pub fn changed(s: &mut Session) -> Task<Message> {
    load(s)
}

fn read(s: &Session, path: String) -> Task<Message> {
    let p = path.clone();
    s.call(
        move |api| async move { api.get::<MemoryContent>(&format!("/memory/file?path={}", query(&p))).await },
        move |r| m(Msg::File(path, r.map_err(|e| e.message))),
    )
}

fn log(s: &Session, path: Option<String>) -> Task<Message> {
    let q = path.map(|p| format!("&path={}", query(&p))).unwrap_or_default();
    s.call(
        move |api| async move { api.get::<Vec<MemoryCommit>>(&format!("/memory/log?limit=100{q}")).await },
        |r| m(Msg::Log(r.map_err(|e| e.message))),
    )
}

pub fn update(s: &mut Session, msg: Msg) -> Task<Message> {
    let st = &mut s.pages.memory;
    match msg {
        Msg::Tree(Ok(files)) => {
            // Like the web, memory opens at its index.
            let index = st.view.is_none() && files.iter().any(|f| f.path == "INDEX.md");
            st.files = Some(files);
            st.error = None;
            if index {
                return update(s, Msg::Open(View::File("INDEX.md".into())));
            }
        }
        Msg::Tree(Err(e)) => st.error = Some(e),
        Msg::Proposals(list) => {
            s.store.proposals = list.into_iter().map(|p| (p.id, p)).collect();
        }
        Msg::Open(v) => {
            st.draft = None;
            st.conflict = None;
            st.is_new = false;
            st.new_name = None;
            st.view = Some(v.clone());
            return match v {
                View::File(p) => {
                    st.content = None;
                    st.log = None;
                    st.reading = false;
                    Task::batch([read(s, p.clone()), log(s, Some(p))])
                }
                View::Commit(c) => {
                    st.diff = None;
                    let sha = c.sha.clone();
                    s.call(
                        move |api| async move {
                            #[derive(Deserialize)]
                            struct Diff {
                                diff: String,
                            }
                            api.get::<Diff>(&format!("/memory/diff/{sha}")).await.map(|d| d.diff)
                        },
                        move |r| m(Msg::Diff(c.sha.clone(), r.map_err(|e| e.message))),
                    )
                }
                View::Proposal(_) => Task::none(),
            };
        }
        Msg::File(path, r) => {
            if st.view.as_ref() == Some(&View::File(path)) {
                match r {
                    Ok(c) => {
                        if !st.reading {
                            st.draft = Some(text_editor::Content::with_text(&c.content));
                        }
                        st.content = Some(c);
                    }
                    Err(e) => st.error = Some(e),
                }
            }
        }
        Msg::Edit => {
            st.reading = false;
            st.draft =
                Some(text_editor::Content::with_text(st.content.as_ref().map(|c| c.content.as_str()).unwrap_or("")));
        }
        Msg::Editing(a) => {
            if let Some(d) = &mut st.draft {
                d.perform(a);
            }
        }
        Msg::Cancel => {
            st.reading = true;
            st.draft = None;
            st.conflict = None;
            if st.is_new {
                st.view = None;
                st.is_new = false;
            }
        }
        Msg::Save(over) => {
            let (Some(View::File(path)), Some(d)) = (&st.view, &st.draft) else { return Task::none() };
            let base = over
                .or_else(|| if st.is_new { Some(String::new()) } else { st.content.as_ref().map(|c| c.sha.clone()) });
            let body = json!({ "content": d.text(), "message": format!("Edit {path}"), "baseSha": base });
            let p = path.clone();
            st.saving = true;
            return s.call(
                move |api| async move { api.put::<Value, _>(&format!("/memory/file?path={}", query(&p)), &body).await },
                |r| match r {
                    Ok(_) => m(Msg::Saved(Ok(()))),
                    Err(e) if e.status == 409 => match serde_json::from_str::<Conflict>(&e.body) {
                        Ok(c) => m(Msg::Saved(Err(c))),
                        Err(_) => m(Msg::SaveFailed(e.message)),
                    },
                    Err(e) if e.is_unauthorized() => Message::Unauthorized,
                    Err(e) => m(Msg::SaveFailed(e.message)),
                },
            );
        }
        Msg::Saved(Ok(())) => {
            st.saving = false;
            st.draft = None;
            st.conflict = None;
            st.is_new = false;
            return load(s);
        }
        Msg::Saved(Err(c)) => {
            st.saving = false;
            st.conflict = Some(c);
        }
        Msg::SaveFailed(e) => {
            st.saving = false;
            return Task::done(Message::Toast(e));
        }
        Msg::Reload => {
            if let Some(c) = st.conflict.take() {
                st.draft = Some(text_editor::Content::with_text(&c.content));
                st.content = Some(MemoryContent { content: c.content, sha: c.sha });
            }
        }
        Msg::Delete(path) => {
            let ask = format!("Delete {path}?");
            return confirm::ask(
                ask,
                "Its history stays, so it can be brought back.",
                "Delete",
                m(Msg::DeleteSure(path)),
            );
        }
        Msg::DeleteSure(path) => {
            return s.call(
                move |api| async move { api.delete(&format!("/memory/file?path={}", query(&path))).await },
                |r| r.map(|_| m(Msg::Deleted)).unwrap_or_else(failed),
            );
        }
        Msg::Deleted => {
            st.view = None;
            return load(s);
        }
        Msg::NewName(v) => st.new_name = Some(v),
        Msg::New => {
            let Some(name) = st.new_name.take() else {
                st.new_name = Some(String::new());
                return Task::none();
            };
            let mut p = name.trim().trim_start_matches('/').to_string();
            if p.is_empty() {
                return Task::none();
            }
            if !p.contains('.') {
                p.push_str(".md");
            }
            let exists = st.files.as_ref().is_some_and(|f| f.iter().any(|x| x.path == p));
            st.view = Some(View::File(p.clone()));
            st.conflict = None;
            if exists {
                st.content = None;
                return read(s, p);
            }
            st.is_new = true;
            st.content = Some(MemoryContent { content: String::new(), sha: String::new() });
            st.draft = Some(text_editor::Content::new());
        }
        Msg::Log(Ok(l)) => st.log = Some(l),
        Msg::Log(Err(e)) => st.error = Some(e),
        Msg::Diff(sha, Ok(d)) => st.diff = Some((sha, d)),
        Msg::Diff(_, Err(e)) => st.error = Some(e),
        Msg::Revert(sha) => {
            return s.call(
                move |api| async move { api.post::<Value, _>(&format!("/memory/revert/{sha}"), &json!({})).await },
                |r| match r {
                    Ok(v) if v.get("sha").is_some_and(|x| !x.is_null()) => Message::Toast("Reverted.".into()),
                    Ok(_) => Message::Toast("There was nothing to undo.".into()),
                    Err(e) => failed(e),
                },
            );
        }
        Msg::Tidy => {
            return s.call(
                |api| async move { api.post::<Value, _>("/proposals/tidy", &json!({})).await },
                |r| match r {
                    Ok(_) => Message::Toast("Hatbot is looking over memory. Its proposal will show here.".into()),
                    Err(e) => failed(e),
                },
            );
        }
        Msg::Apply(id) | Msg::Dismiss(id) => {
            let verb = if matches!(msg, Msg::Apply(_)) { "apply" } else { "dismiss" };
            return s.call(
                move |api| async move { api.post::<Proposal, _>(&format!("/proposals/{id}/{verb}"), &json!({})).await },
                |r| m(Msg::Decided(r.map_err(|e| e.message))),
            );
        }
        Msg::Decided(Ok(p)) => {
            s.store.proposals.insert(p.id, p);
            s.pages.memory.view = None;
            return load(s);
        }
        Msg::Decided(Err(e)) => return Task::done(Message::Toast(e)),
    }
    Task::none()
}

pub fn texts(s: &Session) -> Vec<String> {
    let st = &s.pages.memory;
    match (&st.view, &st.content, &st.draft) {
        (Some(View::File(p)), Some(c), None) if p.ends_with(".md") => vec![c.content.clone()],
        _ => vec![],
    }
}

pub fn view<'a>(s: &'a Session, md: &'a markdown::Cache, dark: bool) -> Element<'a, Message> {
    row![
        container(list(s)).width(230).height(Length::Fill),
        container(detail(s, md, dark))
            .width(Length::Fill)
            .height(Length::Fill)
            .padding(Padding::default().right(SP).bottom(SP))
    ]
    .height(Length::Fill)
    .into()
}

fn list(s: &Session) -> Element<'_, Message> {
    let st = &s.pages.memory;
    let mut col = column![].spacing(0);
    let pending: Vec<&Proposal> = s.store.proposals.values().filter(|p| p.status == ProposalStatus::Pending).collect();
    if !pending.is_empty() {
        col = col.push(folder("To look over", Icon::Zap));
        for p in pending {
            col = col.push(entry(
                Icon::Zap,
                p.title.clone(),
                st.view == Some(View::Proposal(p.id)),
                m(Msg::Open(View::Proposal(p.id))),
            ));
        }
    }
    let mut files: Vec<&MemoryFile> = st.files.iter().flatten().collect();
    files.sort_by_key(|f| (f.path.contains('/'), f.path.as_str()));
    let mut dir_shown = String::new();
    for f in files {
        let (dir, name) = match f.path.rsplit_once('/') {
            Some((d, n)) => (d.to_string(), n.to_string()),
            None => (String::new(), f.path.clone()),
        };
        if dir != dir_shown {
            dir_shown = dir.clone();
            col = col.push(folder(format!("{dir}/"), Icon::Folder));
        }
        col = col.push(entry(
            Icon::File,
            name,
            st.view == Some(View::File(f.path.clone())),
            m(Msg::Open(View::File(f.path.clone()))),
        ));
    }
    if st.files.as_ref().is_some_and(Vec::is_empty) {
        col = col.push(container(small("Memory is empty.")).padding([SP_XS, SP_MD]));
    }
    col = match &st.new_name {
        Some(n) => col.push(
            container(
                row![
                    input("folder/name.md", n, |v| m(Msg::NewName(v))).on_submit(m(Msg::New)),
                    btn_sm("Create", theme::primary, (!n.trim().is_empty()).then_some(m(Msg::New)))
                ]
                .spacing(SP)
                .align_y(Alignment::Center),
            )
            .padding([SP_SM, 0.0]),
        ),
        None => col.push(entry(Icon::Plus, "New file".into(), false, m(Msg::New))),
    };
    col = col.push(entry(Icon::Zap, "Tidy up".into(), false, m(Msg::Tidy)));
    scrollable(col.padding([SP_MD, SP])).style(theme::scroll).height(Length::Fill).into()
}

/// A folder's name over its files, in the accent.
fn folder<'a>(name: impl text::IntoFragment<'a>, i: Icon) -> Element<'a, Message> {
    container(
        row![icons::icon(i, 18.0, icons::hue), text(name).size(FS_SM).font(theme::MEDIUM).style(tone(|c| c.hue))]
            .spacing(SP_SM)
            .align_y(Alignment::Center),
    )
    .padding(Padding { top: SP_MD, right: SP_MD, bottom: SP_XS, left: SP_MD })
    .into()
}

fn entry<'a>(i: Icon, name: String, lit: bool, on: Message) -> Element<'a, Message> {
    crate::ui::button::button(
        row![icons::icon(i, 18.0, if lit { |c| c.text } else { |c| c.text_2 }), text(name).size(FS_MD)]
            .spacing(SP_SM)
            .align_y(Alignment::Center)
            .height(28),
    )
    .width(Length::Fill)
    .padding([SP_XS, SP_MD])
    .style(theme::nav(lit))
    .on_press(on)
    .into()
}

/// The open file, commit or proposal, on the web's rounded editor panel.
fn detail<'a>(s: &'a Session, md: &'a markdown::Cache, dark: bool) -> Element<'a, Message> {
    let st = &s.pages.memory;
    let inner: Element<'a, Message> = match &st.view {
        None => scrollable(column![].push(st.error.as_deref().map(error)).push(empty("Pick a file to read it.")))
            .style(theme::scroll)
            .into(),
        Some(View::File(path)) => file(st, path, md, dark),
        Some(View::Commit(c)) => {
            let mut col = column![].spacing(SP_LG).padding([SP_LG, GUTTER]);
            col = col.push(
                row![
                    column![
                        text(c.message.as_str()).size(FS_XL),
                        small(format!("{} · {}", c.author, format::stamp(&c.date)))
                    ]
                    .spacing(SP_SM)
                    .width(Length::Fill),
                    btn_sm("Revert", theme::outlined, Some(m(Msg::Revert(c.sha.clone()))))
                ]
                .spacing(SP_LG),
            );
            if let Some((sha, d)) = &st.diff
                && *sha == c.sha
            {
                col = col.push(diff(d));
            }
            scrollable(col).style(theme::scroll).into()
        }
        Some(View::Proposal(id)) => match s.store.proposals.get(id) {
            Some(p) => scrollable(container(proposal(p)).padding([SP_LG, GUTTER])).style(theme::scroll).into(),
            None => column![].into(),
        },
    };
    container(inner).width(Length::Fill).height(Length::Fill).style(theme::panel).into()
}

/// The web's gutter inside the editor panel.
const GUTTER: f32 = 24.0;

fn file<'a>(st: &'a State, path: &'a str, md: &'a markdown::Cache, dark: bool) -> Element<'a, Message> {
    let mut bar = row![text(path).size(FS_MD).font(theme::CODE).width(Length::Fill)]
        .spacing(SP)
        .align_y(Alignment::Center)
        .height(32);
    if st.draft.is_some() {
        let changed = edited(st);
        if !st.is_new {
            bar = bar.push(btn_sm("Read", theme::outlined, Some(m(Msg::Cancel))));
            bar = bar.push(btn_sm("Delete", theme::plain, Some(m(Msg::Delete(path.to_string())))));
        } else {
            bar = bar.push(btn_sm("Cancel", theme::plain, Some(m(Msg::Cancel))));
        }
        bar = bar.push(btn_sm(
            "Save",
            theme::primary,
            (!st.saving && (changed || st.is_new) && st.conflict.is_none()).then_some(m(Msg::Save(None))),
        ));
    } else if st.content.is_some() {
        bar = bar.push(btn_sm("Edit", theme::outlined, Some(m(Msg::Edit))));
    }
    let mut col = column![container(bar).padding([SP, GUTTER]), rule()];
    if let Some(e) = &st.error {
        col = col.push(container(error(e.as_str())).padding([SP_MD, GUTTER]));
    }
    if let Some(c) = &st.conflict {
        col = col.push(
            container(
                container(
                    row![
                        text("It changed while you were editing.").size(FS_MD).width(Length::Fill),
                        btn_sm("Reload", theme::outlined, Some(m(Msg::Reload))),
                        btn_sm("Overwrite", theme::danger, Some(m(Msg::Save(Some(c.sha.clone())))))
                    ]
                    .spacing(SP)
                    .align_y(Alignment::Center),
                )
                .padding(SP_MD)
                .width(Length::Fill)
                .style(theme::attention),
            )
            .padding([SP_MD, GUTTER]),
        );
    }
    if let Some(d) = &st.draft {
        col = col.push(
            text_editor(d)
                .on_action(|a| m(Msg::Editing(a)))
                .key_binding(|k| editor_keys(d, k))
                .font(theme::CODE)
                .size(FS_MD)
                .line_height(1.65)
                .padding([SP_LG, GUTTER])
                .height(Length::Fill)
                .style(theme::bare_editor),
        );
    } else if let Some(c) = &st.content {
        let read = container(match md.get(&c.content) {
            Some(parsed) if path.ends_with(".md") => markdown::view(parsed, dark, Message::Link),
            _ => iced_selection::text(c.content.as_str()).size(FS_MD).font(theme::CODE).style(theme::selectable).into(),
        })
        .padding([SP_LG, GUTTER]);
        col = col.push(scrollable(read).style(theme::scroll).height(Length::Fill));
    } else {
        col = col.push(fill());
    }
    if let Some(l) = st.log.as_ref().filter(|l| !l.is_empty() && !st.is_new) {
        let mut h = column![container(text("History").size(FS_LG)).padding([0.0, SP_MD])].spacing(SP);
        for c in l {
            h = h.push(
                row![
                    text(c.sha.chars().take(7).collect::<String>())
                        .size(FS_SM)
                        .font(theme::CODE)
                        .style(tone(|c| c.muted))
                        .width(70),
                    row![
                        text(c.message.as_str()).size(FS_MD),
                        text(format::stamp(&c.date)).size(FS_MD).style(tone(|c| c.muted))
                    ]
                    .spacing(SP_XS)
                    .width(Length::Fill),
                    btn_sm("Diff", theme::link, Some(m(Msg::Open(View::Commit(c.clone()))))),
                    btn_sm("Revert", theme::link, Some(m(Msg::Revert(c.sha.clone()))))
                ]
                .spacing(SP)
                .align_y(Alignment::Center)
                .padding([SP_SM, SP_MD]),
            );
        }
        // The history keeps to the panel's lower part, the editor above it.
        col = col.push(rule()).push(
            container(
                scrollable(container(h).padding(Padding { top: SP_MD, right: GUTTER, bottom: SP_XL, left: GUTTER }))
                    .style(theme::scroll),
            )
            .max_height(280),
        );
    }
    col.into()
}

/// A unified diff, its added and removed lines in colour.
fn diff(d: &str) -> Element<'_, Message> {
    let mut col = column![].spacing(0);
    for line in d.lines() {
        let tone_of: fn(&theme::Colors) -> iced::Color = if line.starts_with("+++")
            || line.starts_with("---")
            || line.starts_with("diff ")
            || line.starts_with("index ")
        {
            |c| c.muted
        } else if line.starts_with('+') {
            |c| c.success
        } else if line.starts_with('-') {
            |c| c.danger
        } else if line.starts_with("@@") {
            |c| c.hue
        } else {
            |c| c.text_2
        };
        col = col.push(text(line).size(13).font(theme::CODE).style(tone(tone_of)));
    }
    container(
        scrollable(col)
            .direction(scrollable::Direction::Horizontal(scrollable::Scrollbar::default()))
            .style(theme::scroll),
    )
    .padding(SP_LG)
    .width(Length::Fill)
    .style(theme::code_block)
    .into()
}

fn proposal(p: &Proposal) -> Element<'_, Message> {
    let mut col = column![text(p.title.as_str()).size(FS_XL)].spacing(SP_LG);
    if !p.reason.is_empty() {
        col = col.push(small(p.reason.as_str()));
    }
    for c in &p.changes {
        let what = match (&c.before, &c.after) {
            (None, Some(_)) => "New",
            (Some(_), None) => "Deleted",
            _ => "Changed",
        };
        let mut body = column![text(format!("{what}: {}", c.path)).size(FS_MD).font(theme::MEDIUM)].spacing(SP);
        if let Some(a) = &c.after {
            body = body.push(
                container(text(a.as_str()).size(13).font(theme::CODE))
                    .padding(SP_MD)
                    .width(Length::Fill)
                    .style(theme::code_block),
            );
        }
        col = col.push(card(body));
    }
    if p.status == ProposalStatus::Pending {
        col = col.push(
            row![
                btn("Dismiss", theme::outlined, Some(m(Msg::Dismiss(p.id)))),
                fill(),
                btn("Apply", theme::primary, Some(m(Msg::Apply(p.id))))
            ]
            .spacing(SP),
        );
    }
    col.into()
}
