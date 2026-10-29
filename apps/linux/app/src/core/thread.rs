// The chat in folds (threadGroups in packages/shared, ThreadFolds in iOS).
use std::collections::HashMap;

use super::models::{Episode, MessageKind, Role, ThreadMessage};

const MAX_FALLBACK: usize = 120;

#[derive(Debug, Clone, PartialEq)]
pub struct Group<'a> {
    pub episode_id: Option<i64>,
    pub messages: Vec<&'a ThreadMessage>,
    /// What the fold says, for a finished conversation; None while it stays open.
    pub fold: Option<String>,
}

/// Messages in runs by conversation; cards from background tasks join the conversation before them.
/// Every conversation but the last folds; one without a recap shows its first message instead.
pub fn groups<'a>(messages: &'a [ThreadMessage], episodes: &HashMap<i64, Episode>) -> Vec<Group<'a>> {
    let mut groups: Vec<Group<'a>> = Vec::new();
    for m in messages {
        let key = m.episode_id.or_else(|| groups.last().and_then(|g| g.episode_id));
        match groups.last_mut() {
            Some(g) if g.episode_id == key => g.messages.push(m),
            _ => groups.push(Group { episode_id: key, messages: vec![m], fold: None }),
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
            first.chars().take(MAX_FALLBACK - 1).collect::<String>() + "…"
        } else {
            first
        };
        let recap = episodes.get(&id).and_then(|e| e.recap.clone()).unwrap_or_default();
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
