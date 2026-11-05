// "Hatbot is using this computer", on top of everything while a task holds the screen, with a Stop.
// A layer-shell surface on Linux; on Windows a window kept out of screen captures, so Hatbot never
// sees it.
use tauri::AppHandle;

/// Shown while it lives.
pub struct Banner {
    app: AppHandle,
}

impl Banner {
    pub fn show(app: &AppHandle, output: Option<String>) -> Option<Banner> {
        imp::show(app, output);
        Some(Banner { app: app.clone() })
    }
}

impl Drop for Banner {
    fn drop(&mut self) {
        imp::hide(&self.app);
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::cell::RefCell;

    use gtk::prelude::*;
    use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
    use tauri::AppHandle;

    use crate::daemon::{self, Msg};

    thread_local! {
        static SHOWN: RefCell<Vec<gtk::Window>> = const { RefCell::new(Vec::new()) };
    }

    const CSS: &str = "
        window { background: transparent; }
        .pill { background: #2a2d24; color: #e4e7d7; border-radius: 999px; padding: 6px 6px 6px 18px; }
        .pill label { font-weight: 500; font-size: 15px; }
        .pill button { background: #ffb4ab; color: #690005; border: none; border-radius: 999px;
            padding: 6px 18px; font-weight: 500; box-shadow: none; text-shadow: none; }
    ";

    fn banner(monitor: &gtk::gdk::Monitor) -> gtk::Window {
        let w = gtk::Window::new(gtk::WindowType::Toplevel);
        w.init_layer_shell();
        w.set_layer(Layer::Overlay);
        w.set_namespace("hatbot-banner");
        w.set_anchor(Edge::Top, true);
        w.set_layer_shell_margin(Edge::Top, 8);
        w.set_keyboard_mode(KeyboardMode::None);
        w.set_monitor(monitor);
        w.set_app_paintable(true);
        if let Some(visual) = WidgetExt::screen(&w).and_then(|s| s.rgba_visual()) {
            w.set_visual(Some(&visual));
        }
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 16);
        row.style_context().add_class("pill");
        row.pack_start(&gtk::Label::new(Some("Hatbot is using this computer")), false, false, 0);
        let stop = gtk::Button::with_label("Stop");
        stop.connect_clicked(|b| {
            b.set_label("Stopping");
            b.set_sensitive(false);
            daemon::send(Msg::StopComputer);
        });
        row.pack_start(&stop, false, false, 0);
        w.add(&row);
        let css = gtk::CssProvider::new();
        if css.load_from_data(CSS.as_bytes()).is_ok() {
            for widget in [w.upcast_ref::<gtk::Widget>(), row.upcast_ref(), stop.upcast_ref()] {
                widget.style_context().add_provider(&css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
            }
            for child in row.children() {
                child.style_context().add_provider(&css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
            }
        }
        w.show_all();
        w
    }

    pub fn show(app: &AppHandle, output: Option<String>) {
        let _ = app.run_on_main_thread(move || {
            if !gtk_layer_shell::is_supported() {
                return;
            }
            let Some(display) = gtk::gdk::Display::default() else { return };
            let monitors: Vec<_> = (0..display.n_monitors()).filter_map(|i| display.monitor(i)).collect();
            // GTK 3 names a monitor by its model; where that isn't the output's name, it shows on each.
            let on: Vec<_> = monitors.iter().filter(|m| m.model().as_deref() == output.as_deref()).collect();
            let on = if on.is_empty() { monitors.iter().collect() } else { on };
            SHOWN.with(|s| s.borrow_mut().extend(on.into_iter().map(banner)));
        });
    }

    pub fn hide(app: &AppHandle) {
        let _ = app.run_on_main_thread(|| {
            SHOWN.with(|s| {
                for w in s.borrow_mut().drain(..) {
                    // SAFETY: the banner's windows are ours alone, made and dropped on this thread.
                    unsafe { w.destroy() };
                }
            });
        });
    }
}

#[cfg(windows)]
mod imp {
    use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

    const LABEL: &str = "banner";
    const SIZE: (f64, f64) = (400.0, 56.0);

    pub fn show(app: &AppHandle, _output: Option<String>) {
        if app.get_webview_window(LABEL).is_some() {
            return;
        }
        let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
            .title("Hatbot is using this computer")
            .inner_size(SIZE.0, SIZE.1)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .build();
        let Ok(w) = w else { return };
        if let Ok(Some(m)) = w.primary_monitor() {
            let scale = m.scale_factor();
            let x = m.position().x as f64 / scale + (m.size().width as f64 / scale - SIZE.0) / 2.0;
            let _ = w.set_position(tauri::LogicalPosition::new(x, m.position().y as f64 / scale + 8.0));
        }
        if let Ok(hwnd) = w.hwnd() {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};
            unsafe {
                let _ = SetWindowDisplayAffinity(HWND(hwnd.0), WDA_EXCLUDEFROMCAPTURE);
            }
        }
        let _ = w.show();
    }

    pub fn hide(app: &AppHandle) {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.destroy();
        }
    }
}
