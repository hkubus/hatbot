//! Whether the owner is using the computer, from the compositor's idle notifications. Hatbot's own
//! input wakes them too, so a wake that comes right after it is left out.

use std::time::Duration;

// Tokio's clock, which tests can move.
use tokio::time::Instant;

/// Input after the agent's own this soon is taken for the agent's.
pub const OWN_GRACE: Duration = Duration::from_millis(750);
/// The idle notification that notices the owner: short, so it's idle again between the model's steps.
pub const NOTICE_MS: u32 = 1000;
/// The one that says they've stopped.
pub const QUIET_MS: u32 = 5000;

#[derive(Debug, Default)]
pub struct Activity {
    own_until: Option<Instant>,
    owner_active: bool,
}

impl Activity {
    pub fn owner_active(&self) -> bool {
        self.owner_active
    }

    /// The agent is about to send input, or just did.
    pub fn own_input(&mut self, now: Instant) {
        self.own_until = Some(now + OWN_GRACE);
    }

    /// The short notification woke. True when that changed whether the owner is active.
    pub fn resumed(&mut self, now: Instant) -> bool {
        if self.own_until.is_some_and(|t| now <= t) || self.owner_active {
            return false;
        }
        self.owner_active = true;
        true
    }

    /// The long notification went idle: nobody has touched anything for a while.
    pub fn quiet(&mut self) -> bool {
        std::mem::replace(&mut self.owner_active, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_out_wakes_from_own_input() {
        let mut a = Activity::default();
        let t = Instant::now();
        a.own_input(t);
        assert!(!a.resumed(t + Duration::from_millis(100)));
        assert!(!a.owner_active());
        // Later, it's the owner.
        assert!(a.resumed(t + OWN_GRACE + Duration::from_millis(1)));
        assert!(a.owner_active());
        assert!(a.quiet());
        assert!(!a.owner_active());
    }
}
