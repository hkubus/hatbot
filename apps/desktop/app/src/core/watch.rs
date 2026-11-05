// What the event stream says that the app shows outside the window: what waits on you, the tasks
// that end, and the pause.
use std::collections::{BTreeMap, HashMap};

use super::models::{Approval, ApprovalStatus, Event, HATBOT_ID, Question, QuestionStatus, Task, TaskStatus};
use super::notify::Notice;

#[derive(Debug, Default)]
pub struct Watch {
    pub paused: bool,
    bots: HashMap<String, String>,
    approvals: BTreeMap<i64, Approval>,
    questions: BTreeMap<i64, Question>,
    tasks: HashMap<i64, TaskStatus>,
}

impl Watch {
    /// Tasks already running when the stream opened, so that their end is told too.
    pub fn take_tasks(&mut self, tasks: Vec<Task>) {
        for t in tasks {
            self.tasks.insert(t.id, t.status);
        }
    }

    /// A task that has just ended comes back, to be told.
    pub fn apply(&mut self, event: Event) -> Option<Task> {
        match event {
            Event::Snapshot(s) => {
                self.paused = s.paused;
                self.bots = s.bots.into_iter().map(|b| (b.id, b.name)).collect();
                self.approvals = s.approvals.into_iter().map(|a| (a.id, a)).collect();
                self.questions = s.questions.into_iter().map(|q| (q.id, q)).collect();
            }
            Event::Paused { paused } => self.paused = paused,
            Event::BotUpdated { bot } => {
                self.bots.insert(bot.id, bot.name);
            }
            Event::ApprovalCreated { approval } | Event::ApprovalResolved { approval } => {
                self.approvals.insert(approval.id, approval);
            }
            Event::QuestionCreated { question } | Event::QuestionResolved { question } => {
                self.questions.insert(question.id, question);
            }
            Event::TaskUpdated { task } => {
                let before = self.tasks.insert(task.id, task.status);
                if before.is_some_and(TaskStatus::is_active)
                    && matches!(task.status, TaskStatus::Done | TaskStatus::Failed)
                {
                    return Some(task);
                }
            }
            Event::Unknown => {}
        }
        None
    }

    /// What waits on you now, oldest first.
    pub fn open(&self) -> Vec<Notice> {
        let approvals = self.approvals.values().filter(|a| a.status == ApprovalStatus::Pending).cloned();
        let questions = self.questions.values().filter(|q| q.status == QuestionStatus::Pending).cloned();
        approvals.map(Notice::Approval).chain(questions.map(Notice::Question)).collect()
    }

    pub fn bot_name(&self, id: &str) -> String {
        self.bots.get(id).cloned().unwrap_or_else(|| if id == HATBOT_ID { "Hatbot".into() } else { id.into() })
    }
}
