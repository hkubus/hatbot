//! The pasteboard. What it held is read whole, each item's types as their bytes ("macos/0/public.png"),
//! to be put back as it was. Text Hatbot pastes is promised rather than placed, so the agent hears
//! when an app reads it, and is marked transient so clipboard managers leave it out. Runs on the main
//! thread, whose run loop delivers the pasteboard's requests.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_app_kit::{
    NSPasteboard, NSPasteboardItem, NSPasteboardItemDataProvider, NSPasteboardType, NSPasteboardWriting,
};
use objc2_foundation::{NSArray, NSData, NSString};
use tokio::sync::oneshot;

use crate::computer::{Clip, Result};

const PREFIX: &str = "macos/";
const TEXT: &str = "public.utf8-plain-text";
/// nspasteboard.org's marker for what a clipboard manager shouldn't keep.
const TRANSIENT: &str = "org.nspasteboard.TransientType";

struct Promise {
    text: Vec<u8>,
    read: Mutex<Option<oneshot::Sender<()>>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "HatbotPastedText"]
    #[ivars = Promise]
    struct PastedText;

    unsafe impl NSObjectProtocol for PastedText {}

    unsafe impl NSPasteboardItemDataProvider for PastedText {
        #[unsafe(method(pasteboard:item:provideDataForType:))]
        fn provide(&self, _pasteboard: Option<&NSPasteboard>, item: &NSPasteboardItem, kind: &NSPasteboardType) {
            item.setData_forType(&NSData::with_bytes(&self.ivars().text), kind);
            if let Some(tx) = self.ivars().read.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = tx.send(());
            }
        }
    }
);

impl PastedText {
    fn new(text: Vec<u8>, read: oneshot::Sender<()>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(Promise { text, read: Mutex::new(Some(read)) });
        // SAFETY: NSObject's own init.
        unsafe { msg_send![super(this), init] }
    }
}

thread_local! {
    /// The pasteboard doesn't keep what promised its data.
    static PROMISED: RefCell<Option<Retained<PastedText>>> = const { RefCell::new(None) };
}

pub fn read() -> Result<Option<Clip>> {
    let pb = NSPasteboard::generalPasteboard();
    let Some(items) = pb.pasteboardItems() else { return Ok(None) };
    let mut entries = Vec::new();
    for (i, item) in items.iter().enumerate() {
        for kind in item.types().iter() {
            if let Some(data) = item.dataForType(&kind) {
                entries.push((format!("{PREFIX}{i}/{kind}"), data.to_vec()));
            }
        }
    }
    Ok((!entries.is_empty()).then_some(Clip(entries)))
}

fn writer(item: &NSPasteboardItem) -> &ProtocolObject<dyn NSPasteboardWriting> {
    ProtocolObject::from_ref(item)
}

pub fn write(clip: Option<Clip>) -> Result<oneshot::Receiver<()>> {
    let (tx, rx) = oneshot::channel();
    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    PROMISED.with(|p| p.borrow_mut().take());
    let entries = clip.map(|c| c.0).unwrap_or_default();
    if let Some((_, text)) = entries.iter().find(|(m, _)| m == "text/plain;charset=utf-8") {
        let item = NSPasteboardItem::new();
        let promise = PastedText::new(text.clone(), tx);
        item.setDataProvider_forTypes(
            ProtocolObject::from_ref(&*promise),
            &NSArray::from_retained_slice(&[NSString::from_str(TEXT)]),
        );
        item.setData_forType(&NSData::new(), &NSString::from_str(TRANSIENT));
        PROMISED.with(|p| *p.borrow_mut() = Some(promise));
        pb.writeObjects(&NSArray::from_slice(&[writer(&item)]));
        return Ok(rx);
    }
    let mut items: BTreeMap<usize, Vec<(&str, &[u8])>> = BTreeMap::new();
    for (name, bytes) in &entries {
        let Some((i, kind)) = name.strip_prefix(PREFIX).and_then(|r| r.split_once('/')) else { continue };
        let Ok(i) = i.parse::<usize>() else { continue };
        items.entry(i).or_default().push((kind, bytes));
    }
    let items: Vec<Retained<NSPasteboardItem>> = items
        .into_values()
        .map(|kinds| {
            let item = NSPasteboardItem::new();
            for (kind, bytes) in kinds {
                item.setData_forType(&NSData::with_bytes(bytes), &NSString::from_str(kind));
            }
            item
        })
        .collect();
    if !items.is_empty() {
        let writers: Vec<&ProtocolObject<dyn NSPasteboardWriting>> = items.iter().map(|i| writer(i)).collect();
        pb.writeObjects(&NSArray::from_slice(&writers));
    }
    let _ = tx.send(());
    Ok(rx)
}
