// What the daemon shows as desktop notifications, and what their buttons do.
use serde_json::{Value, json};

use super::models::{Approval, ApprovalStatus, Question, QuestionStatus, Task, TaskStatus};

#[derive(Debug, Clone, PartialEq)]
pub enum Notice {
    Approval(Approval),
    Question(Question),
    TaskEnded(Task),
}

/// Where clicking a notification, or a button it can't answer from, opens the window.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Approval(i64),
    Question(i64),
    Task(i64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Shown {
    /// Same key, same notification: a newer one replaces it.
    pub key: String,
    pub summary: String,
    pub body: String,
    /// (action key, label). Approvals and questions are plain text, never Markdown.
    pub actions: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    /// Answer it from the notification: POST this body to this path.
    Call {
        path: String,
        body: Value,
    },
    Open(Target),
}

impl Notice {
    pub fn key(&self) -> String {
        match self {
            Notice::Approval(a) => format!("approval-{}", a.id),
            Notice::Question(q) => format!("question-{}", q.id),
            Notice::TaskEnded(t) => format!("task-{}", t.id),
        }
    }

    pub fn target(&self) -> Target {
        match self {
            Notice::Approval(a) => Target::Approval(a.id),
            Notice::Question(q) => Target::Question(q.id),
            Notice::TaskEnded(t) => Target::Task(t.id),
        }
    }

    /// Whether it still waits on you: one answered elsewhere is taken down.
    pub fn is_open(&self) -> bool {
        match self {
            Notice::Approval(a) => a.status == ApprovalStatus::Pending,
            Notice::Question(q) => q.status == QuestionStatus::Pending,
            Notice::TaskEnded(_) => true,
        }
    }

    pub fn shown(&self, bot: &str) -> Shown {
        let key = self.key();
        match self {
            Notice::Approval(a) => Shown {
                key,
                summary: format!("{bot} asks"),
                body: a.summary.clone(),
                // Money, passwords and keys are only answered in the window.
                actions: if a.kind.is_floor() {
                    vec![("default".into(), "Open".into())]
                } else {
                    vec![
                        ("default".into(), "Open".into()),
                        ("approve".into(), "Approve".into()),
                        ("deny".into(), "Deny".into()),
                    ]
                },
            },
            Notice::Question(q) => {
                let mut actions = vec![("default".to_string(), "Open".to_string())];
                actions.extend(q.choices.iter().take(4).enumerate().map(|(i, c)| (format!("answer:{i}"), c.clone())));
                Shown { key, summary: format!("{bot} asks"), body: q.question.clone(), actions }
            }
            Notice::TaskEnded(t) => Shown {
                key,
                summary: match t.status {
                    TaskStatus::Failed => format!("Failed: {}", t.title),
                    _ => format!("Done: {}", t.title),
                },
                body: t.summary.clone().unwrap_or_default(),
                actions: vec![("default".into(), "Open".into())],
            },
        }
    }

    /// What pressing a notification's button does.
    pub fn reply(&self, action: &str) -> Reply {
        match (self, action) {
            (Notice::Approval(a), "approve" | "deny") if !a.kind.is_floor() => {
                Reply::Call { path: format!("/approvals/{}", a.id), body: json!({ "decision": action }) }
            }
            (Notice::Question(q), a) => match a.strip_prefix("answer:").and_then(|i| i.parse::<usize>().ok()) {
                Some(i) if i < q.choices.len() => {
                    Reply::Call { path: format!("/questions/{}", q.id), body: json!({ "answer": q.choices[i] }) }
                }
                _ => Reply::Open(self.target()),
            },
            _ => Reply::Open(self.target()),
        }
    }
}

/// What deciding an approval posts. The brain takes a missing note or scope, never a null one.
pub fn decision(approve: bool, note: Option<&str>, scope: Option<&str>) -> Value {
    let mut body = json!({ "decision": if approve { "approve" } else { "deny" } });
    if let Some(n) = note.map(str::trim).filter(|n| !n.is_empty()) {
        body["note"] = json!(n);
    }
    if let Some(sc) = scope {
        body["scope"] = json!(sc);
    }
    body
}

/// A task that just ended is worth a notification; one that was already over isn't.
pub fn task_ended(before: Option<&Task>, now: &Task) -> bool {
    matches!(now.status, TaskStatus::Done | TaskStatus::Failed) && before.is_some_and(|b| b.status.is_active())
}
