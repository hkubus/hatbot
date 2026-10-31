// A chat with a bot or a group: its messages in folds, what waits on you, and the composer.
use std::collections::{HashMap, HashSet};

use iced::widget::{Space, button, column, container, image, mouse_area, row, scrollable, text, text_editor};
use iced::{Alignment, Element, Length, Padding, Task, Theme, keyboard};
use serde_json::json;

use super::app::{Message, Route, Session, failed, load_cards};
use super::chart;
use super::icons::{self, Icon};
use super::markdown;
use super::theme::{self, FS_MD, FS_SM, FS_TEXT, H, MEASURE, SP, SP_LG, SP_MD, SP_SM, SP_XL, SP_XS};
use super::widgets::{body, btn, btn_sm, btn_wide, empty, error, input, small, strong, tiny, tone};
use crate::core::api::ApiError;
use crate::core::chart::{self as spec, ChartFile, ChartSpec, Kind, Part};
use crate::core::format;
use crate::core::models::Task as AgentTask;
use crate::core::models::*;
use crate::core::thread;

#[derive(Debug, Clone)]
pub enum Msg {
    Open(i64),
    Page {
        conversation: i64,
        incognito: bool,
        result: Result<Vec<ThreadMessage>, ApiError>,
    },
    Earlier {
        conversation: i64,
        first: i64,
        result: Result<Vec<ThreadMessage>, ApiError>,
    },
    Episodes(Vec<Episode>),
    Threads(i64, Vec<Conversation>),
    Edit(text_editor::Action),
    Send,
    /// Whether it was the composer's: a choice leaves what's being written alone.
    Sent(Result<ThreadMessage, ApiError>, bool),
    Attach,
    Picked(Vec<(String, String, Vec<u8>)>),
    Uploaded(u64, Result<Attachment, ApiError>),
    Unattach(u64),
    Incognito(bool),
    Resolve(i64),
    Resolved(Result<Conversation, ApiError>),
    Note(i64, String),
    Decide {
        id: i64,
        approve: bool,
        scope: Option<String>,
        /// A ready answer, sent as the note.
        answer: Option<String>,
    },
    Decided(i64, Result<Approval, ApiError>),
    RunAnyway {
        id: i64,
        always: bool,
    },
    Ran(i64, Result<Approval, ApiError>),
    Dismiss(i64),
    Dismissed(i64, Result<(), ApiError>),
    Own(i64, String),
    Answer(i64, String),
    Answered(i64, Result<Question, ApiError>),
    Trust(i64, i64),
    Trusted(i64, Result<(), ApiError>),
    Choose(String),
    Pick {
        message: i64,
        list: usize,
        choice: String,
    },
    SendPicked(i64),
    Fold(i64),
    Retry(i64),
    ReplyInThread(i64),
    Threaded(Result<Conversation, ApiError>),
    Scrolled(scrollable::Viewport),
    Image(String, Option<Vec<u8>>),
    ChartFile(String, Option<ChartSpec>),
    Download(Attachment),
}

struct ComposerFile {
    id: u64,
    name: String,
    uploaded: Option<Attachment>,
    failed: bool,
}

#[derive(Default)]
pub struct Chat {
    composer: text_editor::Content,
    files: Vec<ComposerFile>,
    next_file: u64,
    sending: bool,
    pub error: Option<String>,
    md: markdown::Cache,
    unfolded: HashSet<i64>,
    notes: HashMap<i64, String>,
    own: HashMap<i64, String>,
    busy: HashSet<String>,
    picked: HashMap<i64, Vec<String>>,
    trusted: HashSet<i64>,
    near_bottom: bool,
    earlier_asked: Option<i64>,
    images: HashMap<String, Option<image::Handle>>,
    /// Replies with charts in them, cut into parts, as of the text they were cut from.
    parts: HashMap<i64, (String, Vec<Part>)>,
    /// Charts drawn from a file, by the path their values come from.
    chart_files: HashMap<String, Loading>,
    /// The chat shows in an open window: what's in it counts as seen.
    pub visible: bool,
}

enum Loading {
    Asked,
    Got(ChartSpec),
    Failed,
}

fn scroll_id() -> iced::widget::Id {
    iced::widget::Id::new("chat")
}

/// The thread is anchored to its bottom, where iced counts offsets from, so its start is the newest message.
fn to_latest() -> Task<Message> {
    iced::widget::operation::snap_to(scroll_id(), iced::widget::scrollable::RelativeOffset::START)
}

pub fn load_page(s: &Session) -> Task<Message> {
    let conversation = s.store.conversation_id;
    let incognito = s.store.incognito;
    let path = s.store.page_path(None);
    s.call(
        move |api| async move { api.get::<Vec<ThreadMessage>>(&path).await },
        move |result| Message::Chat(Msg::Page { conversation, incognito, result }),
    )
}

/// The chats came: the open one may be gone, and a direct chat's threads are listed.
pub fn chats_loaded(s: &mut Session) -> Task<Message> {
    let mut t = vec![load_threads(s)];
    if !s.store.conversations.is_empty()
        && s.store.current_chat().is_none()
        && let Some(first) = s.store.conversations.first().map(|c| c.id)
    {
        s.store.open(first);
        t.push(load_page(s));
    }
    Task::batch(t)
}

fn load_threads(s: &Session) -> Task<Message> {
    let Some(c) = s.store.current_chat() else { return Task::none() };
    if c.kind != ConversationKind::Direct || s.store.conversations.is_empty() {
        return Task::none();
    }
    let id = c.id;
    s.call(
        move |api| async move { api.get::<Vec<Conversation>>(&format!("/conversations/{id}/threads")).await },
        move |r| r.map(|l| Message::Chat(Msg::Threads(id, l))).unwrap_or(Message::Nothing),
    )
}

pub fn after_event(s: &mut Session) -> Task<Message> {
    keep(s);
    fetch_charts(s)
}

/// What the chat shows, kept parsed; and what it shows is seen.
fn keep(s: &mut Session) {
    let store = &s.store;
    let mut texts: Vec<&str> = Vec::new();
    for m in &store.messages {
        if m.role == Role::Assistant {
            texts.push(store.text(m));
        }
        if let Some(t) = m.task_id.and_then(|id| store.tasks.get(&id)) {
            if let Some(sum) = &t.summary {
                texts.push(sum);
            }
            texts.push(&t.title);
        }
    }
    let owned: Vec<String> = store
        .messages
        .iter()
        .filter_map(|m| m.task_id.and_then(|id| store.tasks.get(&id)))
        .flat_map(|t| {
            [format!("**{}**", t.title), format!("**Didn't finish.** {}", t.summary.clone().unwrap_or_default())]
        })
        .collect();
    texts.extend(owned.iter().map(String::as_str));
    let parts = &mut s.chat.parts;
    parts.retain(|id, _| store.messages.iter().any(|m| m.id == *id));
    for m in store.messages.iter().filter(|m| m.role == Role::Assistant) {
        let shown = store.text(m);
        if !shown.contains("```chart") && !shown.contains("~~~chart") {
            parts.remove(&m.id);
            continue;
        }
        if parts.get(&m.id).is_none_or(|(t, _)| t != shown) {
            parts.insert(m.id, (shown.to_string(), spec::split(shown, m.status == MessageStatus::Streaming)));
        }
    }
    texts.extend(parts.values().flat_map(|(_, l)| l).filter_map(|p| match p {
        Part::Markdown(t) => Some(t.as_str()),
        _ => None,
    }));
    s.chat.md.keep(texts);
}

fn sync(s: &mut Session) -> Task<Message> {
    keep(s);
    let mut t = Vec::new();
    // Task cards the messages point at.
    let missing: Vec<i64> = s
        .store
        .messages
        .iter()
        .filter_map(|m| m.task_id)
        .filter(|id| !s.store.tasks.contains_key(id))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    t.push(load_cards(s, missing));
    // Pictures and approval screenshots.
    let mut wanted: Vec<String> = Vec::new();
    for m in &s.store.messages {
        for a in &m.attachments {
            if a.is_picture() {
                wanted.push(format!("/attachments/{}?w=640", a.id));
            }
        }
    }
    if let Some(a) = s.store.pending_approvals().first()
        && let (Some(task), Some(step)) = (a.task_id, a.screenshot_step_id)
    {
        wanted.push(format!("/tasks/{task}/screens/{step}"));
    }
    t.push(fetch_charts(s));
    for path in wanted {
        t.push(fetch_image(s, path));
    }
    t.push(mark_seen(s));
    Task::batch(t)
}

/// A picture from the brain, kept by its path; asked for once.
pub fn fetch_image(s: &mut Session, path: String) -> Task<Message> {
    if s.chat.images.contains_key(&path) {
        return Task::none();
    }
    s.chat.images.insert(path.clone(), None);
    let p = path.clone();
    s.call(move |api| async move { api.bytes(&p).await }, move |r| Message::Chat(Msg::Image(path, r.ok())))
}

/// The brain's paths for a chart's listing photos.
fn photos(c: &ChartSpec) -> Vec<String> {
    let urls: Vec<&String> = match &c.kind {
        Kind::Listings(l) => l.items.iter().filter_map(|i| i.photo.as_ref()).collect(),
        Kind::Gallery(g) => g.photos.iter().collect(),
        _ => vec![],
    };
    urls.into_iter().filter_map(|u| spec::photo_path(u)).collect()
}

/// The values of charts drawn from files, and listing photos, not asked for yet.
fn fetch_charts(s: &mut Session) -> Task<Message> {
    let mut files: Vec<ChartFile> = Vec::new();
    let mut wanted: Vec<String> = Vec::new();
    for p in s.chat.parts.values().flat_map(|(_, l)| l) {
        match p {
            Part::File(f) if !s.chat.chart_files.contains_key(&f.path()) => files.push(f.clone()),
            Part::Chart(c) => wanted.extend(photos(c).into_iter().filter(|p| !s.chat.images.contains_key(p))),
            _ => {}
        }
    }
    let mut t: Vec<Task<Message>> = files.into_iter().map(|f| fetch_chart(s, f)).collect();
    t.extend(wanted.into_iter().map(|p| fetch_image(s, p)));
    Task::batch(t)
}

fn fetch_chart(s: &mut Session, f: ChartFile) -> Task<Message> {
    let path = f.path();
    if s.chat.chart_files.contains_key(&path) {
        return Task::none();
    }
    s.chat.chart_files.insert(path.clone(), Loading::Asked);
    let p = path.clone();
    s.call(
        move |api| async move { api.bytes(&p).await },
        move |r| Message::Chat(Msg::ChartFile(path, r.ok().and_then(|b| f.spec(&b)))),
    )
}

pub fn image_of<'a>(s: &'a Session, path: &str) -> Option<&'a image::Handle> {
    s.chat.images.get(path).and_then(Option::as_ref)
}

/// The window came to the front: what's on screen now counts as seen.
pub fn shown(s: &mut Session) -> Task<Message> {
    mark_seen(s)
}

fn mark_seen(s: &mut Session) -> Task<Message> {
    if !s.chat.visible || s.route != Route::Chat || !s.chat.near_bottom {
        return Task::none();
    }
    let shown: Vec<i64> = s.store.messages.iter().map(|m| m.id).collect();
    let seen = s.store.mark_seen(&shown);
    if seen.is_empty() {
        return Task::none();
    }
    s.fire(move |api| async move { api.post_unit("/thread/seen", &json!({ "ids": seen })).await })
}

pub fn update(s: &mut Session, m: Msg) -> Task<Message> {
    let t = match m {
        Msg::Open(id) => {
            s.route = Route::Chat;
            if id == s.store.conversation_id {
                return Task::none();
            }
            let left = s.store.chat_path();
            let was_incognito = s.store.incognito;
            s.store.open(id);
            s.chat.unfolded.clear();
            s.chat.near_bottom = true;
            s.chat.earlier_asked = None;
            let mut t = vec![load_page(s), load_threads(s), to_latest()];
            if was_incognito {
                t.push(s.fire(move |api| async move { api.delete(&format!("{left}/incognito")).await }));
            }
            Task::batch(t)
        }
        Msg::Page { conversation, incognito, result } => match result {
            Ok(list) => {
                s.store.loading_page();
                s.store.take_page(conversation, incognito, list);
                load_episodes(s)
            }
            Err(e) => Task::done(failed(e)),
        },
        Msg::Earlier { conversation, first, result } => match result {
            Ok(list) => {
                s.store.take_earlier(conversation, first, list);
                load_episodes(s)
            }
            Err(_) => Task::none(),
        },
        Msg::Episodes(list) => {
            for e in list {
                s.store.episodes.insert(e.id, e);
            }
            Task::none()
        }
        Msg::Threads(parent, list) => {
            s.store.threads.retain(|_, t| t.parent_id != Some(parent));
            for t in list {
                s.store.threads.insert(t.id, t);
            }
            Task::none()
        }
        Msg::Edit(action) => {
            s.chat.composer.perform(action);
            Task::none()
        }
        Msg::Send => send(s, None),
        Msg::Sent(r, from_composer) => {
            s.chat.sending = false;
            match r {
                Ok(m) => {
                    if from_composer {
                        s.chat.composer = text_editor::Content::new();
                        s.chat.files.clear();
                    }
                    if m.incognito == s.store.incognito && m.conversation_id == s.store.conversation_id {
                        s.store.apply(Event::MessageCreated { message: m });
                    }
                    to_latest()
                }
                Err(e) if e.is_unauthorized() => Task::done(Message::Unauthorized),
                Err(e) => {
                    s.chat.error = Some(e.message);
                    Task::none()
                }
            }
        }
        Msg::Attach => Task::perform(pick_files(), |l| Message::Chat(Msg::Picked(l))),
        Msg::Picked(list) => {
            let mut t = Vec::new();
            for (name, media_type, data) in list {
                s.chat.next_file += 1;
                let id = s.chat.next_file;
                s.chat.files.push(ComposerFile { id, name: name.clone(), uploaded: None, failed: false });
                t.push(s.call(
                    move |api| async move { api.upload::<Attachment>("/attachments", &name, &media_type, data).await },
                    move |r| Message::Chat(Msg::Uploaded(id, r)),
                ));
            }
            Task::batch(t)
        }
        Msg::Uploaded(id, r) => {
            if let Some(f) = s.chat.files.iter_mut().find(|f| f.id == id) {
                match r {
                    Ok(a) => f.uploaded = Some(a),
                    Err(e) => {
                        f.failed = true;
                        s.chat.error = Some(e.message);
                    }
                }
            }
            Task::none()
        }
        Msg::Unattach(id) => {
            s.chat.files.retain(|f| f.id != id);
            Task::none()
        }
        Msg::Incognito(on) => {
            if on == s.store.incognito {
                return Task::none();
            }
            let path = s.store.chat_path();
            s.store.incognito = on;
            s.store.messages.clear();
            s.store.has_earlier = false;
            s.store.thread_known = false;
            let mut t = vec![load_page(s)];
            if !on {
                t.push(s.fire(move |api| async move { api.delete(&format!("{path}/incognito")).await }));
            }
            Task::batch(t)
        }
        Msg::Resolve(id) => {
            s.call(
                move |api| async move {
                    api.post::<Conversation, _>(&format!("/conversations/{id}/resolve"), &json!({})).await
                },
                |r| Message::Chat(Msg::Resolved(r)),
            )
        }
        Msg::Resolved(r) => match r {
            Ok(c) => {
                s.store.put_conversation(c);
                Task::none()
            }
            Err(e) => Task::done(failed(e)),
        },
        Msg::Note(id, v) => {
            s.chat.notes.insert(id, v);
            Task::none()
        }
        Msg::Decide { id, approve, scope, answer } => {
            let note = answer.or_else(|| s.chat.notes.get(&id).cloned());
            s.chat.busy.insert(format!("a{id}"));
            let body = decision(approve, note.as_deref(), scope.as_deref());
            s.call(
                move |api| async move { api.post::<Approval, _>(&format!("/approvals/{id}"), &body).await },
                move |r| Message::Chat(Msg::Decided(id, r)),
            )
        }
        Msg::Decided(id, r) => {
            s.chat.busy.remove(&format!("a{id}"));
            match r {
                Ok(a) => {
                    s.chat.notes.remove(&id);
                    s.store.approvals.insert(a.id, a);
                    Task::none()
                }
                Err(e) => Task::done(failed(e)),
            }
        }
        Msg::RunAnyway { id, always } => {
            s.chat.busy.insert(format!("a{id}"));
            let body = if always { json!({ "always": true }) } else { json!({}) };
            s.call(
                move |api| async move { api.post::<Approval, _>(&format!("/approvals/{id}/anyway"), &body).await },
                move |r| Message::Chat(Msg::Ran(id, r)),
            )
        }
        Msg::Ran(id, r) => {
            s.chat.busy.remove(&format!("a{id}"));
            match r {
                // A chat's blocked reply runs on its next turn, so ask for it.
                Ok(a) if a.task_id.is_none() => {
                    s.store.approvals.insert(a.id, a);
                    send(s, Some("Run it anyway.".into()))
                }
                Ok(a) => {
                    s.store.approvals.insert(a.id, a);
                    Task::none()
                }
                Err(e) => Task::done(failed(e)),
            }
        }
        Msg::Dismiss(id) => {
            s.chat.busy.insert(format!("a{id}"));
            s.call(
                move |api| async move { api.post_empty(&format!("/approvals/{id}/dismiss")).await },
                move |r| Message::Chat(Msg::Dismissed(id, r)),
            )
        }
        Msg::Dismissed(id, r) => {
            s.chat.busy.remove(&format!("a{id}"));
            match r {
                Ok(()) => {
                    if let Some(a) = s.store.approvals.get_mut(&id) {
                        a.status = ApprovalStatus::Cancelled;
                    }
                    Task::none()
                }
                Err(e) => Task::done(failed(e)),
            }
        }
        Msg::Own(id, v) => {
            s.chat.own.insert(id, v);
            Task::none()
        }
        Msg::Answer(id, text) => {
            let text = text.trim().to_string();
            if text.is_empty() {
                return Task::none();
            }
            s.chat.busy.insert(format!("q{id}"));
            s.call(
                move |api| async move {
                    api.post::<Question, _>(&format!("/questions/{id}"), &json!({ "answer": text })).await
                },
                move |r| Message::Chat(Msg::Answered(id, r)),
            )
        }
        Msg::Answered(id, r) => {
            s.chat.busy.remove(&format!("q{id}"));
            match r {
                Ok(q) => {
                    s.chat.own.remove(&id);
                    s.store.questions.insert(q.id, q);
                    Task::none()
                }
                Err(e) => Task::done(failed(e)),
            }
        }
        Msg::Trust(chat, episode) => s.call(
            move |api| async move { api.post_empty(&format!("/conversations/{chat}/episodes/{episode}/trust")).await },
            move |r| Message::Chat(Msg::Trusted(episode, r)),
        ),
        Msg::Trusted(episode, r) => match r {
            Ok(()) => {
                s.chat.trusted.insert(episode);
                Task::none()
            }
            Err(e) => Task::done(failed(e)),
        },
        Msg::Choose(text) => send(s, Some(text)),
        Msg::Pick { message, list, choice } => {
            let lists = s.store.messages.iter().find(|m| m.id == message).map_or(0, |m| m.choices.len());
            let picked = s.chat.picked.entry(message).or_insert_with(|| vec![String::new(); lists]);
            if list < picked.len() {
                picked[list] = choice;
            }
            Task::none()
        }
        Msg::SendPicked(message) => {
            let Some(picked) = s.chat.picked.remove(&message) else { return Task::none() };
            let text = picked
                .iter()
                .enumerate()
                .map(|(i, a)| format!("{}. {}", i + 1, a.trim()))
                .collect::<Vec<_>>()
                .join("\n");
            send(s, Some(text))
        }
        Msg::Fold(id) => {
            if !s.chat.unfolded.remove(&id) {
                s.chat.unfolded.insert(id);
            }
            Task::none()
        }
        Msg::Retry(id) => {
            let path = format!("{}/messages/{id}/retry", s.store.chat_path());
            s.call(
                move |api| async move { api.post_empty(&path).await },
                |r| match r {
                    Ok(()) => Message::Nothing,
                    Err(e) if e.status == 409 => Message::Toast("Only the latest reply can be tried again.".into()),
                    Err(e) => failed(e),
                },
            )
        }
        Msg::ReplyInThread(id) => {
            let chat = s.store.conversation_id;
            s.call(
                move |api| async move {
                    api.post::<Conversation, _>(&format!("/conversations/{chat}/threads"), &json!({ "messageId": id }))
                        .await
                },
                |r| Message::Chat(Msg::Threaded(r)),
            )
        }
        Msg::Threaded(r) => match r {
            Ok(c) => {
                let id = c.id;
                s.store.put_conversation(c);
                update(s, Msg::Open(id))
            }
            Err(e) => Task::done(failed(e)),
        },
        Msg::Scrolled(v) => {
            s.chat.near_bottom = v.absolute_offset_reversed().y < 60.0;
            let top = v.absolute_offset().y;
            let mut t = Vec::new();
            if top < v.bounds().height * 1.5
                && s.store.has_earlier
                && let Some(first) = s.store.messages.first().map(|m| m.id)
                && s.chat.earlier_asked != Some(first)
            {
                s.chat.earlier_asked = Some(first);
                let conversation = s.store.conversation_id;
                let path = s.store.page_path(Some(first));
                t.push(s.call(
                    move |api| async move { api.get::<Vec<ThreadMessage>>(&path).await },
                    move |result| Message::Chat(Msg::Earlier { conversation, first, result }),
                ));
            }
            t.push(mark_seen(s));
            return Task::batch(t);
        }
        Msg::ChartFile(path, c) => {
            s.chat.chart_files.insert(path, c.map_or(Loading::Failed, Loading::Got));
            return Task::none();
        }
        Msg::Image(path, bytes) => {
            s.chat.images.insert(path, bytes.map(image::Handle::from_bytes));
            return Task::none();
        }
        Msg::Download(a) => {
            let path = format!("/attachments/{}?download", a.id);
            return s.call(
                move |api| async move {
                    let data = api.bytes(&path).await?;
                    save_and_open(&a.name, &data).map_err(ApiError::new)
                },
                |r| match r {
                    Ok(()) => Message::Nothing,
                    Err(e) => failed(e),
                },
            );
        }
    };
    Task::batch([t, sync(s)])
}

fn load_episodes(s: &Session) -> Task<Message> {
    let ids: Vec<i64> = s
        .store
        .messages
        .iter()
        .filter_map(|m| m.episode_id)
        .filter(|id| !s.store.episodes.contains_key(id))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return Task::none();
    }
    let path = format!(
        "{}/episodes?ids={}",
        s.store.chat_path(),
        ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
    );
    s.call(
        move |api| async move { api.get::<Vec<Episode>>(&path).await },
        |r| r.map(|l| Message::Chat(Msg::Episodes(l))).unwrap_or(Message::Nothing),
    )
}

fn send(s: &mut Session, text: Option<String>) -> Task<Message> {
    let from_composer = text.is_none();
    let text = text.unwrap_or_else(|| s.chat.composer.text()).trim().to_string();
    let ids: Vec<i64> = if from_composer {
        s.chat.files.iter().filter_map(|f| f.uploaded.as_ref().map(|a| a.id)).collect()
    } else {
        Vec::new()
    };
    let uploading = s.chat.files.iter().any(|f| f.uploaded.is_none() && !f.failed);
    if s.chat.sending || (text.is_empty() && ids.is_empty()) || (from_composer && uploading) {
        return Task::none();
    }
    s.chat.sending = true;
    s.chat.error = None;
    let path = format!("{}/messages", s.store.chat_path());
    let body = json!({ "text": text, "attachmentIds": ids, "incognito": s.store.incognito });
    s.call(
        move |api| async move { api.post::<ThreadMessage, _>(&path, &body).await },
        move |r| Message::Chat(Msg::Sent(r, from_composer)),
    )
}

async fn pick_files() -> Vec<(String, String, Vec<u8>)> {
    let Some(files) = rfd::AsyncFileDialog::new().set_title("Attach files").pick_files().await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for f in files {
        let name = f.file_name();
        let data = f.read().await;
        out.push((name.clone(), media_type(&name).to_string(), data));
    }
    out
}

fn media_type(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        _ => "application/octet-stream",
    }
}

/// Saves a file to Downloads and opens it with what the desktop opens it with.
fn save_and_open(name: &str, data: &[u8]) -> Result<(), String> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default();
    let dir = home.join("Downloads");
    let _ = std::fs::create_dir_all(&dir);
    let safe: String = name.chars().map(|c| if c == '/' || c == '\0' { '_' } else { c }).collect();
    let mut path = dir.join(&safe);
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{n} {safe}"));
        n += 1;
    }
    std::fs::write(&path, data).map_err(|_| "Couldn't save the file.".to_string())?;
    let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
    Ok(())
}

// Views

pub fn view<'a>(app: &'a super::app::App, s: &'a Session) -> Element<'a, Message> {
    if s.route == Route::Threads {
        return threads(s);
    }
    let dark = app.dark;
    let store = &s.store;
    let name = store.chat_name(store.current_chat());
    let group = store.current_chat().is_some_and(|c| c.kind == ConversationKind::Group);
    let mut list = column![].spacing(0).width(Length::Fill);
    if store.has_earlier {
        list = list.push(container(small("Loading earlier messages")).center_x(Length::Fill).padding(SP));
    }
    if store.thread_known && store.messages.is_empty() {
        list = list.push(empty(if store.incognito {
            format!("{name} can't see earlier conversations here, and this one is deleted when you leave.")
        } else {
            format!("Say hello to {name}.")
        }));
    }
    let now = format::now();
    let mut previous: Option<jiff::Zoned> = None;
    let mut last_sender: Option<String> = None;
    let last_id = store.messages.last().map(|m| m.id);
    let groups = thread::groups(&store.messages, &store.episodes);
    for g in &groups {
        let folded_id = g.fold.as_ref().and(g.episode_id);
        let open = folded_id.is_some_and(|id| s.chat.unfolded.contains(&id));
        if let (Some(fold), Some(id)) = (&g.fold, g.episode_id) {
            list = list.push(fold_row(fold, g.messages[0], open, id));
            last_sender = None;
        }
        for m in &g.messages {
            if folded_id.is_some() && !open && !store.unread.contains(&m.id) {
                continue;
            }
            let at = format::date(&m.created_at);
            if let Some(at) = &at {
                if let Some(label) = format::pause(at, previous.as_ref(), &now) {
                    list = list.push(
                        container(tiny(label).font(theme::MEDIUM))
                            .center_x(Length::Fill)
                            .padding(Padding::default().top(14).bottom(4)),
                    );
                    last_sender = None;
                }
                previous = Some(at.clone());
            }
            let sender = sender_key(m);
            let joined = last_sender.as_deref() == Some(sender.as_str()) && !m.is_note();
            last_sender = if m.is_note() { None } else { Some(sender) };
            if group && !joined && m.role == Role::Assistant && !m.is_note() && m.kind != MessageKind::Box {
                let color = m.bot_id.as_ref().and_then(|b| store.bots.get(b)).map(|b| b.color.clone());
                list = list.push(
                    container(text(store.bot_name(m.bot_id.as_deref())).size(FS_SM).font(theme::SEMIBOLD).style(
                        move |t: &Theme| text::Style {
                            color: Some(color.as_deref().map_or(theme::colors(t).muted, |c| theme::bot_color(t, c))),
                        },
                    ))
                    .padding(Padding::default().top(10)),
                );
            }
            let row = message(s, m, dark, Some(m.id) == last_id);
            list = list.push(container(row).padding(Padding::default().top(if joined { 2 } else { 10 })));
        }
    }
    let thread = scrollable(
        container(container(list.padding([SP_MD, 0.0])).max_width(MEASURE).width(Length::Fill))
            .center_x(Length::Fill)
            .padding([0.0, SP_XL]),
    )
    .id(scroll_id())
    .anchor_bottom()
    .on_scroll(|v| Message::Chat(Msg::Scrolled(v)))
    .style(theme::scroll)
    .height(Length::Fill);
    column![thread, composer(s, &name)].into()
}

fn sender_key(m: &ThreadMessage) -> String {
    if m.role == Role::User {
        "owner".into()
    } else if m.kind == MessageKind::Box {
        format!("box:{}", m.box_id.unwrap_or(0))
    } else {
        format!("bot:{}", m.bot_id.clone().unwrap_or_default())
    }
}

fn fold_row<'a>(fold: &str, first: &ThreadMessage, open: bool, id: i64) -> Element<'a, Message> {
    let chevron = icons::icon(if open { Icon::Down } else { Icon::Chevron }, 18.0, icons::muted);
    button(
        row![
            chevron,
            text(fold.to_string()).size(FS_MD).width(Length::Fill).style(tone(|c| c.muted)),
            tiny(format::time_text(&first.created_at)),
        ]
        .spacing(SP)
        .align_y(Alignment::Center),
    )
    .padding([SP_SM, SP])
    .width(Length::Fill)
    .style(theme::plain_square)
    .on_press(Message::Chat(Msg::Fold(id)))
    .into()
}

fn md<'a>(s: &'a Session, text: &'a str, dark: bool) -> Element<'a, Message> {
    match s.chat.md.get(text) {
        Some(c) => markdown::view(c, dark, Message::Link),
        None => body(text).into(),
    }
}

/// A reply's Markdown, with the charts in it drawn.
fn with_charts<'a>(s: &'a Session, id: i64, text: &'a str, dark: bool) -> Element<'a, Message> {
    let Some((_, parts)) = s.chat.parts.get(&id).filter(|(t, _)| t == text) else { return md(s, text, dark) };
    let ctx = chart::Ctx { dark, photos: Some(&s.chat.images), open: Message::Link };
    let mut col = column![].spacing(SP_MD);
    for p in parts {
        col = col.push(match p {
            Part::Markdown(t) => md(s, t, dark),
            Part::Chart(c) => chart::view(c, ctx),
            Part::File(f) => match s.chat.chart_files.get(&f.path()) {
                Some(Loading::Got(c)) => chart::view(c, ctx),
                Some(Loading::Failed) => small("This chart's numbers didn't load.").into(),
                _ => chart::pending(),
            },
            Part::Pending => chart::pending(),
        });
    }
    col.into()
}

fn message<'a>(s: &'a Session, m: &'a ThreadMessage, dark: bool, last: bool) -> Element<'a, Message> {
    let store = &s.store;
    if m.is_note() {
        return container(small(m.text.as_str()).align_x(Alignment::Center)).center_x(Length::Fill).into();
    }
    if m.role == Role::User {
        let mut col = column![].spacing(SP_XS).align_x(Alignment::End);
        if !m.attachments.is_empty() {
            col = col.push(files(s, &m.attachments));
        }
        if !m.text.is_empty() {
            col = col.push(
                mouse_area(container(body(m.text.as_str())).padding([10, 16]).max_width(560).style(theme::user_bubble))
                    .on_right_press(Message::Copy(m.text.clone())),
            );
        }
        return container(col).align_right(Length::Fill).padding(Padding::default().left(56)).into();
    }
    let mut col = column![].spacing(SP);
    let task = m.task_id.and_then(|id| store.tasks.get(&id));
    match m.kind {
        MessageKind::Task if m.task_id.is_some() => col = col.push(task_card(s, task, dark)),
        MessageKind::Schedule => {
            let line = match m.schedule_id.and_then(|id| store.schedules.get(&id)) {
                Some(sc) => format!(
                    "Made a schedule: {}, {}.",
                    sc.name,
                    format::when(sc.cron.as_deref(), sc.run_at.as_deref()).to_lowercase()
                ),
                None if m.text.is_empty() => "Made a schedule that's since been deleted.".into(),
                None => m.text.clone(),
            };
            col = col.push(
                row![
                    body(line).width(Length::Fill),
                    btn_sm("Open", theme::outlined, Some(Message::Go(Route::Schedules)))
                ]
                .spacing(SP)
                .align_y(Alignment::Center),
            );
        }
        MessageKind::Box => {
            let title = m.box_id.and_then(|id| store.boxes.get(&id)).map_or("a box".to_string(), |b| b.title.clone());
            // As written, never Markdown: nobody read what the page sends.
            col = col.push(text(format!("From {title}: {}", m.text)).size(FS_TEXT).line_height(1.5));
        }
        MessageKind::Handoff => {
            col = col.push(strong(format!("From {}:", store.bot_name(m.bot_id.as_deref()))));
            col = col.push(md(s, &m.text, dark));
            if let Some(link) = m.link {
                col = col.push(btn_sm(
                    open_label(s, link),
                    theme::outlined,
                    Some(Message::Chat(Msg::Open(link.conversation_id))),
                ));
            } else if let Some(id) = m.task_id {
                col = col.push(btn_sm("Open task", theme::outlined, Some(Message::Go(Route::Task(id)))));
            }
        }
        MessageKind::Thread if m.link.is_some() => {
            let id = m.link.unwrap().conversation_id;
            col = col.push(
                container(
                    row![
                        icons::icon(Icon::Forum, 20.0, icons::muted),
                        text(if m.text.is_empty() { "Thread".to_string() } else { m.text.clone() })
                            .size(FS_TEXT)
                            .width(Length::Fill),
                        btn_sm("Open", theme::outlined, Some(Message::Chat(Msg::Open(id))))
                    ]
                    .spacing(SP_MD)
                    .align_y(Alignment::Center),
                )
                .padding([SP, SP_MD])
                .style(theme::card),
            );
        }
        _ => col = reply(s, m, task, dark, col),
    }
    if m.kind != MessageKind::Box
        && let Some(id) = m.box_id
        && !store.deleted_boxes.contains(&id)
        && let Some(b) = store.boxes.get(&id)
    {
        col = col.push(
            row![
                icons::icon(Icon::Box, 20.0, icons::muted),
                strong(b.title.as_str()).width(Length::Fill),
                btn_sm("Open", theme::outlined, Some(Message::Page(super::pages::Msg::OpenBox(id))))
            ]
            .spacing(SP)
            .align_y(Alignment::Center),
        );
    }
    if m.status != MessageStatus::Streaming && !m.sources.is_empty() {
        let mut links = column![].spacing(2);
        for src in &m.sources {
            let title = if src.title.is_empty() { src.url.clone() } else { src.title.clone() };
            links = links.push(
                button(text(title).size(FS_MD)).padding(0).style(theme::link).on_press(Message::Link(src.url.clone())),
            );
        }
        col = col.push(links);
    }
    if last && m.status != MessageStatus::Streaming && !m.choices.is_empty() {
        col = col.push(choices(s, m));
    }
    if !m.attachments.is_empty() {
        col = col.push(files(s, &m.attachments));
    }
    if m.status == MessageStatus::Error {
        col = col.push(btn_sm("Try again", theme::outlined, Some(Message::Chat(Msg::Retry(m.id)))));
    }
    let threadable = store.current_chat().is_some_and(|c| c.kind == ConversationKind::Direct)
        && !store.incognito
        && m.status == MessageStatus::Done
        && (m.kind == MessageKind::Text
            || (m.kind == MessageKind::Task && task.is_some_and(|t| t.finished_at.is_some())));
    if m.status != MessageStatus::Streaming
        && let Some(at) = &m.edited_at
    {
        col = col.push(text(format!("Edited {}", format::time_text(at))).size(FS_SM).style(tone(|c| c.hue)));
    }
    let unread = store.unread.contains(&m.id);
    let mark = container(Space::new().width(3).height(Length::Fill)).style(move |t: &Theme| container::Style {
        background: unread.then(|| theme::colors(t).hue.into()),
        border: iced::border::rounded(2),
        ..Default::default()
    });
    let copy = store.text(m).to_string();
    let content =
        mouse_area(container(col).padding([SP_XS, 0.0]).width(Length::Fill)).on_right_press(Message::Copy(copy));
    let mut r = row![mark, content].spacing(SP + 1.0);
    if threadable {
        r = r.push(iced::widget::tooltip(
            button(icons::icon(Icon::Forum, 16.0, icons::muted))
                .padding(6)
                .style(theme::plain)
                .on_press(Message::Chat(Msg::ReplyInThread(m.id))),
            container(text("Reply in a thread").size(FS_SM)).padding([4, 8]).style(theme::toast),
            iced::widget::tooltip::Position::Left,
        ));
    }
    r.height(Length::Shrink).into()
}

fn open_label(s: &Session, link: MessageLink) -> String {
    match s.store.conversations.iter().find(|c| c.id == link.conversation_id) {
        None => "Open the other chat".into(),
        Some(c) if c.kind == ConversationKind::Group => format!("Open in {}", s.store.chat_name(Some(c))),
        Some(c) => format!("Open in {}'s chat", s.store.chat_name(Some(c))),
    }
}

fn ended(t: &AgentTask) -> bool {
    !t.status.is_active() && t.status != TaskStatus::Cancelled
}

/// Once its task ends the bot writes the reply again; if it doesn't, the task's result shows in its place.
fn reply<'a>(
    s: &'a Session,
    m: &'a ThreadMessage,
    task: Option<&'a AgentTask>,
    dark: bool,
    mut col: iced::widget::Column<'a, Message>,
) -> iced::widget::Column<'a, Message> {
    let store = &s.store;
    let is_ended = task.is_some_and(ended);
    let shows_result = task.is_some_and(|t| {
        ended(t) && m.status != MessageStatus::Streaming && (m.status == MessageStatus::Error || m.text.is_empty())
    });
    if shows_result {
        col = col.push(task_result(s, task.unwrap(), dark));
        if !m.text.is_empty() {
            col = col.push(md(s, &m.text, dark));
        }
    } else {
        let shown = store.text(m);
        if !shown.is_empty() {
            col = col.push(with_charts(s, m.id, shown, dark));
        }
        if m.status == MessageStatus::Streaming {
            if shown.is_empty() && (m.task_id.is_none() || is_ended) {
                col = col.push(small("…"));
            }
            if let Some(r) = store.replies.get(&m.id) {
                if let Some(note) = format::last_line(&r.progress) {
                    col = col.push(small(note.to_string()));
                }
                if let Some((tokens, usd)) = r.usage {
                    col = col.push(tiny(format!("{} tokens · ${usd:.3}", format::tokens(tokens))));
                }
            }
        }
        if !is_ended && let Some(t) = task {
            col = col.push(task_result(s, t, dark));
        }
    }
    if is_ended
        && m.status != MessageStatus::Streaming
        && let Some(link) = m.link
    {
        col = col.push(btn_sm(
            open_label(s, link),
            theme::outlined,
            Some(Message::Chat(Msg::Open(link.conversation_id))),
        ));
    }
    col
}

fn task_result<'a>(s: &'a Session, t: &'a AgentTask, dark: bool) -> Element<'a, Message> {
    let col = if t.status.is_active() {
        column![small(running_note(s, t))]
    } else if t.status == TaskStatus::Done {
        column![md(s, t.summary.as_deref().unwrap_or("Done."), dark)]
    } else if t.status == TaskStatus::Failed {
        column![strong("Didn't finish."), md(s, t.summary.as_deref().unwrap_or(""), dark)]
    } else {
        column![small("Cancelled.")]
    };
    col.spacing(SP).into()
}

fn running_note(s: &Session, t: &AgentTask) -> String {
    let owner = s.store.desktop.as_ref().is_some_and(|d| d.control == Control::Owner);
    if owner && t.status == TaskStatus::Running {
        "Paused while you have control.".into()
    } else {
        format::task_line(t, s.store.task_progress.get(&t.id).map(String::as_str))
    }
}

fn task_card<'a>(s: &'a Session, task: Option<&'a AgentTask>, dark: bool) -> Element<'a, Message> {
    let Some(t) = task else { return small("…").into() };
    let head = match (t.status.is_active(), t.status) {
        (true, _) | (false, TaskStatus::Done) => t.title.clone(),
        (false, TaskStatus::Failed) => format!("{} didn't finish.", t.title),
        _ => format!("{} was cancelled.", t.title),
    };
    let mut col = column![
        button(strong(head))
            .padding(0)
            .style(|t: &Theme, st| iced::widget::button::Style {
                text_color: theme::colors(t).text,
                ..theme::link(t, st)
            })
            .on_press(Message::Go(Route::Task(t.id)))
    ]
    .spacing(SP);
    if !t.status.is_active() {
        match t.status {
            TaskStatus::Done => col = col.push(md(s, t.summary.as_deref().unwrap_or("Done."), dark)),
            TaskStatus::Failed => {
                if let Some(sum) = &t.summary {
                    col = col.push(md(s, sum, dark));
                }
            }
            _ => {}
        }
    } else {
        col = col.push(small(running_note(s, t)));
    }
    col.into()
}

fn files<'a>(s: &'a Session, list: &'a [Attachment]) -> Element<'a, Message> {
    let mut r = row![].spacing(SP);
    let mut pictures = column![].spacing(SP);
    for a in list {
        if a.is_picture()
            && let Some(Some(h)) = s.chat.images.get(&format!("/attachments/{}?w=640", a.id))
        {
            pictures = pictures.push(
                button(image(h.clone()).width(Length::Shrink).height(Length::Shrink))
                    .padding(0)
                    .style(theme::plain_square)
                    .on_press(Message::Chat(Msg::Download(a.clone()))),
            );
            continue;
        }
        r = r.push(
            button(
                row![icons::icon(Icon::File, 18.0, icons::muted), text(a.name.as_str()).size(FS_MD)]
                    .spacing(SP_SM)
                    .align_y(Alignment::Center),
            )
            .padding([SP_SM, SP_MD])
            .style(theme::chip(false))
            .on_press(Message::Chat(Msg::Download(a.clone()))),
        );
    }
    column![pictures, r.wrap()].spacing(SP).into()
}

fn choices<'a>(s: &'a Session, m: &'a ThreadMessage) -> Element<'a, Message> {
    let busy = s.chat.sending;
    if m.choices.len() == 1 {
        let mut r = row![].spacing(SP);
        for c in &m.choices[0] {
            r = r.push(btn_sm(c.as_str(), theme::outlined, (!busy).then(|| Message::Chat(Msg::Choose(c.clone())))));
        }
        return r.wrap().into();
    }
    let picked = s.chat.picked.get(&m.id);
    let mut col = column![].spacing(SP_MD);
    for (i, list) in m.choices.iter().enumerate() {
        let current = picked.and_then(|p| p.get(i)).cloned().unwrap_or_default();
        let mut opts = row![tiny(format!("{}.", i + 1))].spacing(SP).align_y(Alignment::Center);
        if list.is_empty() {
            let id = m.id;
            opts = opts.push(
                input(&format!("Answer {}", i + 1), &current, move |v| {
                    Message::Chat(Msg::Pick { message: id, list: i, choice: v })
                })
                .width(320),
            );
        } else {
            for c in list {
                let on = *c == current;
                opts = opts.push(
                    button(text(c.as_str()).size(FS_MD))
                        .padding([SP_SM, SP_MD])
                        .style(theme::chip(on))
                        .on_press(Message::Chat(Msg::Pick { message: m.id, list: i, choice: c.clone() })),
                );
            }
        }
        col = col.push(opts.wrap());
    }
    let ready = picked.is_some_and(|p| p.len() == m.choices.len() && p.iter().all(|a| !a.trim().is_empty()));
    col.push(btn_sm("Send", theme::primary, (ready && !busy).then_some(Message::Chat(Msg::SendPicked(m.id))))).into()
}

/// The first thing waiting on you, above the composer, in plain text.
fn waiting(s: &Session) -> Option<Element<'_, Message>> {
    let chat = s.store.conversation_id;
    // What the review blocked shows only in its own chat; a task's shows on the task.
    let approvals: Vec<&Approval> = s
        .store
        .approvals
        .values()
        .filter(|a| match a.status {
            ApprovalStatus::Pending | ApprovalStatus::Sending => true,
            ApprovalStatus::Blocked => a.task_id.is_none() && a.conversation_id == Some(chat),
            _ => false,
        })
        .collect();
    let questions = s.store.pending_questions();
    let count = approvals.len() + questions.len();
    let body: Element<'_, Message> =
        if let Some(a) = approvals.first() { approval(s, a) } else { question(s, questions.first()?) };
    let mut col = column![body].spacing(SP_MD);
    if count > 1 {
        col = col.push(small(format!("{} more waiting", count - 1)));
    }
    Some(container(col).padding(SP_LG).width(Length::Fill).style(theme::attention).into())
}

pub fn approval<'a>(s: &'a Session, a: &'a Approval) -> Element<'a, Message> {
    match a.status {
        ApprovalStatus::Blocked => blocked(s, a),
        ApprovalStatus::Sending => sending(s, a),
        _ => pending(s, a),
    }
}

fn pending<'a>(s: &'a Session, a: &'a Approval) -> Element<'a, Message> {
    let busy = s.chat.busy.contains(&format!("a{}", a.id));
    let id = a.id;
    let mut col = column![
        text(format!("{} asks", s.store.bot_name(Some(&a.bot_id))))
            .size(FS_SM)
            .font(theme::MEDIUM)
            .style(tone(|c| c.muted)),
        text(format!("Can I go ahead? {}", a.summary)).size(theme::FS_TEXT).line_height(1.5)
    ]
    .spacing(SP);
    if !a.reason.is_empty() {
        col = col.push(body(a.reason.as_str()));
    }
    if !a.sources.is_empty() {
        col = col.push(small(format!("After reading {}", a.sources.join(", "))));
    }
    if let (Some(task), Some(step)) = (a.task_id, a.screenshot_step_id)
        && let Some(Some(h)) = s.chat.images.get(&format!("/tasks/{task}/screens/{step}"))
    {
        col = col.push(container(image(h.clone()).width(Length::Fill)).max_height(320).style(theme::screen));
    }
    if a.kind.takes_note() {
        let note = s.chat.notes.get(&id).map(String::as_str).unwrap_or("");
        col = col.push(input("Tell it what to do instead, or how to go ahead", note, move |v| {
            Message::Chat(Msg::Note(id, v))
        }));
    }
    let mut buttons = row![
        btn_wide(
            "Deny",
            theme::deny,
            (!busy).then_some(Message::Chat(Msg::Decide { id, approve: false, scope: None, answer: None }))
        ),
        btn_wide(
            "Approve",
            theme::primary,
            (!busy).then_some(Message::Chat(Msg::Decide { id, approve: true, scope: None, answer: None }))
        ),
    ]
    .spacing(SP_LG);
    if let Some(task) = a.task_id {
        buttons = buttons.push(btn("Open task", theme::outlined, Some(Message::Go(Route::Task(task)))));
    }
    col = col.push(buttons);
    let mut more = row![].spacing(SP_LG);
    for (scope, label) in [("always", "Always"), ("schedule", "Always for this schedule")] {
        if a.scopes.iter().any(|x| x == scope) {
            more = more.push(btn_sm(
                label,
                theme::plain,
                (!busy).then_some(Message::Chat(Msg::Decide {
                    id,
                    approve: true,
                    scope: Some(scope.into()),
                    answer: None,
                })),
            ));
        }
    }
    for answer in &a.answers {
        more = more.push(btn_sm(
            answer.as_str(),
            theme::plain,
            (!busy)
                .then(|| Message::Chat(Msg::Decide { id, approve: true, scope: None, answer: Some(answer.clone()) })),
        ));
    }
    if a.task_id.is_none()
        && !a.sources.is_empty()
        && let (Some(chat), Some(episode)) = (a.conversation_id, a.episode_id)
        && !s.chat.trusted.contains(&episode)
    {
        more = more.push(btn_sm("Trust this chat", theme::plain, Some(Message::Chat(Msg::Trust(chat, episode)))));
    }
    col.push(more).into()
}

/// What the safety review blocked: nothing waits on it, but you may run it anyway.
fn blocked<'a>(s: &'a Session, a: &'a Approval) -> Element<'a, Message> {
    let busy = s.chat.busy.contains(&format!("a{}", a.id));
    let id = a.id;
    let live = a.task_id.is_none_or(|t| s.store.tasks.get(&t).is_some_and(|t| t.status.is_active()));
    let mut col = column![text(format!("Blocked: {}", a.summary)).size(theme::FS_TEXT).line_height(1.5)].spacing(SP);
    if !a.reason.is_empty() {
        col = col.push(body(a.reason.as_str()));
    }
    let mut buttons =
        row![btn_wide("Dismiss", theme::outlined, (!busy).then_some(Message::Chat(Msg::Dismiss(id))))].spacing(SP_LG);
    if a.scopes.iter().any(|x| x == "always") {
        buttons = buttons.push(btn_wide(
            "Always",
            theme::outlined,
            (!busy).then_some(Message::Chat(Msg::RunAnyway { id, always: true })),
        ));
    }
    if live {
        buttons = buttons.push(btn_wide(
            "Run anyway",
            theme::primary,
            (!busy).then_some(Message::Chat(Msg::RunAnyway { id, always: false })),
        ));
    }
    if let Some(task) = a.task_id {
        buttons = buttons.push(btn("Open task", theme::outlined, Some(Message::Go(Route::Task(task)))));
    }
    col.push(buttons).into()
}

/// A message to a person that goes once its time is up, unless you stop it.
fn sending<'a>(s: &'a Session, a: &'a Approval) -> Element<'a, Message> {
    let busy = s.chat.busy.contains(&format!("a{}", a.id));
    let id = a.id;
    let left = format::seconds_left(&a.expires_at);
    column![
        text(a.summary.as_str()).size(theme::FS_TEXT).line_height(1.5),
        body(if left > 0 { format!("Sending in {left} s") } else { "Sending".into() }),
        row![btn_wide(
            "Stop",
            theme::deny,
            (!busy && left > 0).then_some(Message::Chat(Msg::Decide { id, approve: false, scope: None, answer: None }))
        )]
    ]
    .spacing(SP)
    .into()
}

pub fn question<'a>(s: &'a Session, q: &'a Question) -> Element<'a, Message> {
    let busy = s.chat.busy.contains(&format!("q{}", q.id));
    let id = q.id;
    let mut col = column![
        text(format!("{} asks", s.store.bot_name(Some(&q.bot_id))))
            .size(FS_SM)
            .font(theme::MEDIUM)
            .style(tone(|c| c.muted)),
        strong(q.question.as_str())
    ]
    .spacing(SP);
    if !q.sources.is_empty() {
        col = col.push(small(format!("After reading {}", q.sources.join(", "))));
    }
    let mut opts = row![].spacing(SP);
    for c in &q.choices {
        opts = opts.push(btn(c.as_str(), theme::primary, (!busy).then(|| Message::Chat(Msg::Answer(id, c.clone())))));
    }
    if !q.choices.is_empty() {
        col = col.push(opts.wrap());
    }
    let own = s.chat.own.get(&id).cloned().unwrap_or_default();
    let send = (!busy && !own.trim().is_empty()).then(|| Message::Chat(Msg::Answer(id, own.clone())));
    col = col.push(
        row![
            input(if q.choices.is_empty() { "Your answer" } else { "Or write your own" }, &own, move |v| {
                Message::Chat(Msg::Own(id, v))
            })
            .on_submit_maybe(send.clone()),
            btn("Send", theme::outlined, send)
        ]
        .spacing(SP)
        .align_y(Alignment::Center),
    );
    col = col.push(btn_sm("Open task", theme::plain, Some(Message::Go(Route::Task(q.task_id)))));
    col.into()
}

fn composer<'a>(s: &'a Session, name: &str) -> Element<'a, Message> {
    let mut col = column![].spacing(SP);
    if let Some(w) = waiting(s) {
        col = col.push(w);
    }
    if let Some(e) = &s.chat.error {
        col = col.push(error(e.as_str()));
    }
    if !s.chat.files.is_empty() {
        let mut r = row![].spacing(SP);
        for f in &s.chat.files {
            let state = if f.failed {
                " (didn't upload)"
            } else if f.uploaded.is_none() {
                " (uploading)"
            } else {
                ""
            };
            r = r.push(
                container(
                    row![
                        text(format!("{}{state}", f.name)).size(FS_MD),
                        button(icons::icon(Icon::X, 16.0, icons::muted))
                            .padding(2)
                            .style(theme::plain)
                            .on_press(Message::Chat(Msg::Unattach(f.id)))
                    ]
                    .spacing(SP_SM)
                    .align_y(Alignment::Center),
                )
                .padding(Padding::default().left(SP_MD).right(SP_XS).top(SP_XS).bottom(SP_XS))
                .style(theme::card),
            );
        }
        col = col.push(r.wrap());
    }
    let placeholder = if s.store.incognito { format!("Message {name}, incognito") } else { format!("Message {name}") };
    let editor = text_editor(&s.chat.composer)
        .placeholder(placeholder)
        .on_action(|a| Message::Chat(Msg::Edit(a)))
        .key_binding(|k| {
            if let keyboard::Key::Named(keyboard::key::Named::Enter) = k.key
                && !k.modifiers.shift()
            {
                return Some(text_editor::Binding::Custom(Message::Chat(Msg::Send)));
            }
            text_editor::Binding::from_key_press(k)
        })
        .size(FS_TEXT)
        .line_height(1.5)
        .padding([10, 8])
        // The editor adds its padding after the minimum.
        .min_height(H - 20.0)
        .max_height(240)
        .style(theme::composer_field);
    let can_send = !s.chat.sending
        && (!s.chat.composer.text().trim().is_empty() || s.chat.files.iter().any(|f| f.uploaded.is_some()));
    let send = button(container(icons::icon(Icon::Up, 20.0, icons::on_hue)).center(Length::Fill))
        .width(H)
        .height(H)
        .padding(0)
        .style(theme::primary)
        .on_press_maybe(can_send.then_some(Message::Chat(Msg::Send)));
    let attach = button(container(icons::icon(Icon::Clip, 20.0, icons::text_2)).center(Length::Fill))
        .width(H)
        .height(H)
        .padding(0)
        .style(theme::plain)
        .on_press(Message::Chat(Msg::Attach));
    let one_line = s.chat.composer.line_count() <= 1;
    let well = container(row![attach, editor, send].spacing(SP_XS).align_y(if one_line {
        Alignment::Center
    } else {
        Alignment::End
    }))
    .padding(SP_XS)
    .style(theme::well);
    col = col.push(well);
    container(container(col).max_width(MEASURE).width(Length::Fill))
        .center_x(Length::Fill)
        .padding(Padding::default().left(SP_XL).right(SP_XL).bottom(SP_LG).top(SP))
        .into()
}

fn threads(s: &Session) -> Element<'_, Message> {
    let parent = s.store.current_chat().map(|c| c.id).unwrap_or(0);
    let mut list: Vec<&Conversation> = s.store.threads.values().filter(|t| t.parent_id == Some(parent)).collect();
    list.sort_by(|a, b| b.last_message_at.cmp(&a.last_message_at));
    let mut col = column![].spacing(SP_SM);
    if list.is_empty() {
        col = col.push(empty("No threads yet. Reply to a message in a thread to start one."));
    }
    for t in list {
        let needs = s.store.thread_needs_you(t);
        let mut words = column![text(s.store.chat_name(Some(t))).size(FS_TEXT).font(theme::MEDIUM)].spacing(2);
        if let Some(l) = t.latest.as_deref().or(t.outcome.as_deref()) {
            words = words.push(small(l.to_string()));
        }
        let mut r = row![words.width(Length::Fill)].spacing(SP_MD).align_y(Alignment::Center);
        if needs {
            r = r.push(text("Needs you").size(FS_SM).font(theme::MEDIUM).style(tone(|c| c.hue)));
        } else if t.resolved_at.is_some() {
            r = r.push(tiny("Resolved"));
        }
        if t.unread > 0 {
            r = r.push(super::widgets::count(t.unread as usize));
        }
        col = col.push(
            button(r)
                .padding([SP_MD, SP_LG])
                .width(Length::Fill)
                .style(theme::row(false))
                .on_press(Message::Chat(Msg::Open(t.id))),
        );
    }
    super::widgets::page(col)
}
