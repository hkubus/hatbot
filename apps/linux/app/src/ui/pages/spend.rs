// What Hatbot has spent: today and this month against their limits, and where it went.
use std::collections::HashSet;

use iced::widget::{Space, column, container, row, text};
use iced::{Alignment, Element, Length, Padding, Task, Theme};

use super::Msg as PageMsg;
use crate::core::chart::ChartSpec;
use crate::core::models::*;
use crate::core::{format, spend};
use crate::ui::app::{Message, Route, Session};
use crate::ui::chart;
use crate::ui::theme::{self, FS_MD, SP, SP_2XS, SP_LG, SP_MD, SP_PAGE, SP_SM, SP_XL, SP_XS};
use crate::ui::widgets::{btn, fill, page, segmented, tone};

#[derive(Debug, Clone)]
pub enum Msg {
    Loaded(Box<SpendSummary>, Box<spend::SpendDetail>),
    Table(&'static str, bool),
}

#[derive(Default)]
pub struct State {
    summary: Option<SpendSummary>,
    /// Each chart's title and chart; None when nothing was spent on it.
    charts: Vec<(&'static str, Option<ChartSpec>)>,
    /// The charts shown as tables.
    tables: HashSet<&'static str>,
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
            let daily_limit = a.limits.as_ref().map(|l| l.daily_usd);
            let mut charts = vec![
                ("Last 24 hours", spend::hourly(&d.hourly)),
                ("Last 30 days", spend::daily(&d.daily).map(|c| spend::with_limit(c, daily_limit))),
                ("By model, last 30 days", spend::by_model(&d.by_model)),
            ];
            if several_bots {
                charts.push(("By bot, last 30 days", spend::by_bot(&d.by_bot, bot_name)));
            }
            if let Some(c) = spend::by_purpose(&d.by_purpose) {
                charts.push(("By purpose, last 30 days", Some(c)));
            }
            s.pages.spend.charts = charts;
            s.pages.spend.summary = Some(*a);
        }
        Msg::Table(name, on) => {
            if on {
                s.pages.spend.tables.insert(name);
            } else {
                s.pages.spend.tables.remove(name);
            }
        }
    }
    Task::none()
}

/// One figure on its tile, the web's `Kpi`; with a limit, how much of it is used.
fn figure<'a>(name: &'a str, usd: f64, of: Option<f64>) -> Element<'a, Message> {
    let mut value = row![text(format::money(usd)).size(28)].spacing(SP_SM).align_y(Alignment::End);
    let mut col = column![text(name).size(FS_MD).style(tone(|c| c.text_2))].spacing(SP_SM);
    if let Some(of) = of {
        value = value.push(
            container(
                text(format!("of {}", format::money(of))).size(FS_MD).font(theme::MEDIUM).style(tone(|c| c.muted)),
            )
            .padding(Padding::default().bottom(4)),
        );
    }
    col = col.push(value);
    // Tiles without a meter keep its room, so the row's tiles are one height.
    col = col.push(match of.filter(|o| *o > 0.0) {
        Some(of) => meter(usd / of),
        None => Space::new().height(8).into(),
    });
    container(col).padding(SP_LG).width(Length::Fill).style(theme::tile(true, true)).into()
}

/// The web's `.meter`: the part used, a gap, and the rest with a dot at its end; red once it's all used.
fn meter<'a>(share: f64) -> Element<'a, Message> {
    let share = share.clamp(0.0, 1.0);
    let hot = share >= 1.0;
    let ink = move |t: &Theme| {
        let c = theme::colors(t);
        if hot { c.danger } else { c.hue }
    };
    let used = (share * 1000.0).round() as u16;
    let mut r = row![].spacing(SP_XS).height(8);
    if used > 0 {
        r = r.push(container(Space::new()).width(Length::FillPortion(used)).height(8).style(move |t: &Theme| {
            container::Style { background: Some(ink(t).into()), border: iced::border::rounded(4), ..Default::default() }
        }));
    }
    if used < 1000 {
        let dot = container(Space::new().width(4).height(4)).style(move |t: &Theme| container::Style {
            background: Some(ink(t).into()),
            border: iced::border::rounded(2),
            ..Default::default()
        });
        r = r.push(
            container(dot)
                .width(Length::FillPortion(1000 - used))
                .height(8)
                .padding(Padding::default().right(2))
                .align_right(Length::Fill)
                .center_y(8)
                .style(|t: &Theme| container::Style {
                    background: Some(theme::colors(t).hue_soft.into()),
                    border: iced::border::rounded(4),
                    ..Default::default()
                }),
        );
    }
    r.into()
}

/// A chart on its card, the web's `SpendCard`: bar charts can show as a table instead.
fn chart_card<'a>(
    name: &'static str,
    spec: Option<&'a ChartSpec>,
    table: bool,
    ctx: chart::Ctx<'a, Message>,
) -> Element<'a, Message> {
    let bars = spec.is_some_and(|c| matches!(&c.kind, crate::core::chart::Kind::Bar(s) if !s.horizontal));
    let mut head = row![text(name).size(FS_MD).font(theme::MEDIUM).width(Length::Fill)].align_y(Alignment::Center);
    if bars {
        head = head.push(segmented(&[("Chart", false), ("Table", true)], table, move |t| {
            Message::Page(PageMsg::Spend(Msg::Table(name, t)))
        }));
    }
    let body: Element<'a, Message> = match spec {
        None => text("Nothing spent yet.").size(FS_MD).style(tone(|c| c.muted)).into(),
        Some(c) if bars && table => {
            let mut col = column![].spacing(SP_2XS);
            for (label, usd) in spend::rows(c) {
                col = col.push(
                    row![text(label).size(FS_MD).width(Length::Fill), text(format::money(usd)).size(FS_MD)]
                        .padding([SP, SP_LG]),
                );
            }
            col.into()
        }
        Some(c) => chart::view(c, ctx),
    };
    container(column![container(head).height(40).align_y(Alignment::Center), body].spacing(SP))
        .padding([SP_LG, SP_XL])
        .width(Length::Fill)
        .style(theme::tile(true, true))
        .into()
}

pub fn view(s: &Session, dark: bool) -> Element<'_, Message> {
    let st = &s.pages.spend;
    let limits_btn = row![fill(), btn("Limits", theme::outlined, Some(Message::Go(Route::Settings)))];
    let Some(sum) = &st.summary else { return page(column![limits_btn]) };
    let today = s.store.today_usd.unwrap_or(sum.today_usd);
    let month = s.store.month_usd.unwrap_or(sum.month_usd);
    let limits = sum.limits.as_ref();
    let mut kpis = row![
        figure("Today", today, limits.map(|l| l.daily_usd)),
        figure("This month", month, limits.map(|l| l.monthly_usd)),
    ]
    .spacing(SP_MD)
    .height(Length::Shrink);
    for (name, w) in [("Last hour", &sum.last_hour), ("Last minute", &sum.last_minute)] {
        if let Some(w) = w {
            kpis = kpis.push(figure(name, w.usd, None));
        }
    }
    let ctx = chart::Ctx { dark, photos: None, open: |_| Message::Nothing, wide: true };
    let mut col = column![limits_btn, kpis].spacing(SP_PAGE);
    for (name, spec) in &st.charts {
        col = col.push(chart_card(name, spec.as_ref(), st.tables.contains(name), ctx));
    }
    page(col)
}
