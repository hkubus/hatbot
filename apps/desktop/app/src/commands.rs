// What the app's own pages may call. The brain's web app in the window can't: Tauri gives no remote
// page the app's commands.
use tauri::State;

use crate::daemon::{self, Action, Msg, Shared, UiState};

#[tauri::command]
pub fn state(shared: State<'_, Shared>) -> UiState {
    shared.lock().unwrap().clone()
}

#[tauri::command]
pub fn act(action: Action) {
    daemon::send(Msg::Do(action));
}
