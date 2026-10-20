// The chat as loaded: pages merged after a reconnect, and folds (threadGroups in packages/shared).
use std::collections::HashMap;

use super::models::{Episode, MessageKind, Role, ThreadMessage};

/// The latest page, fetched again after a reconnect or on coming back to a chat, merged into what's
/// loaded; with whether there are earlier ones to load. The page is the truth from its first message
/// on, so one deleted meanwhile goes; earlier pages you'd loaded stay, unless more than a page came
/// while away. Messages newer than the page arrived by event while it loaded, and stay too.
pub fn merge(
    loaded: Vec<ThreadMessage>,
    has_earlier: bool,
    latest: Vec<ThreadMessage>,
    page: usize,
) -> (Vec<ThreadMessage>, bool) {
    let full = latest.len() == page;
    let (Some(floor), Some(top), Some(last)) = (
        latest.first().map(|m| m.id),
        latest.last().map(|m| m.id),
        loaded.last().map(|m| m.id),
    ) else {
        return (latest, full);
    };
    if full && last < floor {
        return (latest, true);
    }
    // A short page is all there is: anything loaded before it was deleted.
    let before: Vec<_> = if full {
        loaded.iter().filter(|m| m.id < floor).cloned().collect()
    } else {
        vec![]
    };
    let after = loaded.into_iter().filter(|m| m.id > top);
    let earlier = if before.is_empty() { full } else { has_earlier };
    (
        before.into_iter().chain(latest).chain(after).collect(),
        earlier,
    )
}

/// A run of messages from one conversation.
pub struct Group {
    pub episode_id: Option<i64>,
    pub messages: Vec<ThreadMessage>,
    /// What the fold says, for a finished conversation; None while it stays open.
    pub fold: Option<String>,
}

const MAX_FALLBACK: usize = 120;

/// Messages in runs by conversation. Cards from background tasks join the conversation before them.
/// Every conversation but the last folds; one without a recap shows your first message instead.
pub fn groups(messages: &[ThreadMessage], episodes: &HashMap<i64, Episode>) -> Vec<Group> {
    let mut groups: Vec<Group> = vec![];
    for m in messages {
        let key = m.episode_id.or(groups.last().and_then(|g| g.episode_id));
        match groups.last_mut() {
            Some(g) if g.episode_id == key => g.messages.push(m.clone()),
            _ => groups.push(Group {
                episode_id: key,
                messages: vec![m.clone()],
                fold: None,
            }),
        }
    }
    let n = groups.len();
    for g in groups.iter_mut().take(n.saturating_sub(1)) {
        let Some(id) = g.episode_id else { continue };
        let first = g
            .messages
            .iter()
            .find(|m| m.role == Role::User && m.kind != MessageKind::Command)
            .map(|m| m.text.split_whitespace().collect::<Vec<_>>().join(" "))
            .unwrap_or_default();
        let fallback = if first.chars().count() > MAX_FALLBACK {
            format!(
                "{}…",
                first.chars().take(MAX_FALLBACK - 1).collect::<String>()
            )
        } else {
            first
        };
        let recap = episodes
            .get(&id)
            .and_then(|e| e.recap.clone())
            .unwrap_or_default();
        g.fold = Some(if !recap.is_empty() {
            recap
        } else if !fallback.is_empty() {
            fallback
        } else {
            "Earlier conversation".into()
        });
    }
    groups
}
