// Mirrors packages/shared by hand, as iOS's Models.swift does; change them together.
// Decoding is lenient: an event or enum value a newer brain adds decodes as `Unknown`, and a field an
// older brain lacks takes its default.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const HATBOT_ID: &str = "hatbot";

fn hatbot() -> String {
    HATBOT_ID.to_string()
}

fn on() -> bool {
    true
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub setup_done: bool,
    #[serde(default)]
    pub authenticated: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct LoginResponse {
    /// Absent from a brain too old for apps.
    pub token: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    #[default]
    #[serde(other)]
    Assistant,
}

/// "task"/"schedule": cards, `text` a fallback. "box": a note from box `box_id`. "handoff": another
/// bot handing this one work. "thread": a thread's card, `link` its first message.
#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    #[default]
    Text,
    Task,
    Schedule,
    Command,
    Box,
    Handoff,
    Thread,
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum MessageStatus {
    Streaming,
    Error,
    #[default]
    #[serde(other)]
    Done,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    pub id: i64,
    #[serde(default)]
    pub role: Role,
    /// Missing on brains from before bots, which have only Hatbot's chat.
    #[serde(default = "first_chat")]
    pub conversation_id: i64,
    #[serde(default)]
    pub bot_id: Option<String>,
    #[serde(default)]
    pub kind: MessageKind,
    pub text: String,
    #[serde(default)]
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

impl ThreadMessage {
    /// What came of a command you ran, shown as a quiet line.
    pub fn is_note(&self) -> bool {
        self.role == Role::Assistant && self.kind == MessageKind::Command && self.task_id.is_none()
    }
}

fn first_chat() -> i64 {
    1
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct MessageChanges {
    #[serde(default)]
    pub ids: Vec<i64>,
    #[serde(default)]
    pub changed: Vec<ThreadMessage>,
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
    #[serde(default)]
    pub title: String,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: i64,
    pub name: String,
    pub media_type: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub created_at: String,
    /// Data a task handed the chat's bot: not shown in the chat.
    #[serde(default)]
    pub for_chat: bool,
}

impl Attachment {
    pub fn is_picture(&self) -> bool {
        matches!(self.media_type.as_str(), "image/jpeg" | "image/png" | "image/gif" | "image/webp")
    }
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub id: i64,
    pub started_at: String,
    pub last_activity_at: String,
    #[serde(default)]
    pub recap: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
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

/// A task, whole (`GET /tasks/:id`) or as a card, which lacks the goal, criteria, payload and cost.
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: i64,
    #[serde(default = "hatbot")]
    pub bot_id: String,
    #[serde(default)]
    pub requested_by: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<i64>,
    pub title: String,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub success_criteria: Option<String>,
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub lane: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub schedule_id: Option<i64>,
    #[serde(default)]
    pub trigger_id: Option<i64>,
    #[serde(default)]
    pub parent_id: Option<i64>,
    #[serde(default)]
    pub payload: Option<String>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub skill: Option<String>,
    #[serde(default)]
    pub research: bool,
    #[serde(default)]
    pub runner: Option<String>,
    #[serde(default)]
    pub todo: Option<String>,
    #[serde(default)]
    pub report_path: Option<String>,
    #[serde(default)]
    pub status: TaskStatus,
    #[serde(default)]
    pub tainted: bool,
    #[serde(default)]
    pub tainted_by: Option<String>,
    #[serde(default)]
    pub injection_suspected: bool,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub steps: Option<i64>,
    pub created_at: String,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
}

impl Task {
    pub fn is_full(&self) -> bool {
        self.goal.is_some()
    }

    /// A card that came for a task held whole keeps what the card leaves out.
    pub fn keeping(mut self, held: Option<&Task>) -> Task {
        if let Some(h) = held.filter(|h| h.is_full() && !self.is_full()) {
            self.goal = h.goal.clone();
            self.success_criteria = h.success_criteria.clone();
            self.payload = h.payload.clone();
            self.cost_usd = h.cost_usd;
            self.steps = h.steps;
        }
        self
    }
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    Action,
    Screenshot,
    Page,
    Approval,
    Takeover,
    Error,
    Task,
    #[default]
    #[serde(other)]
    Note,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskStep {
    pub id: i64,
    pub task_id: i64,
    #[serde(default)]
    pub kind: StepKind,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub screenshot: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    pub created_at: String,
}

impl TaskStep {
    fn is_model_note(&self) -> bool {
        self.kind == StepKind::Note && self.name == "Note"
    }
}

/// The timeline with only the latest of the model's own notes; your notes on approvals stay.
pub fn latest_note_only(steps: &[TaskStep]) -> Vec<&TaskStep> {
    let last = steps.iter().rposition(TaskStep::is_model_note);
    steps.iter().enumerate().filter(|(i, s)| !s.is_model_note() || Some(*i) == last).map(|(_, s)| s).collect()
}

#[derive(Deserialize, Debug, Clone)]
pub struct TaskWithSteps {
    pub task: Task,
    #[serde(default)]
    pub steps: Vec<TaskStep>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
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
    Other,
    #[default]
    #[serde(other)]
    Unknown,
}

impl ApprovalKind {
    /// Money, and passwords and keys: never answered from a notification, only in the window.
    pub fn is_floor(self) -> bool {
        matches!(self, Self::Purchase | Self::Payment | Self::Mandate | Self::AccountSecurity)
    }

    /// Whether the answer can carry a note: the task carries on afterwards.
    pub fn takes_note(self) -> bool {
        !matches!(self, Self::Budget | Self::InjectionWarning)
    }
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
    Expired,
    #[default]
    #[serde(other)]
    Cancelled,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: i64,
    #[serde(default = "hatbot")]
    pub bot_id: String,
    #[serde(default)]
    pub task_id: Option<i64>,
    #[serde(default)]
    pub conversation_id: Option<i64>,
    #[serde(default)]
    pub episode_id: Option<i64>,
    #[serde(default)]
    pub kind: ApprovalKind,
    pub summary: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub screenshot_step_id: Option<i64>,
    #[serde(default)]
    pub status: ApprovalStatus,
    #[serde(default)]
    pub cost_usd: f64,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub expires_at: String,
    #[serde(default)]
    pub decided_at: Option<String>,
    #[serde(default)]
    pub decided_via: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    /// How far approving it may go besides this once; a scope this app doesn't know is left out.
    #[serde(default)]
    pub scopes: Vec<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum QuestionStatus {
    Pending,
    Answered,
    Expired,
    #[default]
    #[serde(other)]
    Cancelled,
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
    #[serde(default)]
    pub status: QuestionStatus,
    #[serde(default)]
    pub answer: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub expires_at: String,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Control {
    Owner,
    #[default]
    #[serde(other)]
    Hatbot,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverRequest {
    pub task_id: i64,
    #[serde(default)]
    pub reason: String,
}

/// A screen Live can show: the desktop guest, or one of your computers. Brains from before the picker
/// send none, and the guest is the only one.
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveScreen {
    pub id: String,
    pub name: String,
    #[serde(default = "on")]
    pub online: bool,
    #[serde(default)]
    pub active_task_id: Option<i64>,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub control: Control,
    #[serde(default)]
    pub request: Option<TakeoverRequest>,
    #[serde(default)]
    pub active_task_id: Option<i64>,
    #[serde(default)]
    pub bot_id: Option<String>,
    #[serde(default)]
    pub screens: Vec<LiveScreen>,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: i64,
    #[serde(default = "hatbot")]
    pub bot_id: String,
    pub name: String,
    #[serde(default)]
    pub cron: Option<String>,
    #[serde(default)]
    pub run_at: Option<String>,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub created_via: String,
    #[serde(default)]
    pub next_run_at: Option<String>,
    #[serde(default)]
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub last_task_id: Option<i64>,
    #[serde(default)]
    pub tainted: bool,
    #[serde(default)]
    pub tainted_by: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TriggerKind {
    Kuma,
    #[default]
    #[serde(other)]
    Webhook,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    pub id: i64,
    #[serde(default = "hatbot")]
    pub bot_id: String,
    pub name: String,
    #[serde(default)]
    pub kind: TriggerKind,
    #[serde(default)]
    pub trusted: bool,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub confirm_checks: Option<i64>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub last_fired_at: Option<String>,
    #[serde(default)]
    pub last_task_id: Option<i64>,
}

/// A trigger with its secret, which the brain shows only when it makes or replaces one.
#[derive(Deserialize, Debug, Clone)]
pub struct TriggerWithSecret {
    #[serde(flatten)]
    pub trigger: Trigger,
    pub secret: String,
}

impl TriggerWithSecret {
    /// What to paste into the sender: Uptime Kuma's Post URL carries the secret.
    pub fn post_url(&self) -> String {
        match self.trigger.kind {
            TriggerKind::Kuma => format!("{}?token={}", self.trigger.url, self.secret),
            TriggerKind::Webhook => self.trigger.url.clone(),
        }
    }
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct MemoryFile {
    pub path: String,
    #[serde(default)]
    pub size: i64,
}

/// A memory file as read, with the sha a save says it's based on.
#[derive(Deserialize, Debug, Clone)]
pub struct MemoryContent {
    pub content: String,
    #[serde(default)]
    pub sha: String,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct MemoryCommit {
    pub sha: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProposalKind {
    Skill,
    Write,
    #[serde(other)]
    Tidy,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    Pending,
    Applied,
    Dismissed,
    #[serde(other)]
    Stale,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct ProposalChange {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: i64,
    pub kind: ProposalKind,
    pub title: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub changes: Vec<ProposalChange>,
    #[serde(default)]
    pub skill: Option<String>,
    pub status: ProposalStatus,
    #[serde(default)]
    pub created_at: String,
}

/// What `GET /search` finds (packages/shared/src/search.ts).
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct SearchResults {
    pub query: String,
    pub messages: Vec<MessageHit>,
    pub tasks: Vec<Task>,
    pub memory: Vec<MemoryHit>,
    pub routines: Vec<RoutineHit>,
}

impl SearchResults {
    pub fn is_empty(&self) -> bool {
        self.messages.is_empty() && self.tasks.is_empty() && self.memory.is_empty() && self.routines.is_empty()
    }
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MessageHit {
    pub id: i64,
    pub conversation_id: i64,
    #[serde(default)]
    pub bot_id: Option<String>,
    /// With the matches between \u{2} and \u{3}.
    pub snippet: String,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct MemoryHit {
    pub path: String,
    #[serde(default)]
    pub line: i64,
    #[serde(default)]
    pub text: String,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutineKind {
    Trigger,
    Watcher,
    #[serde(other)]
    Schedule,
}

#[derive(Deserialize, Debug, Clone)]
pub struct RoutineHit {
    pub kind: RoutineKind,
    pub id: i64,
    pub name: String,
}

/// A line of todo.md (packages/shared/src/todo.ts).
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub line: i64,
    pub done: bool,
    pub text: String,
    /// "2026-10-25".
    #[serde(default)]
    pub due: Option<String>,
    /// "14:00".
    #[serde(default)]
    pub at: Option<String>,
    #[serde(default)]
    pub done_on: Option<String>,
    #[serde(default)]
    pub task_id: Option<i64>,
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct TodoList {
    #[serde(default)]
    pub items: Vec<Todo>,
}

/// The brain's settings. Each is None from a brain without it, and its row isn't shown.
#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub limits: Option<Limits>,
    pub chat_effort: Option<String>,
    pub chat_model: Option<String>,
    pub review_changes: Option<bool>,
    pub paused: Option<bool>,
    pub desktop_model: Option<String>,
    pub desktop_escalate: Option<bool>,
    pub task_model: Option<String>,
    pub small_model: Option<String>,
    pub expert_model: Option<String>,
    pub heartbeat: Option<HeartbeatSettings>,
    pub memory_tidy: Option<bool>,
    pub weekly_report: Option<WeeklyReport>,
    pub todo_hour: Option<i64>,
}

/// One setting changed; what's left out stays as it is.
#[derive(Serialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsChange {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<Limits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_changes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desktop_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desktop_escalate: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub small_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expert_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weekly_report: Option<WeeklyReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todo_hour: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_tidy: Option<bool>,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Limits {
    pub task_usd: f64,
    pub research_usd: f64,
    pub daily_usd: f64,
    pub monthly_usd: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alert_reserve_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boxes_usd: Option<f64>,
}

impl Limits {
    /// Nothing kept for alerts is allowed, and boxes costing nothing; a limit of nothing isn't.
    pub fn valid(&self) -> bool {
        self.task_usd > 0.0
            && self.research_usd > 0.0
            && self.daily_usd > 0.0
            && self.monthly_usd > 0.0
            && self.alert_reserve_usd.unwrap_or(0.0) >= 0.0
            && self.boxes_usd.unwrap_or(0.0) >= 0.0
    }
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatSettings {
    pub enabled: bool,
    pub every_minutes: i64,
    pub bot_id: String,
    pub instructions: String,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct WeeklyReport {
    pub enabled: bool,
    pub weekday: i64,
    pub hour: i64,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub computer_use: bool,
}

#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SpendSummary {
    pub today_usd: f64,
    pub month_usd: f64,
    pub limits: Option<Limits>,
    pub today_tokens: Option<i64>,
    pub last_hour: Option<SpendWindow>,
    pub last_minute: Option<SpendWindow>,
}

#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct SpendWindow {
    pub usd: f64,
    pub tokens: i64,
}

#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct SpendHour {
    pub hour: String,
    pub usd: f64,
    pub tokens: i64,
}

#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct SpendDay {
    pub date: String,
    pub usd: f64,
}

#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct SpendByModel {
    pub model: String,
    pub usd: f64,
}

#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SpendByPurpose {
    pub purpose: String,
    pub cost_usd: f64,
}

#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SpendByBot {
    pub bot_id: String,
    pub usd: f64,
}

/// Something Hatbot looks at every so often (packages/shared/src/watch.ts).
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Watcher {
    pub id: i64,
    #[serde(default = "hatbot")]
    pub bot_id: String,
    pub name: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub source: Value,
    #[serde(default)]
    pub condition: Value,
    #[serde(default)]
    pub every_minutes: i64,
    #[serde(default)]
    pub once: bool,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub tainted: bool,
    #[serde(default)]
    pub last_checked_at: Option<String>,
    #[serde(default)]
    pub last_value: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub last_task_id: Option<i64>,
}

/// A small web app a bot made for you (packages/shared/src/box.ts).
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppBox {
    pub id: i64,
    #[serde(default = "hatbot")]
    pub bot_id: String,
    #[serde(default)]
    pub conversation_id: Option<i64>,
    pub title: String,
    #[serde(default)]
    pub version: i64,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct Bot {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub instructions: String,
    #[serde(default, rename = "chatModel")]
    pub chat_model: Option<String>,
    #[serde(default, rename = "chatEffort")]
    pub chat_effort: Option<String>,
    #[serde(default)]
    pub plugins: Option<Vec<String>>,
    /// Only the first line of its role is in `instructions`: its editor loads it whole.
    #[serde(default, skip_serializing)]
    pub brief: bool,
}

pub const BOT_ICONS: [&str; 17] = [
    "hat", "sparkles", "brain", "code", "terminal", "server", "wrench", "shield", "globe", "house", "book", "pen",
    "chart", "mail", "cart", "cat", "heart",
];

pub const BOT_COLORS: [&str; 9] = ["amber", "red", "pink", "purple", "indigo", "blue", "teal", "green", "gray"];

#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApiToken {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub last_used_at: Option<String>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BotTemplate {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub chat_model: Option<String>,
    #[serde(default)]
    pub chat_effort: Option<String>,
    #[serde(default)]
    pub plugins: Option<Vec<String>>,
}

pub const CHAT_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

pub const MAX_GROUP_BOTS: usize = 6;

/// A new bot, or every field of one. Model, effort and plugins go as null for "as in Settings" and
/// "every plugin that's on"; Hatbot's name doesn't go at all, since it can't be renamed.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BotChange {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub icon: String,
    pub color: String,
    pub instructions: String,
    pub chat_model: Option<String>,
    pub chat_effort: Option<String>,
    pub plugins: Option<Vec<String>>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupChange {
    pub title: String,
    pub bot_ids: Vec<String>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct PluginName {
    pub id: String,
    pub name: String,
    #[serde(default = "on")]
    pub enabled: bool,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ConversationKind {
    Group,
    Thread,
    #[default]
    #[serde(other)]
    Direct,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: i64,
    #[serde(default)]
    pub kind: ConversationKind,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub bot_ids: Vec<String>,
    #[serde(default)]
    pub unread: i64,
    #[serde(default)]
    pub last_message_at: Option<String>,
    #[serde(default)]
    pub parent_id: Option<i64>,
    #[serde(default)]
    pub resolved_at: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub latest: Option<String>,
    #[serde(default)]
    pub needs_you: bool,
}

impl Conversation {
    pub fn is_thread(&self) -> bool {
        self.kind == ConversationKind::Thread && self.parent_id.is_some()
    }
}

/// What's live, the stream's first event.
#[derive(Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(default)]
pub struct Snapshot {
    pub paused: bool,
    pub bots: Vec<Bot>,
    pub conversations: Vec<Conversation>,
    pub approvals: Vec<Approval>,
    pub questions: Vec<Question>,
    pub desktop: Option<DesktopState>,
    pub unread: Vec<i64>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub last_used_at: Option<String>,
}

/// Live events on /api/v1/stream.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type")]
pub enum Event {
    #[serde(rename = "snapshot")]
    Snapshot(Snapshot),
    #[serde(rename = "message.created")]
    MessageCreated { message: ThreadMessage },
    /// `at`: where `text` starts in the reply, in UTF-16 units.
    #[serde(rename = "message.delta")]
    MessageDelta {
        id: i64,
        text: String,
        #[serde(default)]
        at: Option<usize>,
    },
    #[serde(rename = "message.progress")]
    MessageProgress { id: i64, text: String },
    #[serde(rename = "message.done")]
    MessageDone {
        id: i64,
        text: String,
        #[serde(default)]
        status: MessageStatus,
        #[serde(default)]
        sources: Option<Vec<Source>>,
        #[serde(default)]
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
    MemoryCommitted { sha: String, message: String, author: String },
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
    #[serde(rename = "approval.created")]
    ApprovalCreated { approval: Approval },
    #[serde(rename = "approval.resolved")]
    ApprovalResolved { approval: Approval },
    #[serde(rename = "question.created")]
    QuestionCreated { question: Question },
    #[serde(rename = "question.resolved")]
    QuestionResolved { question: Question },
    #[serde(rename = "desktop.state")]
    Desktop { state: DesktopState },
    #[serde(rename = "schedule.updated")]
    ScheduleUpdated { schedule: Schedule },
    #[serde(rename = "schedule.deleted")]
    ScheduleDeleted { id: i64 },
    #[serde(rename = "proposal.updated")]
    ProposalUpdated { proposal: Proposal },
    #[serde(rename = "trigger.updated")]
    TriggerUpdated { trigger: Trigger },
    #[serde(rename = "trigger.deleted")]
    TriggerDeleted { id: i64 },
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
    #[serde(rename = "watcher.updated")]
    WatcherUpdated { watcher: Watcher },
    #[serde(rename = "watcher.deleted")]
    WatcherDeleted { id: i64 },
    #[serde(rename = "heartbeat.updated")]
    HeartbeatUpdated,
    #[serde(other)]
    Unknown,
}

impl Event {
    /// An event this app can't read, a newer brain's or a malformed one, is `Unknown`.
    pub fn parse(text: &str) -> Event {
        serde_json::from_str(text).unwrap_or(Event::Unknown)
    }
}
