// Mirrored from packages/shared, as iOS's Models.swift does.
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
    #[serde(default)]
    pub success_criteria: String,
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
    #[serde(default)]
    pub payload: Option<String>,
    pub model: String,
    #[serde(default)]
    pub research: bool,
    /// The to-do it's working on, by its text.
    #[serde(default)]
    pub todo: Option<String>,
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

impl TaskStep {
    fn is_model_note(&self) -> bool {
        self.kind == StepKind::Note && self.name == "Note"
    }
}

/// The timeline with only the latest of the model's own notes: each says where it's got to.
pub fn latest_note_only(steps: &[TaskStep]) -> Vec<&TaskStep> {
    let last = steps.iter().rposition(TaskStep::is_model_note);
    steps
        .iter()
        .enumerate()
        .filter(|(i, s)| !s.is_model_note() || Some(*i) == last)
        .map(|(_, s)| s)
        .collect()
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
    /// "ntfy" when answered from the notification.
    #[serde(default)]
    pub decided_via: Option<String>,
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
    /// What untrusted content the chat had read when it made or changed it.
    #[serde(default)]
    pub tainted_by: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TriggerKind {
    Webhook,
    Kuma,
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    pub id: i64,
    #[serde(default = "hatbot")]
    pub bot_id: String,
    pub name: String,
    pub kind: TriggerKind,
    pub trusted: bool,
    pub prompt: String,
    pub enabled: bool,
    /// Kuma's failures in a row before a task starts, less one. Older brains don't say.
    #[serde(default)]
    pub confirm_checks: Option<i64>,
    pub url: String,
    pub last_fired_at: Option<String>,
    pub last_task_id: Option<i64>,
}

/// A trigger with its secret, which the brain shows only when it makes one.
#[derive(Deserialize, Debug, Clone)]
pub struct TriggerWithSecret {
    #[serde(flatten)]
    pub trigger: Trigger,
    pub secret: String,
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
    pub sha: String,
}

/// What a save that came after someone else's finds: the file as it is now. Empty if it's gone.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct MemoryConflict {
    pub sha: String,
    pub content: String,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct MemoryCommit {
    pub sha: String,
    pub author: String,
    pub date: String,
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

/// One file a proposal changes: `before` is None for a new file, `after` for a deleted one.
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
    pub reason: String,
    pub changes: Vec<ProposalChange>,
    #[serde(default)]
    pub skill: Option<String>,
    pub status: ProposalStatus,
    pub created_at: String,
}

/// What `GET /search` finds (packages/shared/src/search.ts).
#[derive(Deserialize, Debug, Clone, Default)]
pub struct SearchResults {
    pub query: String,
    #[serde(default)]
    pub messages: Vec<MessageHit>,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub memory: Vec<MemoryHit>,
    #[serde(default)]
    pub routines: Vec<RoutineHit>,
}

impl SearchResults {
    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
            && self.tasks.is_empty()
            && self.memory.is_empty()
            && self.routines.is_empty()
    }
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MessageHit {
    pub id: i64,
    pub conversation_id: i64,
    /// None for what you wrote.
    pub bot_id: Option<String>,
    /// With the matches between \u{2} and \u{3}.
    pub snippet: String,
    pub created_at: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct MemoryHit {
    pub path: String,
    #[serde(default)]
    pub line: i64,
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
    /// Its line in the file, from 0.
    pub line: i64,
    pub done: bool,
    pub text: String,
    /// "2026-10-25".
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
    pub items: Vec<Todo>,
}

/// The brain's settings (apps/brain/src/settings.ts). Each is None from a brain without it, and its
/// row isn't shown.
#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub limits: Option<Limits>,
    pub chat_effort: Option<String>,
    pub chat_model: Option<String>,
    pub review_changes: Option<bool>,
    /// "web" or "app": what a notification opens.
    pub notifications_open: Option<String>,
    pub desktop_model: Option<String>,
    pub desktop_escalate: Option<bool>,
    pub task_model: Option<String>,
    pub heartbeat: Option<HeartbeatSettings>,
    pub memory_tidy: Option<bool>,
    pub weekly_report: Option<WeeklyReport>,
    pub todo_hour: Option<i64>,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub task_usd: f64,
    pub research_usd: f64,
    pub daily_usd: f64,
    pub monthly_usd: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alert_reserve_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boxes_usd: Option<f64>,
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
    /// 0 is Sunday.
    pub weekday: i64,
    pub hour: i64,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SpendSummary {
    pub today_usd: f64,
    pub month_usd: f64,
    pub limits: Option<Limits>,
    pub today_tokens: Option<i64>,
    pub last_hour: Option<SpendWindow>,
    pub last_minute: Option<SpendWindow>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct SpendWindow {
    pub usd: f64,
    pub tokens: i64,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

/// Something Hatbot looks at every so often (packages/shared/src/watch.ts).
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Watcher {
    pub id: i64,
    pub bot_id: String,
    pub name: String,
    #[serde(default)]
    pub prompt: String,
    pub source: serde_json::Map<String, serde_json::Value>,
    pub condition: WatchCondition,
    pub every_minutes: i64,
    #[serde(default)]
    pub once: bool,
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

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct WatchCondition {
    pub when: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub value: Option<f64>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WatcherValue {
    pub id: i64,
    pub value: String,
    pub fired: bool,
    pub created_at: String,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    Ok,
    Fail,
    Skip,
    #[serde(other)]
    Warn,
}

#[derive(Deserialize, Debug, Clone)]
pub struct CheckResult {
    pub name: String,
    pub state: CheckState,
    #[serde(default)]
    pub detail: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CheckReport {
    pub finished_at: String,
    pub results: Vec<CheckResult>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct ChecksInfo {
    pub report: Option<CheckReport>,
    pub approval: Option<Approval>,
}

/// The heartbeat's last look and the ones before that found something.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HeartbeatInfo {
    pub at: Option<String>,
    pub found: Vec<String>,
    pub action: Option<String>,
    pub note: String,
    pub task_id: Option<i64>,
    pub recent: Vec<HeartbeatRun>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HeartbeatRun {
    pub at: String,
    pub found: Vec<String>,
    pub action: Option<String>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct SkillStatus {
    pub name: String,
    #[serde(default)]
    pub runs: i64,
    #[serde(default)]
    pub failed: Vec<i64>,
    #[serde(default)]
    pub takeovers: Vec<i64>,
}

/// A small web app a bot made for you (packages/shared/src/box.ts).
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

/// A box with its versions, oldest first.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoxDetail {
    #[serde(flatten)]
    pub app: AppBox,
    pub versions: Vec<BoxVersion>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoxVersion {
    pub n: i64,
    pub created_at: String,
}

/// One version's page: its HTML, or its files when it has several.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct BoxPage {
    pub html: String,
    pub files: Option<Vec<BoxFile>>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct BoxFile {
    pub path: String,
    pub content: String,
}

impl BoxPage {
    pub fn code(&self) -> String {
        match &self.files {
            Some(files) => files
                .iter()
                .map(|f| format!("--- {} ---\n{}", f.path, f.content))
                .collect::<Vec<_>>()
                .join("\n\n"),
            None => self.html.clone(),
        }
    }
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
    /// None: as in Settings.
    #[serde(default)]
    pub chat_model: Option<String>,
    #[serde(default)]
    pub chat_effort: Option<String>,
    /// None: every plugin that's on.
    #[serde(default)]
    pub plugins: Option<Vec<String>>,
}

pub const BOT_ICONS: [&str; 17] = [
    "hat", "sparkles", "brain", "code", "terminal", "server", "wrench", "shield", "globe", "house",
    "book", "pen", "chart", "mail", "cart", "cat", "heart",
];

pub const BOT_COLORS: [&str; 9] = [
    "amber", "red", "pink", "purple", "indigo", "blue", "teal", "green", "gray",
];

pub const CHAT_MODELS: [&str; 2] = ["claude-haiku-5-5", "claude-opus-5-5"];

pub const CHAT_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

pub const MAX_GROUP_BOTS: usize = 6;

/// A new bot, or every field of one. The model, effort and plugins go as null for "Default"
/// and "every plugin that's on"; Hatbot's name doesn't go at all, since it can't be renamed.
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
    /// A brain from before plugins could be off has them all on.
    #[serde(default = "on")]
    pub enabled: bool,
}

fn on() -> bool {
    true
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
