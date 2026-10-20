// Where links go: hatbot:// links in messages and from ntfy, and "Open Task". The shell answers while
// you're signed in; a link that comes before it (opening the app from a notification) waits for it.
// Pages that open pages with no link of their own (a new schedule) push them through here too.
use std::any::Any;
use std::cell::RefCell;
use std::rc::Rc;

use hatbot::core::links::Link;
use hatbot::core::models::MessageLink;

type Go = Rc<dyn Fn(Link)>;
type Push = Rc<dyn Fn(adw::NavigationPage, Box<dyn Any>)>;
type Reveal = Rc<dyn Fn(MessageLink)>;
type Chat = Rc<dyn Fn(i64)>;

thread_local! {
    static GO: RefCell<Option<Go>> = RefCell::default();
    static PUSH: RefCell<Option<Push>> = RefCell::default();
    static REVEAL: RefCell<Option<Reveal>> = RefCell::default();
    static CHAT: RefCell<Option<Chat>> = RefCell::default();
    static WAITING: RefCell<Option<Link>> = RefCell::default();
}

pub fn set(go: impl Fn(Link) + 'static) {
    GO.with(|g| g.replace(Some(Rc::new(go))));
    if let Some(link) = WAITING.with(|w| w.take()) {
        self::go(link);
    }
}

pub fn go(link: Link) {
    // Cloned out first: going somewhere can set the next one.
    match GO.with(|g| g.borrow().clone()) {
        Some(go) => go(link),
        None => {
            WAITING.with(|w| w.replace(Some(link)));
        }
    }
}

/// A hatbot:// URL; whether it was one the app knows.
pub fn open(url: &str) -> bool {
    let Some(link) = Link::parse(url) else {
        return false;
    };
    go(link);
    true
}

pub fn set_push(push: impl Fn(adw::NavigationPage, Box<dyn Any>) + 'static) {
    PUSH.with(|p| p.replace(Some(Rc::new(push))));
}

/// Opens `page` over what's showing, keeping `keep` (what drives it) while it's there.
pub fn push(page: adw::NavigationPage, keep: Box<dyn Any>) {
    if let Some(push) = PUSH.with(|p| p.borrow().clone()) {
        push(page, keep);
    }
}

pub fn set_reveal(reveal: impl Fn(MessageLink) + 'static) {
    REVEAL.with(|r| r.replace(Some(Rc::new(reveal))));
}

/// A message in its chat, as a search result opens it.
pub fn reveal(link: MessageLink) {
    if let Some(reveal) = REVEAL.with(|r| r.borrow().clone()) {
        reveal(link);
    }
}

pub fn set_chat(chat: impl Fn(i64) + 'static) {
    CHAT.with(|c| c.replace(Some(Rc::new(chat))));
}

/// A chat, as picking it in the sidebar opens it.
pub fn chat(id: i64) {
    if let Some(chat) = CHAT.with(|c| c.borrow().clone()) {
        chat(id);
    }
}
