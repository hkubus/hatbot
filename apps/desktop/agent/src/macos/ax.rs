//! What's under a point or has the keyboard, from the Accessibility API, in the shape desktop-agent
//! gives the brain for a page's elements; like AT-SPI's on Linux and UI Automation's on Windows.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::time::Duration;

use objc2_application_services::{AXError, AXIsProcessTrustedWithOptions, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{CFArray, CFRetained, CFString, CFType, CGPoint, CGSize};

use super::screen;
use crate::computer::{InspectAt, Result};
use crate::protocol::AgentElement;

const TIMEOUT: Duration = Duration::from_secs(4);
/// How long one app may take to answer one question.
const APP_TIMEOUT_SECS: f32 = 1.0;
/// Most elements read looking for a form's buttons.
const MAX_NODES: usize = 500;

pub type El = CFRetained<AXUIElement>;

/// Whether macOS lets this process (through the app that started it) use the Accessibility API.
pub fn trusted() -> bool {
    // SAFETY: no options.
    unsafe { AXIsProcessTrustedWithOptions(None) }
}

pub fn attr(el: &AXUIElement, name: &str) -> Option<CFRetained<CFType>> {
    let mut out: *const CFType = std::ptr::null();
    // SAFETY: a plain out-parameter, retained when it's set (the Copy rule).
    let err = unsafe { el.copy_attribute_value(&CFString::from_str(name), NonNull::from(&mut out)) };
    if err != AXError::Success {
        return None;
    }
    NonNull::new(out.cast_mut()).map(|p| unsafe { CFRetained::from_raw(p) })
}

pub fn string(el: &AXUIElement, name: &str) -> Option<String> {
    let v = attr(el, name)?;
    let s = v.downcast_ref::<CFString>()?.to_string();
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_owned())
}

pub fn element(el: &AXUIElement, name: &str) -> Option<El> {
    attr(el, name)?.downcast::<AXUIElement>().ok()
}

pub fn elements(el: &AXUIElement, name: &str) -> Vec<El> {
    let Some(v) = attr(el, name) else { return Vec::new() };
    let Ok(list) = v.downcast::<CFArray>() else { return Vec::new() };
    // SAFETY: AX lists of elements hold elements; anything else is skipped below.
    let list = unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(list) };
    list.iter().filter_map(|e| e.downcast::<AXUIElement>().ok()).collect()
}

fn value<T: Default>(el: &AXUIElement, name: &str, kind: AXValueType) -> Option<T> {
    let v = attr(el, name)?.downcast::<AXValue>().ok()?;
    let mut out = T::default();
    // SAFETY: `kind` names the struct `T` is.
    unsafe { v.value(kind, NonNull::from(&mut out).cast::<c_void>()) }.then_some(out)
}

pub fn position(el: &AXUIElement) -> Option<CGPoint> {
    value(el, "AXPosition", AXValueType::CGPoint)
}

pub fn size(el: &AXUIElement) -> Option<CGSize> {
    value(el, "AXSize", AXValueType::CGSize)
}

pub fn settable(el: &AXUIElement, name: &str) -> bool {
    let mut out: u8 = 0;
    // SAFETY: a plain out-parameter.
    let err = unsafe { el.is_attribute_settable(&CFString::from_str(name), NonNull::from(&mut out)) };
    err == AXError::Success && out != 0
}

pub fn pid(el: &AXUIElement) -> Option<i32> {
    let mut pid = 0;
    // SAFETY: a plain out-parameter.
    (unsafe { el.pid(NonNull::from(&mut pid)) } == AXError::Success).then_some(pid)
}

pub fn app(pid: i32) -> El {
    // SAFETY: any pid makes an element; a gone one only fails its questions.
    let el = unsafe { AXUIElement::new_application(pid) };
    // SAFETY: a plain setter.
    unsafe { el.set_messaging_timeout(APP_TIMEOUT_SECS) };
    el
}

pub async fn inspect(at: InspectAt) -> Result<Option<AgentElement>> {
    let read = tokio::task::spawn_blocking(move || find(at));
    match tokio::time::timeout(TIMEOUT, read).await {
        Err(_) => Err("The app's controls took too long to read.".into()),
        Ok(Err(e)) => Err(format!("Hatbot's agent failed: {e}.")),
        Ok(Ok(r)) => Ok(r),
    }
}

fn find(at: InspectAt) -> Option<AgentElement> {
    // SAFETY: the system-wide element, and plain calls on it.
    let system = unsafe { AXUIElement::new_system_wide() };
    unsafe { system.set_messaging_timeout(APP_TIMEOUT_SECS) };
    let (el, want) = match at {
        InspectAt::Point { pid, output, on_output, .. } => {
            let p = screen::named(&output.name).ok()?.global(on_output.0, on_output.1);
            let mut out: *const AXUIElement = std::ptr::null();
            // SAFETY: a plain out-parameter, retained when it's set.
            let err = unsafe { system.copy_element_at_position(p.x as f32, p.y as f32, NonNull::from(&mut out)) };
            if err != AXError::Success {
                return None;
            }
            (NonNull::new(out.cast_mut()).map(|p| unsafe { CFRetained::from_raw(p) })?, Some(pid))
        }
        InspectAt::Focus { pid } => (element(&system, "AXFocusedUIElement")?, pid),
    };
    if want.is_some_and(|p| pid(&el) != Some(p)) {
        return None;
    }
    Some(describe(&el))
}

fn label(el: &AXUIElement) -> String {
    let l = ["AXTitle", "AXDescription", "AXPlaceholderValue", "AXHelp"]
        .iter()
        .find_map(|a| string(el, a))
        .or_else(|| element(el, "AXTitleUIElement").and_then(|t| string(&t, "AXValue")))
        .unwrap_or_default();
    l.chars().take(200).collect()
}

fn is_form(role: &str, subrole: &str) -> bool {
    role == "AXForm" || subrole == "AXLandmarkForm"
}

fn describe(el: &AXUIElement) -> AgentElement {
    let role = string(el, "AXRole").unwrap_or_default();
    let subrole = string(el, "AXSubrole").unwrap_or_default();
    let text_box = matches!(role.as_str(), "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField");
    let editable = text_box && settable(el, "AXValue");
    let mut out = AgentElement {
        tag: tag(&role).into(),
        role: aria(&role).map(str::to_owned),
        kind: None,
        label: label(el),
        in_form: false,
        editable: Some(editable),
        secret: (subrole == "AXSecureTextField").then_some(true),
        toggle: matches!(
            role.as_str(),
            "AXCheckBox"
                | "AXDisclosureTriangle"
                | "AXPopUpButton"
                | "AXMenuButton"
                | "AXRadioButton"
                | "AXMenuBarItem"
        )
        .then_some(true),
        ..Default::default()
    };
    // Up the tree for a form, and for the nearest part with buttons in it.
    let mut cur: El = match element(el, "AXParent") {
        Some(p) => p,
        None => return out,
    };
    let mut buttons_from: Option<El> = None;
    for _ in 0..30 {
        let (r, s) = (string(&cur, "AXRole").unwrap_or_default(), string(&cur, "AXSubrole").unwrap_or_default());
        if r == "AXWindow" {
            buttons_from.get_or_insert(cur.clone());
            break;
        }
        if is_form(&r, &s) {
            out.in_form = true;
            out.submit_label = buttons(&cur, el).0.into_iter().next();
            buttons_from.get_or_insert(cur.clone());
            break;
        }
        if editable && buttons_from.is_none() && !buttons(&cur, el).1.is_empty() {
            buttons_from = Some(cur.clone());
        }
        match element(&cur, "AXParent") {
            Some(p) => cur = p,
            None => break,
        }
    }
    if editable && let Some(scope) = buttons_from {
        let (after, before) = buttons(&scope, el);
        let all: Vec<String> = after.into_iter().chain(before).collect();
        out.buttons_after = (!all.is_empty()).then_some(all);
    }
    out
}

/// The buttons in a part of the tree, in order: those after `from` first, then those before.
fn buttons(scope: &AXUIElement, from: &AXUIElement) -> (Vec<String>, Vec<String>) {
    let (mut before, mut after) = (Vec::new(), Vec::new());
    let mut passed = false;
    let mut stack: Vec<El> = elements(scope, "AXChildren").into_iter().rev().collect();
    let mut seen = 0;
    while let Some(e) = stack.pop() {
        seen += 1;
        if seen > MAX_NODES {
            break;
        }
        if *e == *from {
            passed = true;
        }
        if string(&e, "AXRole").as_deref() == Some("AXButton") {
            let name = label(&e);
            if passed {
                after.push(name)
            } else {
                before.push(name)
            }
            continue;
        }
        stack.extend(elements(&e, "AXChildren").into_iter().rev());
    }
    (after, before)
}

/// The role's name, as AT-SPI's role names read.
fn tag(role: &str) -> &'static str {
    match role {
        "AXButton" | "AXMenuButton" => "button",
        "AXCheckBox" => "check box",
        "AXRadioButton" => "radio button",
        "AXLink" => "link",
        "AXTextField" | "AXSearchField" => "entry",
        "AXTextArea" => "document",
        "AXComboBox" | "AXPopUpButton" => "combo box",
        "AXMenuItem" | "AXMenuBarItem" => "menu item",
        "AXMenu" => "menu",
        "AXMenuBar" => "menu bar",
        "AXTabGroup" => "page tab list",
        "AXSlider" => "slider",
        "AXIncrementor" => "spin button",
        "AXList" | "AXTable" | "AXOutline" => "list",
        "AXRow" => "list item",
        "AXCell" => "table cell",
        "AXStaticText" => "label",
        "AXImage" => "image",
        "AXToolbar" => "tool bar",
        "AXWindow" | "AXSheet" | "AXDialog" => "frame",
        "AXScrollArea" | "AXSplitGroup" => "panel",
        "AXGroup" => "grouping",
        "AXWebArea" => "document",
        _ => "unknown",
    }
}

fn aria(role: &str) -> Option<&'static str> {
    Some(match role {
        "AXButton" | "AXMenuButton" => "button",
        "AXCheckBox" => "checkbox",
        "AXRadioButton" => "radio",
        "AXLink" => "link",
        "AXTextField" | "AXTextArea" | "AXSearchField" => "textbox",
        "AXComboBox" | "AXPopUpButton" => "combobox",
        "AXMenuItem" | "AXMenuBarItem" => "menuitem",
        "AXMenu" => "menu",
        "AXSlider" => "slider",
        "AXIncrementor" => "spinbutton",
        "AXRow" => "listitem",
        "AXCell" => "cell",
        "AXImage" => "img",
        _ => return None,
    })
}
