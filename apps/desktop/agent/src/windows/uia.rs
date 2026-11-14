//! What's under a point or has the keyboard, from UI Automation, in the shape desktop-agent gives the
//! brain for a page's elements; like AT-SPI's on Linux.

// UI Automation's constants, matched on, keep Windows' names.
#![allow(non_upper_case_globals)]

use std::time::Duration;

use windows::Win32::Foundation::POINT;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx};
use windows::Win32::UI::Accessibility::*;

use super::screen;
use crate::computer::{Fields, InspectAt, Result};
use crate::protocol::{AgentElement, ComputerField};

const TIMEOUT: Duration = Duration::from_secs(4);
/// Most elements read looking for a form's buttons.
const MAX_NODES: usize = 500;
/// Most text fields read for what they hold.
const MAX_FIELDS: i32 = 300;
/// Console windows and Windows Terminal's: what's typed in them may be a password nothing marks.
const TERMINALS: [&str; 3] = ["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "TermControl"];

type El = IUIAutomationElement;

pub async fn inspect(at: InspectAt) -> Result<Option<AgentElement>> {
    let read =
        tokio::task::spawn_blocking(move || find(at).map_err(|e| format!("Couldn't read the app's controls: {e}.")));
    match tokio::time::timeout(TIMEOUT, read).await {
        Err(_) => Err("The app's controls took too long to read.".into()),
        Ok(Err(e)) => Err(format!("Hatbot's agent failed: {e}.")),
        Ok(Ok(r)) => r,
    }
}

fn find(at: InspectAt) -> windows::core::Result<Option<AgentElement>> {
    // SAFETY: COM is set up on this thread before use; everything else is UI Automation's own calls.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        let (el, pid) = match at {
            InspectAt::Point { pid, output, on_output, .. } => {
                let Ok(m) = screen::named(&output.name) else { return Ok(None) };
                let (x, y) = m.physical(on_output.0, on_output.1);
                (uia.ElementFromPoint(POINT { x, y })?, Some(pid))
            }
            InspectAt::Focus { pid } => (uia.GetFocusedElement()?, pid),
        };
        if pid.is_some_and(|p| el.CurrentProcessId().ok() != Some(p)) {
            return Ok(None);
        }
        Ok(Some(element(&uia, &el)))
    }
}

pub async fn fields(pid: Option<i32>, field: bool, filled: bool) -> Result<Option<Fields>> {
    let read = tokio::task::spawn_blocking(move || {
        read_fields(pid, field, filled).map_err(|e| format!("Couldn't read the app's controls: {e}."))
    });
    match tokio::time::timeout(TIMEOUT, read).await {
        Err(_) => Err("The app's controls took too long to read.".into()),
        Ok(Err(e)) => Err(format!("Hatbot's agent failed: {e}.")),
        Ok(Ok(r)) => r,
    }
}

/// Up from an element to its window: the pages it's in, whether it's in a terminal, and the window.
struct Ancestry {
    docs: usize,
    terminal: bool,
    window: El,
}

fn ancestry(uia: &IUIAutomation, walker: &IUIAutomationTreeWalker, el: &El) -> Ancestry {
    let mut out = Ancestry { docs: 0, terminal: terminal(el), window: el.clone() };
    // SAFETY: the walker's own calls on live elements.
    let Ok(root) = (unsafe { uia.GetRootElement() }) else { return out };
    let mut cur = el.clone();
    for _ in 0..80 {
        let Ok(parent) = (unsafe { walker.GetParentElement(&cur) }) else { break };
        if same(uia, &parent, &root) || same(uia, &parent, &cur) {
            break;
        }
        out.docs += usize::from(kind(&parent) == UIA_DocumentControlTypeId);
        out.terminal |= terminal(&parent);
        out.window = parent.clone();
        cur = parent;
    }
    out
}

fn terminal(el: &El) -> bool {
    // SAFETY: a plain property read.
    unsafe { el.CurrentClassName() }.is_ok_and(|c| TERMINALS.contains(&c.to_string().as_str()))
}

fn field(el: &El, up: &Ancestry) -> ComputerField {
    // SAFETY: plain property reads.
    let (help, id, password) = unsafe {
        (
            el.CurrentHelpText().map(|s| s.to_string()).unwrap_or_default(),
            el.CurrentAutomationId().map(|s| s.to_string()).unwrap_or_default(),
            el.CurrentIsPassword().is_ok_and(|b| b.as_bool()),
        )
    };
    let mut names = vec![name(el), help, id];
    names.retain(|n| !n.trim().is_empty());
    for n in &mut names {
        *n = n.chars().take(200).collect();
    }
    ComputerField {
        role: if up.terminal { "terminal".into() } else { tag(kind(el)).into() },
        names,
        password,
        // A page's frame is a page in a page.
        in_frame: up.docs > 1,
        editable: value(el).is_some_and(|v| unsafe { v.CurrentIsReadOnly() }.is_ok_and(|r| !r.as_bool())),
    }
}

fn value(el: &El) -> Option<IUIAutomationValuePattern> {
    // SAFETY: a plain pattern read.
    unsafe { el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }.ok()
}

fn read_fields(pid: Option<i32>, field_too: bool, filled: bool) -> windows::core::Result<Option<Fields>> {
    // SAFETY: COM is set up on this thread before use; everything else is UI Automation's own calls.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        let walker = uia.ControlViewWalker()?;
        let focused = uia.GetFocusedElement()?;
        if pid.is_some_and(|p| focused.CurrentProcessId().ok() != Some(p)) {
            return Ok(None);
        }
        let up = ancestry(&uia, &walker, &focused);
        let mut out = Fields { focused: field_too.then(|| field(&focused, &up)), ..Default::default() };
        // Chromium gives its page's address as the page's value.
        let page = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &UIA_DocumentControlTypeId.0.into())?;
        if let Ok(doc) = up.window.FindFirst(TreeScope_Descendants, &page)
            && let Some(url) = value(&doc).and_then(|v| v.CurrentValue().ok()).map(|v| v.to_string())
            && ["http://", "https://", "file://"].iter().any(|p| url.starts_with(p))
        {
            out.url = Some(url);
        }
        if filled {
            let edits = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &UIA_EditControlTypeId.0.into())?;
            let all = up.window.FindAll(TreeScope_Descendants, &edits)?;
            let n = all.Length()?;
            if n > MAX_FIELDS {
                return Ok(Some(out));
            }
            let mut held = Vec::new();
            for i in 0..n {
                let el = all.GetElement(i)?;
                if el.CurrentIsOffscreen().is_ok_and(|b| b.as_bool()) {
                    continue;
                }
                let password = el.CurrentIsPassword().is_ok_and(|b| b.as_bool());
                let holds = match value(&el).map(|v| v.CurrentValue()) {
                    Some(Ok(v)) => !v.is_empty(),
                    // A password field that won't say shows dots.
                    _ if password => false,
                    // Anything else may hold something.
                    _ => true,
                };
                if holds {
                    held.push(field(&el, &ancestry(&uia, &walker, &el)));
                }
            }
            out.filled = Some(held);
        }
        Ok(Some(out))
    }
}

fn kind(el: &El) -> UIA_CONTROLTYPE_ID {
    // SAFETY: a plain property read.
    unsafe { el.CurrentControlType() }.unwrap_or_default()
}

fn name(el: &El) -> String {
    // SAFETY: plain property reads.
    unsafe { el.CurrentName() }.map(|s| s.to_string().trim().to_owned()).unwrap_or_default()
}

fn same(uia: &IUIAutomation, a: &El, b: &El) -> bool {
    // SAFETY: both are live elements.
    unsafe { uia.CompareElements(a, b) }.is_ok_and(|b| b.as_bool())
}

fn is_form(el: &El) -> bool {
    // SAFETY: a plain property read.
    let v = unsafe { el.GetCurrentPropertyValue(UIA_LandmarkTypePropertyId) };
    v.ok().and_then(|v| i32::try_from(&v).ok()) == Some(UIA_FormLandmarkTypeId.0)
}

fn element(uia: &IUIAutomation, el: &El) -> AgentElement {
    let t = kind(el);
    let mut label = name(el);
    if label.is_empty() {
        // SAFETY: a plain property read.
        label = unsafe { el.CurrentHelpText() }.map(|s| s.to_string().trim().to_owned()).unwrap_or_default();
    }
    let label: String = label.chars().take(200).collect();
    // SAFETY: plain property and pattern reads.
    let (secret, value, toggles, expands) = unsafe {
        (
            el.CurrentIsPassword().is_ok_and(|b| b.as_bool()),
            el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).ok(),
            el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId).is_ok(),
            el.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId).is_ok(),
        )
    };
    let text_box = matches!(t, UIA_EditControlTypeId | UIA_DocumentControlTypeId | UIA_ComboBoxControlTypeId);
    // SAFETY: a plain property read.
    let editable = text_box && value.is_some_and(|v| unsafe { v.CurrentIsReadOnly() }.is_ok_and(|r| !r.as_bool()));
    let mut out = AgentElement {
        tag: tag(t).into(),
        role: aria(t).map(str::to_owned),
        kind: None,
        label,
        in_form: false,
        editable: Some(editable),
        secret: secret.then_some(true),
        toggle: (toggles
            || (expands && t != UIA_ComboBoxControlTypeId)
            || matches!(t, UIA_CheckBoxControlTypeId | UIA_TabItemControlTypeId | UIA_MenuControlTypeId))
        .then_some(true),
        ..Default::default()
    };
    // SAFETY: the walker and the elements it gives are UI Automation's own.
    let Ok(walker) = (unsafe { uia.ControlViewWalker() }) else { return out };
    // Up the tree for a form, and for the nearest part with buttons in it.
    let mut cur = el.clone();
    let mut buttons_from: Option<El> = None;
    for _ in 0..30 {
        // SAFETY: as above.
        let Ok(parent) = (unsafe { walker.GetParentElement(&cur) }) else { break };
        if same(uia, &parent, &cur) {
            break;
        }
        if kind(&parent) == UIA_WindowControlTypeId {
            buttons_from.get_or_insert(parent);
            break;
        }
        if is_form(&parent) {
            out.in_form = true;
            out.submit_label = buttons(uia, &walker, &parent, el).0.into_iter().next();
            buttons_from.get_or_insert(parent);
            break;
        }
        if editable && buttons_from.is_none() && !buttons(uia, &walker, &parent, el).1.is_empty() {
            buttons_from = Some(parent.clone());
        }
        cur = parent;
    }
    if editable && let Some(scope) = buttons_from {
        let (after, before) = buttons(uia, &walker, &scope, el);
        let all: Vec<String> = after.into_iter().chain(before).collect();
        out.buttons_after = (!all.is_empty()).then_some(all);
    }
    out
}

/// The buttons in a part of the tree, in order: those after `from` first, then those before.
fn buttons(uia: &IUIAutomation, walker: &IUIAutomationTreeWalker, scope: &El, from: &El) -> (Vec<String>, Vec<String>) {
    let (mut before, mut after) = (Vec::new(), Vec::new());
    let mut passed = false;
    let mut stack = vec![scope.clone()];
    let mut seen = 0;
    while let Some(e) = stack.pop() {
        seen += 1;
        if seen > MAX_NODES {
            break;
        }
        if same(uia, &e, from) {
            passed = true;
        }
        if matches!(kind(&e), UIA_ButtonControlTypeId | UIA_SplitButtonControlTypeId) {
            if passed {
                after.push(name(&e))
            } else {
                before.push(name(&e))
            }
            continue;
        }
        let mut children = Vec::new();
        // SAFETY: the walker's own calls on live elements.
        let mut child = unsafe { walker.GetFirstChildElement(&e) }.ok();
        while let Some(c) = child {
            child = unsafe { walker.GetNextSiblingElement(&c) }.ok();
            children.push(c);
        }
        stack.extend(children.into_iter().rev());
    }
    (after, before)
}

/// The control type's name, as AT-SPI's role names read.
fn tag(t: UIA_CONTROLTYPE_ID) -> &'static str {
    match t {
        UIA_ButtonControlTypeId | UIA_SplitButtonControlTypeId => "button",
        UIA_CheckBoxControlTypeId => "check box",
        UIA_RadioButtonControlTypeId => "radio button",
        UIA_HyperlinkControlTypeId => "link",
        UIA_EditControlTypeId => "entry",
        UIA_DocumentControlTypeId => "document",
        UIA_ComboBoxControlTypeId => "combo box",
        UIA_MenuItemControlTypeId => "menu item",
        UIA_MenuControlTypeId => "menu",
        UIA_MenuBarControlTypeId => "menu bar",
        UIA_TabItemControlTypeId => "page tab",
        UIA_TabControlTypeId => "page tab list",
        UIA_SliderControlTypeId => "slider",
        UIA_SpinnerControlTypeId => "spin button",
        UIA_ListControlTypeId => "list",
        UIA_ListItemControlTypeId => "list item",
        UIA_DataItemControlTypeId => "table cell",
        UIA_TreeItemControlTypeId => "tree item",
        UIA_TextControlTypeId => "label",
        UIA_ImageControlTypeId => "image",
        UIA_ToolBarControlTypeId => "tool bar",
        UIA_WindowControlTypeId => "frame",
        UIA_PaneControlTypeId => "panel",
        UIA_GroupControlTypeId => "grouping",
        _ => "unknown",
    }
}

fn aria(t: UIA_CONTROLTYPE_ID) -> Option<&'static str> {
    Some(match t {
        UIA_ButtonControlTypeId | UIA_SplitButtonControlTypeId => "button",
        UIA_CheckBoxControlTypeId => "checkbox",
        UIA_RadioButtonControlTypeId => "radio",
        UIA_HyperlinkControlTypeId => "link",
        UIA_EditControlTypeId | UIA_DocumentControlTypeId => "textbox",
        UIA_ComboBoxControlTypeId => "combobox",
        UIA_MenuItemControlTypeId => "menuitem",
        UIA_MenuControlTypeId => "menu",
        UIA_TabItemControlTypeId => "tab",
        UIA_SliderControlTypeId => "slider",
        UIA_SpinnerControlTypeId => "spinbutton",
        UIA_ListItemControlTypeId => "listitem",
        UIA_DataItemControlTypeId => "cell",
        UIA_ImageControlTypeId => "img",
        _ => return None,
    })
}
