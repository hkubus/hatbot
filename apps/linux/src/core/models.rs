// The API types the app uses, mirrored from packages/shared (PLAN.md §8), as iOS's Models.swift does.
// Decoding is lenient: an event or enum value a newer brain adds decodes as `Unknown`, not an error.
use serde::{Deserialize, Serialize};

pub const HATBOT_ID: &str = "hatbot";

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub setup_done: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct LoginResponse {
    /// Absent from a brain too old for apps.
    pub token: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    Text,
    Task,
    Schedule,
    Command,
    Box,
    Handoff,
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageStatus {
    Streaming,
    Done,
    Error,
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    pub id: i64,
    pub role: Role,
    /// Missing on brains from before bots, which have only Hatbot's chat.
    #[serde(default = "first_chat")]
    pub conversation_id: i64,
    #[serde(default)]
    pub bot_id: Option<String>,
    pub kind: MessageKind,
    pub text: String,
    pub status: MessageStatus,
    pub created_at: String,
    #[serde(default)]
    pub task_id: Option<i64>,
    #[serde(default)]
    pub schedule_id: Option<i64>,
    #[serde(default)]
    pub box_id: Option<i64>,
    #[serde(default)]
    pub link: Option<MessageLink>,
    #[serde(default)]
    pub episode_id: Option<i64>,
    #[serde(default)]
    pub edited_at: Option<String>,
    #[serde(default)]
    pub seen_at: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    #[serde(default)]
    pub incognito: bool,
    #[serde(default)]
    pub sources: Vec<Source>,
    #[serde(default)]
    pub choices: Vec<Vec<String>>,
}

fn first_chat() -> i64 {
    1
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageLink {
    pub conversation_id: i64,
    pub message_id: i64,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct Source {
    pub url: String,
    pub title: String,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: i64,
    pub name: String,
    pub media_type: String,
    pub size: i64,
    pub from: String,
    pub created_at: String,
    /// Data a task handed the chat's bot: not shown in the chat.
    #[serde(default)]
    pub for_chat: bool,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub id: i64,
    pub started_at: String,
    pub last_activity_at: String,
    pub recap: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Running,
    WaitingApproval,
    WaitingTakeover,
    WaitingAnswer,
    Done,
    Failed,
    Cancelled,
    #[serde(other)]
    Unknown,
}

impl TaskStatus {
    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Queued
                | Self::Running
                | Self::WaitingApproval
                | Self::WaitingTakeover
                | Self::WaitingAnswer
        )
    }
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: i64,
    pub bot_id: String,
    #[serde(default)]
    pub requested_by: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<i64>,
    pub title: String,
    pub goal: String,
    pub origin: String,
    pub lane: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub schedule_id: Option<i64>,
    #[serde(default)]
    pub trigger_id: Option<i64>,
    #[serde(default)]
    pub parent_id: Option<i64>,
    pub model: String,
    #[serde(default)]
    pub research: bool,
    #[serde(default)]
    pub report_path: Option<String>,
    pub status: TaskStatus,
    pub tainted: bool,
    #[serde(default)]
    pub tainted_by: Option<String>,
    #[serde(default)]
    pub injection_suspected: bool,
    pub summary: Option<String>,
    pub cost_usd: f64,
    pub steps: i64,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    Note,
    Action,
    Screenshot,
    Page,
    Approval,
    Takeover,
    Error,
    Task,
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskStep {
    pub id: i64,
    pub task_id: i64,
    pub kind: StepKind,
    pub name: String,
    pub detail: String,
    pub screenshot: Option<String>,
    pub url: Option<String>,
    pub created_at: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct TaskWithSteps {
    pub task: Task,
    pub steps: Vec<TaskStep>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalKind {
    Send,
    SubmitPersonalData,
    Purchase,
    Payment,
    Delete,
    AccountSecurity,
    Access,
    InjectionWarning,
    Budget,
    Mandate,
    Other,
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
    Expired,
    Cancelled,
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: i64,
    #[serde(default = "hatbot")]
    pub bot_id: String,
    pub task_id: Option<i64>,
    #[serde(default)]
    pub conversation_id: Option<i64>,
    pub kind: ApprovalKind,
    pub summary: String,
    pub reason: String,
    #[serde(default)]
    pub sources: Vec<String>,
    pub screenshot_step_id: Option<i64>,
    pub status: ApprovalStatus,
    pub cost_usd: f64,
    pub created_at: String,
    pub expires_at: String,
    pub decided_at: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

fn hatbot() -> String {
    HATBOT_ID.to_string()
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuestionStatus {
    Pending,
    Answered,
    Expired,
    Cancelled,
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: i64,
    #[serde(default = "hatbot")]
    pub bot_id: String,
    pub task_id: i64,
    #[serde(default)]
    pub conversation_id: Option<i64>,
    pub question: String,
    #[serde(default)]
    pub choices: Vec<String>,
    #[serde(default)]
    pub sources: Vec<String>,
    pub status: QuestionStatus,
    pub answer: Option<String>,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Control {
    Hatbot,
    Owner,
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverRequest {
    pub task_id: i64,
    pub reason: String,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    pub online: bool,
    pub control: Control,
    pub request: Option<TakeoverRequest>,
    pub active_task_id: Option<i64>,
    #[serde(default)]
    pub bot_id: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: i64,
    #[serde(default = "hatbot")]
    pub bot_id: String,
    pub name: String,
    pub cron: Option<String>,
    pub run_at: Option<String>,
    pub prompt: String,
    pub enabled: bool,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub last_task_id: Option<i64>,
    #[serde(default)]
    pub tainted: bool,
}

/// A small web app a bot made for you (PLAN.md §21; packages/shared/src/box.ts).
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppBox {
    pub id: i64,
    pub bot_id: String,
    pub conversation_id: Option<i64>,
    pub title: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub color: String,
    #[serde(default)]
    pub instructions: String,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationKind {
    Direct,
    Group,
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: i64,
    pub kind: ConversationKind,
    pub title: Option<String>,
    pub bot_ids: Vec<String>,
    pub unread: i64,
    pub last_message_at: Option<String>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplyUsage {
    pub tokens: i64,
    pub cost_usd: f64,
}

/// Live events on /api/v1/stream. Only the ones the app uses are spelled out.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type")]
pub enum Event {
    #[serde(rename = "message.created")]
    MessageCreated { message: ThreadMessage },
    /// `at`: where `text` starts in the reply, in UTF-16 units.
    #[serde(rename = "message.delta")]
    MessageDelta {
        id: i64,
        text: String,
        at: Option<usize>,
    },
    #[serde(rename = "message.progress")]
    MessageProgress { id: i64, text: String },
    #[serde(rename = "message.done")]
    MessageDone {
        id: i64,
        text: String,
        status: MessageStatus,
        sources: Option<Vec<Source>>,
        choices: Option<Vec<Vec<String>>>,
    },
    #[serde(rename = "message.task")]
    MessageTask {
        id: i64,
        #[serde(rename = "taskId")]
        task_id: i64,
    },
    #[serde(rename = "message.link")]
    MessageLinked { id: i64, link: MessageLink },
    #[serde(rename = "message.box")]
    MessageBox {
        id: i64,
        #[serde(rename = "boxId")]
        box_id: i64,
    },
    #[serde(rename = "message.edited")]
    MessageEdited {
        id: i64,
        #[serde(rename = "editedAt")]
        edited_at: String,
    },
    #[serde(rename = "message.rewrite")]
    MessageRewrite { id: i64 },
    #[serde(rename = "message.attachment")]
    MessageAttachment { id: i64, attachment: Attachment },
    #[serde(rename = "message.seen")]
    MessageSeen {
        ids: Vec<i64>,
        #[serde(rename = "seenAt")]
        seen_at: String,
    },
    #[serde(rename = "message.deleted")]
    MessageDeleted { ids: Vec<i64> },
    #[serde(rename = "message.usage")]
    MessageUsage {
        id: i64,
        tokens: i64,
        #[serde(rename = "costUsd")]
        cost_usd: f64,
    },
    #[serde(rename = "spend.updated")]
    SpendUpdated {
        #[serde(rename = "todayUsd")]
        today_usd: f64,
        #[serde(rename = "monthUsd")]
        month_usd: f64,
    },
    #[serde(rename = "memory.committed")]
    MemoryCommitted {
        sha: String,
        message: String,
        author: String,
    },
    #[serde(rename = "paused")]
    Paused { paused: bool },
    #[serde(rename = "task.updated")]
    TaskUpdated { task: Task },
    #[serde(rename = "task.step")]
    TaskStepAdded { step: TaskStep },
    #[serde(rename = "task.progress")]
    TaskProgress {
        #[serde(rename = "taskId")]
        task_id: i64,
        text: String,
    },
    #[serde(rename = "approval.created", alias = "approval.resolved")]
    ApprovalChanged { approval: Approval },
    #[serde(rename = "question.created", alias = "question.resolved")]
    QuestionChanged { question: Question },
    #[serde(rename = "desktop.state")]
    Desktop { state: DesktopState },
    #[serde(rename = "schedule.updated")]
    ScheduleUpdated { schedule: Schedule },
    #[serde(rename = "schedule.deleted")]
    ScheduleDeleted { id: i64 },
    #[serde(rename = "episode.updated")]
    EpisodeUpdated { episode: Episode },
    #[serde(rename = "box.updated")]
    BoxUpdated {
        #[serde(rename = "box")]
        app: AppBox,
    },
    #[serde(rename = "box.deleted")]
    BoxDeleted { id: i64 },
    #[serde(rename = "bot.updated")]
    BotUpdated { bot: Bot },
    #[serde(rename = "bot.deleted")]
    BotDeleted { id: String },
    #[serde(rename = "conversation.updated")]
    ConversationUpdated { conversation: Conversation },
    #[serde(rename = "conversation.deleted")]
    ConversationDeleted { id: i64 },
    #[serde(rename = "settings.updated")]
    SettingsUpdated,
    #[serde(other)]
    Unknown,
}

impl Event {
    /// An event from the stream; one this app can't read is `Unknown`.
    pub fn parse(text: &str) -> Event {
        serde_json::from_str(text).unwrap_or(Event::Unknown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_and_values_a_newer_brain_adds_decode_as_unknown() {
        assert_eq!(
            Event::parse(r#"{"type":"teach.updated","session":{}}"#),
            Event::Unknown
        );
        let e = Event::parse(r#"{"type":"paused","paused":true}"#);
        assert_eq!(e, Event::Paused { paused: true });
        let s: TaskStatus = serde_json::from_str(r#""sleeping""#).unwrap();
        assert_eq!(s, TaskStatus::Unknown);
    }
}
