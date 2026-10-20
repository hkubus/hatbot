// L4: the live desktop (PLAN.md §24.2).
mod common;

use std::cell::RefCell;
use std::rc::Rc;

use common::*;
use hatbot::core::models::Control;
use hatbot::net::api::Api;
use hatbot::net::live::Live;
use hatbot::store::Store;
use serde_json::{Value, json};

fn desktop(control: &str) -> Value {
    json!({"online": true, "control": control, "request": null, "activeTaskId": 7, "botId": "hatbot"})
}

#[test]
fn you_take_over_drive_the_desktop_and_hand_back_with_nothing_held() {
    run(async {
        let brain = Brain::start();
        brain.answer("POST", "/desktop/takeover", desktop("owner"));
        brain.answer("POST", "/desktop/handback", desktop("hatbot"));
        let api = Api::new(brain.url(), Some(TOKEN.into()));
        let store = Store::new(api.clone());
        let live = Live::new(&api);
        let frames = Rc::new(RefCell::new(vec![]));
        let f = frames.clone();
        live.on_frame(move |bytes| f.borrow_mut().push(bytes.to_vec()));
        live.start();
        wait_for("the first frame", || !frames.borrow().is_empty()).await;
        assert_eq!(frames.borrow()[0], FRAME);

        store.take_over().await.unwrap();
        let control = || store.state().desktop.as_ref().map(|d| d.control);
        assert_eq!(control(), Some(Control::Owner));
        live.pointer_move(640.5, 400.0);
        live.button(1, true, 640.5, 400.0);
        live.key("Control_L", true);
        live.key("c", true);
        live.key("c", false);
        // Two notches in quick succession go as one.
        live.wheel(0.0, 50.0, 640.5, 400.0);
        live.wheel(0.0, 50.0, 640.5, 400.0);
        wait_for("the wheel", || brain.live_inputs().len() == 6).await;
        // Handing back lets go of what's still down first.
        live.release_all();
        store.hand_back().await.unwrap();
        assert_eq!(control(), Some(Control::Hatbot));
        wait_for("the ups", || brain.live_inputs().len() == 8).await;
        assert_eq!(
            brain.live_inputs(),
            vec![
                json!({"t": "move", "x": 640.5, "y": 400.0}),
                json!({"t": "button", "button": 1, "down": true, "x": 640.5, "y": 400.0}),
                json!({"t": "key", "key": "Control_L", "down": true}),
                json!({"t": "key", "key": "c", "down": true}),
                json!({"t": "key", "key": "c", "down": false}),
                json!({"t": "wheel", "dy": 100.0, "dx": 0.0, "x": 640.5, "y": 400.0}),
                json!({"t": "key", "key": "Control_L", "down": false}),
                json!({"t": "button", "button": 1, "down": false, "x": 640.5, "y": 400.0}),
            ]
        );
        assert_eq!(brain.got("POST", "/desktop/takeover")[0].body, json!({}));
    });
}
