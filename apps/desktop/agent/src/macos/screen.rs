//! Displays and their pixels, through ScreenCaptureKit. macOS works in points, with the top-left of
//! the main display at 0,0; a display's pixels are its points times its scale.

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::AnyThread;
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGColorSpace, CGContext, CGDirectDisplayID, CGDisplayBounds, CGDisplayCopyDisplayMode,
    CGDisplayMode, CGEvent, CGGetActiveDisplayList, CGImage, CGImageAlphaInfo, CGMainDisplayID,
};
use objc2_foundation::{NSArray, NSError};
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow,
};

use super::wins;
use crate::computer::{Frame, Output, Result};

const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct Display {
    pub id: CGDirectDisplayID,
    /// In global points.
    pub bounds: CGRect,
    pub scale: f64,
}

impl Display {
    pub fn output(&self) -> Output {
        Output {
            name: self.id.to_string(),
            width: self.bounds.size.width.round() as u32,
            height: self.bounds.size.height.round() as u32,
            scale: self.scale,
        }
    }

    /// A point on it in its logical pixels, in global points.
    pub fn global(&self, x: f64, y: f64) -> CGPoint {
        CGPoint::new(self.bounds.origin.x + x, self.bounds.origin.y + y)
    }

    pub fn contains(&self, p: CGPoint) -> bool {
        let b = self.bounds;
        p.x >= b.origin.x && p.y >= b.origin.y && p.x < b.origin.x + b.size.width && p.y < b.origin.y + b.size.height
    }

    fn pixels(&self) -> (usize, usize) {
        (
            (self.bounds.size.width * self.scale).round() as usize,
            (self.bounds.size.height * self.scale).round() as usize,
        )
    }
}

fn display(id: CGDirectDisplayID) -> Display {
    let bounds = CGDisplayBounds(id);
    let scale = CGDisplayCopyDisplayMode(id)
        .map(|m| CGDisplayMode::pixel_width(Some(&m)) as f64 / CGDisplayMode::width(Some(&m)).max(1) as f64)
        .filter(|s| *s >= 1.0)
        .unwrap_or(1.0);
    Display { id, bounds, scale }
}

pub fn displays() -> Vec<Display> {
    let mut ids = [0 as CGDirectDisplayID; 16];
    let mut n = 0u32;
    // SAFETY: the buffer holds the 16 asked for.
    unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut n) };
    ids[..(n as usize).min(ids.len())].iter().map(|id| display(*id)).collect()
}

pub fn named(name: &str) -> Result<Display> {
    displays()
        .into_iter()
        .find(|d| d.id.to_string() == name)
        .ok_or_else(|| format!("There's no display {name} any more."))
}

pub fn pointer() -> CGPoint {
    CGEvent::location(CGEvent::new(None).as_deref())
}

/// The display with the window in front, else the pointer's, else the main one.
pub fn focused() -> Result<Display> {
    let all = displays();
    let at = wins::front_center().unwrap_or_else(pointer);
    all.iter()
        .find(|d| d.contains(at))
        .or_else(|| all.iter().find(|d| d.id == CGMainDisplayID()))
        .or(all.first())
        .cloned()
        .ok_or_else(|| "There's no display.".into())
}

/// The display's pixels, the pointer drawn in.
pub fn capture(d: &Display) -> Result<Frame> {
    let (tx, rx) = mpsc::channel::<Result<Frame>>();
    let (id, (width, height)) = (d.id, d.pixels());
    let got_content = RcBlock::new(move |content: *mut SCShareableContent, err: *mut NSError| {
        let tx = tx.clone();
        // SAFETY: ScreenCaptureKit hands either the content or an error, alive for this call.
        let Some(content) = (unsafe { content.as_ref() }) else {
            let _ = tx.send(Err(refused(err)));
            return;
        };
        // SAFETY: plain property reads and constructors on the content just handed over.
        unsafe {
            let Some(display) = content.displays().iter().find(|s| s.displayID() == id) else {
                let _ = tx.send(Err("That display can't be captured.".into()));
                return;
            };
            let none = NSArray::<SCWindow>::new();
            let filter = SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &none);
            let config = SCStreamConfiguration::new();
            config.setWidth(width);
            config.setHeight(height);
            config.setShowsCursor(true);
            let shot = RcBlock::new(move |image: *mut CGImage, err: *mut NSError| {
                let frame = match image.as_ref() {
                    Some(image) => rgb(image),
                    None => Err(refused(err)),
                };
                let _ = tx.send(frame);
            });
            SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(&filter, &config, Some(&shot));
        }
    });
    // SAFETY: the block lives until ScreenCaptureKit is done with it.
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&got_content) };
    rx.recv_timeout(CAPTURE_TIMEOUT).map_err(|_| "Capturing the screen took too long.".to_string())?
}

fn refused(err: *mut NSError) -> String {
    // SAFETY: an error ScreenCaptureKit handed over, alive for the call.
    match unsafe { err.as_ref() } {
        Some(e) if e.code() == -3801 => {
            "macOS doesn't let Hatbot record the screen. Allow it in System Settings → Privacy & Security → Screen & System Audio Recording.".into()
        }
        Some(e) => format!("Can't capture the screen: {}.", e.localizedDescription()),
        None => "Can't capture the screen.".into(),
    }
}

/// Its pixels as RGB, drawn into a bitmap of a known layout whatever the image's own.
fn rgb(image: &CGImage) -> Result<Frame> {
    let (w, h) = (CGImage::width(Some(image)), CGImage::height(Some(image)));
    if w == 0 || h == 0 {
        return Err("Can't capture the screen.".into());
    }
    let mut rgbx = vec![0u8; w * h * 4];
    let space = CGColorSpace::new_device_rgb();
    // SAFETY: the buffer is w×h 32-bit pixels and outlives the context, which is released at the end
    // of this block.
    unsafe {
        let Some(ctx) = CGBitmapContextCreate(
            rgbx.as_mut_ptr().cast(),
            w,
            h,
            8,
            w * 4,
            space.as_deref(),
            CGImageAlphaInfo::NoneSkipLast.0,
        ) else {
            return Err("Can't capture the screen.".into());
        };
        let rect = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w as f64, h as f64));
        CGContext::draw_image(Some(&ctx), rect, Some(image));
    }
    let rgb = rgbx.as_chunks::<4>().0.iter().flat_map(|p| [p[0], p[1], p[2]]).collect();
    Ok(Frame { width: w as u32, height: h as u32, rgb })
}
