// The few of packages/shared's types the app reads itself, mirrored by hand; the window is the web app.
// Decoding is lenient: an event or enum value a newer brain adds decodes as `Unknown`, and a field an
// older brain lacks takes its default.
use serde::Deserialize;

pub const HATBOT_ID: &str = "hatbot";

fn hatbot() -> String {
    HATBOT_ID.to_string()
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub setup_done: bool,
    #[serde(default)]
    pub authenticated: bool,
    #[serde(default)]
    pub local: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct AppLink {
    pub url: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct LoginResponse {
    /// Absent from a brain too old for apps.
    pub token: Option<String>,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    WaitingApproval,
    WaitingTakeover,
    WaitingAnswer,
    Done,
    Failed,
    Cancelled,
    #[default]
    #[serde(other)]
    Running,
}

impl TaskStatus {
    pub fn is_active(self) -> bool {
        !matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: i64,
    #[serde(default = "hatbot")]
    pub bot_id: String,
    #[serde(default)]
    pub conversation_id: Option<i64>,
    pub title: String,
    #[serde(default)]
    pub status: TaskStatus,
    #[serde(default)]
    pub summary: Option<String>,
    /// Its end was notified: a routine result isn't shown.
    #[serde(default)]
    pub notified: bool,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
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
    Listing,
    Computer,
    Secret,
    Other,
    #[default]
    #[serde(other)]
    Unknown,
}

impl ApprovalKind {
    /// Never approved from a notification, only in the window: the brain's `approvableFromNotification`.
    pub fn is_floor(self) -> bool {
        !matches!(self, Self::Send | Self::SubmitPersonalData | Self::Delete | Self::Listing | Self::Other)
    }
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    /// The safety review stopped it; you may still run it anyway.
    Blocked,
    /// A message to a person that goes at `expires_at` unless you stop it.
    Sending,
    Approved,
    Denied,
    Expired,
    #[default]
    #[serde(other)]
    Cancelled,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: i64,
    #[serde(default = "hatbot")]
    pub bot_id: String,
    #[serde(default)]
    pub task_id: Option<i64>,
    #[serde(default)]
    pub kind: ApprovalKind,
    pub summary: String,
    #[serde(default)]
    pub status: ApprovalStatus,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum QuestionStatus {
    Pending,
    Answered,
    Expired,
    #[default]
    #[serde(other)]
    Cancelled,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: i64,
    #[serde(default = "hatbot")]
    pub bot_id: String,
    pub task_id: i64,
    pub question: String,
    #[serde(default)]
    pub choices: Vec<String>,
    #[serde(default)]
    pub status: QuestionStatus,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Bot {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub paused: bool,
    pub bots: Vec<Bot>,
    pub approvals: Vec<Approval>,
    pub questions: Vec<Question>,
}

/// Live events on /api/v1/stream that the app acts on.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type")]
pub enum Event {
    #[serde(rename = "snapshot")]
    Snapshot(Snapshot),
    #[serde(rename = "paused")]
    Paused { paused: bool },
    #[serde(rename = "task.updated")]
    TaskUpdated { task: Task },
    #[serde(rename = "approval.created")]
    ApprovalCreated { approval: Approval },
    #[serde(rename = "approval.resolved")]
    ApprovalResolved { approval: Approval },
    #[serde(rename = "question.created")]
    QuestionCreated { question: Question },
    #[serde(rename = "question.resolved")]
    QuestionResolved { question: Question },
    #[serde(rename = "bot.updated")]
    BotUpdated { bot: Bot },
    #[serde(other)]
    Unknown,
}

impl Event {
    /// An event this app doesn't act on, a newer brain's or a malformed one, is `Unknown`.
    pub fn parse(text: &str) -> Event {
        serde_json::from_str(text).unwrap_or(Event::Unknown)
    }
}
