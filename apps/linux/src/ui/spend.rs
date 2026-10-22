use std::cell::RefCell;
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use hatbot::core::chart::ChartSpec;
use hatbot::core::format;
use hatbot::core::links::Link;
use hatbot::core::models::SpendSummary;
use hatbot::core::spend::{self, SpendDetail};
use hatbot::store::{Change, Listener, Store};

use super::chart;
use super::form::error_label;
use super::route;
use super::shell::Banners;

pub struct Spend {
    pub page: adw::NavigationPage,
    _inner: Rc<Inner>,
    _listener: Listener,
}

struct Inner {
    store: Store,
    prefs: adw::PreferencesPage,
    error: gtk::Label,
    today: gtk::Label,
    month: gtk::Label,
    tokens: (adw::ActionRow, gtk::Label),
    last_hour: (adw::ActionRow, gtk::Label),
    last_minute: (adw::ActionRow, gtk::Label),
    summary: RefCell<Option<SpendSummary>>,
    charts: RefCell<Vec<adw::PreferencesGroup>>,
}

fn value_row(title: &str) -> (adw::ActionRow, gtk::Label) {
    let label = gtk::Label::builder().css_classes(["dim-label"]).build();
    let row = adw::ActionRow::builder().title(title).build();
    row.add_suffix(&label);
    (row, label)
}

impl Spend {
    pub fn new(store: &Store, banners: &Banners) -> Spend {
        let limits = gtk::Button::builder().label("Limits").build();
        limits.connect_clicked(|_| route::go(Link::Spending));
        let header = adw::HeaderBar::new();
        header.pack_end(&limits);
        let error = error_label();
        let top = adw::PreferencesGroup::new();
        top.add(&error);
        let (today_row, today) = value_row("Today");
        let (month_row, month) = value_row("This month");
        let tokens = value_row("Tokens today");
        let last_hour = value_row("Last hour");
        let last_minute = value_row("Last minute");
        for r in [
            &today_row,
            &month_row,
            &tokens.0,
            &last_hour.0,
            &last_minute.0,
        ] {
            top.add(r);
        }
        let prefs = adw::PreferencesPage::new();
        prefs.add(&top);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        banners.add(&view);
        view.set_content(Some(&prefs));
        let page = adw::NavigationPage::builder()
            .title("Spend")
            .tag("spend")
            .child(&view)
            .build();
        let inner = Rc::new(Inner {
            store: store.clone(),
            prefs,
            error,
            today,
            month,
            tokens,
            last_hour,
            last_minute,
            summary: RefCell::default(),
            charts: RefCell::default(),
        });
        let weak = Rc::downgrade(&inner);
        page.connect_showing(move |_| {
            if let Some(i) = weak.upgrade() {
                i.load();
            }
        });
        let weak = Rc::downgrade(&inner);
        let listener = store.listen(move |change| {
            if let (Some(i), Change::Spend) = (weak.upgrade(), change) {
                i.render();
            }
        });
        Spend {
            page,
            _inner: inner,
            _listener: listener,
        }
    }
}

impl Inner {
    fn load(self: &Rc<Self>) {
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let (summary, detail) =
                futures_util::join!(store.spend_summary(), store.spend_detail());
            let Some(i) = weak.upgrade() else { return };
            i.error.set_visible(false);
            match summary {
                Ok(s) => {
                    i.summary.replace(Some(s));
                    i.render();
                }
                Err(e) => i.show_error(&e.message),
            }
            match detail {
                Ok(d) => i.show_charts(&d),
                Err(e) => i.show_error(&e.message),
            }
        });
    }

    fn show_error(&self, text: &str) {
        self.error.set_label(text);
        self.error.set_visible(true);
    }

    fn render(&self) {
        let summary = self.summary.borrow();
        let limits = summary.as_ref().and_then(|s| s.limits.as_ref());
        let st = self.store.state();
        let of = |usd: Option<f64>, limit: Option<f64>| match (usd, limit) {
            (None, _) => "–".to_string(),
            (Some(u), Some(l)) => format!("{} of {}", format::money(u), format::money(l)),
            (Some(u), None) => format::money(u),
        };
        self.today
            .set_label(&of(st.today_usd, limits.map(|l| l.daily_usd)));
        self.month
            .set_label(&of(st.month_usd, limits.map(|l| l.monthly_usd)));
        let s = summary.as_ref();
        let tokens = s.and_then(|s| s.today_tokens);
        self.tokens.0.set_visible(tokens.is_some());
        self.tokens
            .1
            .set_label(&format::tokens(tokens.unwrap_or(0)));
        let hour = s.and_then(|s| s.last_hour.as_ref());
        self.last_hour.0.set_visible(hour.is_some());
        if let Some(h) = hour {
            self.last_hour.1.set_label(&format!(
                "{} · {} tokens",
                format::money(h.usd),
                format::tokens(h.tokens)
            ));
        }
        let minute = s.and_then(|s| s.last_minute.as_ref());
        self.last_minute.0.set_visible(minute.is_some());
        if let Some(m) = minute {
            self.last_minute.1.set_label(&format!(
                "${:.3} · {} tokens",
                m.usd,
                format::tokens(m.tokens)
            ));
        }
    }

    fn show_charts(&self, d: &SpendDetail) {
        for g in self.charts.borrow_mut().drain(..) {
            self.prefs.remove(&g);
        }
        let mut charts = vec![
            ("Last 24 hours", spend::hourly(&d.hourly)),
            ("Last 30 days", spend::daily(&d.daily)),
            ("By model, last 30 days", spend::by_model(&d.by_model)),
        ];
        if self.store.state().bot_ids.len() > 1 {
            let st = self.store.state();
            let by_bot = spend::by_bot(&d.by_bot, |id| st.bots.get(id).map(|b| b.name.clone()));
            charts.push(("By bot, last 30 days", by_bot));
        }
        charts.push(("By purpose, last 30 days", spend::by_purpose(&d.by_purpose)));
        let mut groups = self.charts.borrow_mut();
        for (title, spec) in charts {
            let Some(spec): Option<ChartSpec> = spec else {
                continue;
            };
            let group = adw::PreferencesGroup::builder().title(title).build();
            let view = chart::view(&spec);
            view.set_margin_top(12);
            view.set_margin_bottom(12);
            view.set_margin_start(12);
            view.set_margin_end(12);
            // A row, so it's inside the group's card.
            group.add(
                &gtk::ListBoxRow::builder()
                    .activatable(false)
                    .selectable(false)
                    .child(&view)
                    .build(),
            );
            self.prefs.add(&group);
            groups.push(group);
        }
    }
}
