// Where links go: hatbot:// links in messages and from ntfy, and "Open Task". The shell answers while
// you're signed in; a link that comes before it (opening the app from a notification) waits for it.
// Pages that open pages with no link of their own (a new schedule) push them through here too.
use std::any::Any;
use std::cell::RefCell;
use std::rc::Rc;

use hatbot::core::links::Link;

type Go = Rc<dyn Fn(Link)>;
type Push = Rc<dyn Fn(adw::NavigationPage, Box<dyn Any>)>;

thread_local! {
    static GO: RefCell<Option<Go>> = RefCell::default();
    static PUSH: RefCell<Option<Push>> = RefCell::default();
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
