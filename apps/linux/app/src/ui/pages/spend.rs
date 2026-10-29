// What Hatbot has spent: today and this month against their limits, and where it went.
use iced::widget::{column, row, text};
use iced::{Element, Length, Task};

use super::Msg as PageMsg;
use crate::core::chart::ChartSpec;
use crate::core::models::*;
use crate::core::{format, spend};
use crate::ui::app::{Message, Session};
use crate::ui::chart;
use crate::ui::theme::{self, FS_2XL, SP_LG, SP_MD, SP_XL};
use crate::ui::widgets::{card, page, section, small, tone};

#[derive(Debug, Clone)]
pub enum Msg {
    Loaded(Box<SpendSummary>, Box<spend::SpendDetail>),
}

#[derive(Default)]
pub struct State {
    summary: Option<SpendSummary>,
    charts: Vec<(&'static str, ChartSpec)>,
}

pub fn opened(s: &mut Session) -> Task<Message> {
    s.call(
        |api| async move {
            let summary: SpendSummary = api.get("/spend/summary").await?;
            // A chart a brain doesn't have yet stays empty.
            let detail = spend::SpendDetail {
                hourly: api.get("/spend/hourly?hours=24").await.unwrap_or_default(),
                daily: api.get("/spend/daily?days=30").await.unwrap_or_default(),
                by_model: api.get("/spend/by-model").await.unwrap_or_default(),
                by_bot: api.get("/spend/by-bot?days=30").await.unwrap_or_default(),
                by_purpose: api.get("/spend/by-purpose").await.unwrap_or_default(),
            };
            Ok((summary, detail))
        },
        |r| match r {
            Ok((a, b)) => Message::Page(PageMsg::Spend(Msg::Loaded(Box::new(a), Box::new(b)))),
            Err(e) => crate::ui::app::failed(e),
        },
    )
}

pub fn update(s: &mut Session, msg: Msg) -> Task<Message> {
    match msg {
        Msg::Loaded(a, b) => {
            let d = *b;
            let bot_name = |id: &str| s.store.bots.get(id).map(|b| b.name.clone());
            let several_bots = d.by_bot.iter().filter(|b| b.usd > 0.0).count() > 1;
            let all = [
                ("Last 24 hours", spend::hourly(&d.hourly)),
                ("Last 30 days", spend::daily(&d.daily)),
                ("By model", spend::by_model(&d.by_model)),
                ("By bot", if several_bots { spend::by_bot(&d.by_bot, bot_name) } else { None }),
                ("By purpose", spend::by_purpose(&d.by_purpose)),
            ];
            s.pages.spend.charts = all.into_iter().filter_map(|(n, c)| c.map(|c| (n, c))).collect();
            s.pages.spend.summary = Some(*a);
        }
    }
    Task::none()
}

fn figure<'a>(name: &'a str, value: String, of: Option<String>) -> Element<'a, Message> {
    let mut col = column![small(name), text(value).size(FS_2XL).font(theme::MEDIUM)].spacing(4);
    if let Some(of) = of {
        col = col.push(text(of).size(theme::FS_MD).style(tone(|c| c.text_2)));
    }
    card(col).width(Length::Fill).into()
}

pub fn view(s: &Session, dark: bool) -> Element<'_, Message> {
    let st = &s.pages.spend;
    let Some(sum) = &st.summary else { return page(column![]) };
    let today = s.store.today_usd.unwrap_or(sum.today_usd);
    let month = s.store.month_usd.unwrap_or(sum.month_usd);
    let limits = sum.limits.as_ref();
    let of = |v: Option<f64>| v.map(|l| format!("of {}", format::money(l)));
    let mut figures = row![
        figure("Today", format::money(today), of(limits.map(|l| l.daily_usd))),
        figure("This month", format::money(month), of(limits.map(|l| l.monthly_usd))),
    ]
    .spacing(SP_LG);
    if let Some(t) = sum.today_tokens {
        figures = figures.push(figure("Tokens today", format::tokens(t), None));
    }
    let mut windows = row![].spacing(SP_LG);
    for (name, w) in [("Last hour", &sum.last_hour), ("Last minute", &sum.last_minute)] {
        if let Some(w) = w {
            windows =
                windows.push(figure(name, format::money(w.usd), Some(format!("{} tokens", format::tokens(w.tokens)))));
        }
    }

    let ctx = chart::Ctx { dark, photos: None, open: |_| Message::Nothing };
    let mut col = column![figures, windows].spacing(SP_MD);
    let mut charts = column![].spacing(SP_XL);
    for (name, spec) in &st.charts {
        charts = charts.push(section(name, card(chart::view(spec, ctx))));
    }
    col = col.push(charts);
    page(col.spacing(SP_XL))
}
