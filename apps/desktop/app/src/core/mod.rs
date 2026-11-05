pub mod api;
pub mod links;
pub mod local;
pub mod models;
pub mod notify;
pub mod session;
pub mod socket;
pub mod vault;
pub mod watch;

/// The system, as the app names itself to the brain.
pub const OS: &str = if cfg!(windows) { "Windows" } else { "Linux" };
