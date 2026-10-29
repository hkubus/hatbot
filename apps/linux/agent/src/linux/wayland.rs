//! The Wayland side, on generic wlroots protocols: screencopy for pixels, a virtual pointer, idle
//! notifications for the owner's activity, data control for the clipboard, and the seat's keymap.
//! One thread owns the connection; the agent sends it commands.

use std::collections::HashMap;
use std::io::Write;
use std::os::fd::{AsFd, OwnedFd};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use calloop::EventLoop;
use calloop::channel::{Event as ChannelEvent, Sender as ChannelSender, channel};
use calloop_wayland_source::WaylandSource;
use tokio::sync::{mpsc, oneshot};
use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::{
    wl_buffer::WlBuffer, wl_keyboard, wl_keyboard::WlKeyboard, wl_output, wl_output::WlOutput, wl_pointer, wl_registry,
    wl_registry::WlRegistry, wl_seat, wl_seat::WlSeat, wl_shm, wl_shm::WlShm, wl_shm_pool::WlShmPool,
};
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle, WEnum, delegate_noop, event_created_child};
use wayland_protocols::ext::idle_notify::v1::client::{
    ext_idle_notification_v1::{self, ExtIdleNotificationV1},
    ext_idle_notifier_v1::ExtIdleNotifierV1,
};
use wayland_protocols::xdg::xdg_output::zv1::client::{
    zxdg_output_manager_v1::ZxdgOutputManagerV1,
    zxdg_output_v1::{self, ZxdgOutputV1},
};
use wayland_protocols_wlr::data_control::v1::client::{
    zwlr_data_control_device_v1::{self, ZwlrDataControlDeviceV1},
    zwlr_data_control_manager_v1::ZwlrDataControlManagerV1,
    zwlr_data_control_offer_v1::{self, ZwlrDataControlOfferV1},
    zwlr_data_control_source_v1::{self, ZwlrDataControlSourceV1},
};
use wayland_protocols_wlr::screencopy::v1::client::{
    zwlr_screencopy_frame_v1::{self, ZwlrScreencopyFrameV1},
    zwlr_screencopy_manager_v1::ZwlrScreencopyManagerV1,
};
use wayland_protocols_wlr::virtual_pointer::v1::client::{
    zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1, zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1,
};

use crate::activity::{NOTICE_MS, QUIET_MS};
use crate::computer::{Button, Clip, Frame, Result, SessionEvent};

/// A monitor as Wayland describes it, in logical pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct OutputInfo {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

/// What the compositor offers.
#[derive(Debug, Clone, Copy, Default)]
pub struct Has {
    pub screencopy: bool,
    pub pointer: bool,
}

type Reply<T> = oneshot::Sender<Result<T>>;

enum Cmd {
    Outputs(oneshot::Sender<Vec<OutputInfo>>),
    Capture { output: String, reply: Reply<Frame> },
    Motion { output: String, x: f64, y: f64, reply: Reply<()> },
    Button { button: Button, down: bool, reply: Reply<()> },
    Wheel { dx: i32, dy: i32, reply: Reply<()> },
    Keymap(oneshot::Sender<Option<String>>),
    Clipboard(Reply<Vec<(String, OwnedFd)>>),
    SetClipboard { clip: Option<Clip>, reply: Reply<oneshot::Receiver<()>> },
}

/// The handle the agent keeps. Commands fail once the connection has gone.
pub struct Wayland {
    tx: ChannelSender<Cmd>,
    pub has: Has,
}

const GONE: &str = "The Wayland session has gone.";

impl Wayland {
    /// Connects to the session's compositor ($WAYLAND_DISPLAY), or the one at a socket's path.
    pub fn connect(socket: Option<&std::path::Path>, events: mpsc::UnboundedSender<SessionEvent>) -> Result<Self> {
        let conn = match socket {
            Some(path) => {
                let stream = std::os::unix::net::UnixStream::connect(path)
                    .map_err(|e| format!("Can't reach the Wayland compositor: {e}."))?;
                Connection::from_socket(stream).map_err(|e| format!("Can't reach the Wayland compositor: {e}."))?
            }
            None => Connection::connect_to_env().map_err(|e| format!("Can't reach the Wayland compositor: {e}."))?,
        };
        let (globals, queue) =
            registry_queue_init::<State>(&conn).map_err(|e| format!("The Wayland compositor didn't answer: {e}."))?;
        let qh = queue.handle();
        let bind = |name: &str, max: u32| {
            globals
                .contents()
                .with_list(|l| l.iter().find(|g| g.interface == name).map(|g| (g.name, g.version.min(max))))
        };
        let registry = globals.registry();
        macro_rules! global {
            ($t:ty, $max:expr) => {
                bind(<$t>::interface().name, $max).map(|(n, v)| registry.bind::<$t, _, State>(n, v, &qh, ()))
            };
        }
        let mut state = State {
            conn: conn.clone(),
            qh: qh.clone(),
            start: Instant::now(),
            events,
            shm: global!(WlShm, 1),
            seat: global!(WlSeat, 7),
            xdg: global!(ZxdgOutputManagerV1, 3),
            screencopy: global!(ZwlrScreencopyManagerV1, 3),
            pointer_manager: global!(ZwlrVirtualPointerManagerV1, 2),
            idle: global!(ExtIdleNotifierV1, 2),
            data_control: global!(ZwlrDataControlManagerV1, 2),
            outputs: Vec::new(),
            pointers: HashMap::new(),
            last_pointer: None,
            keyboard: None,
            keymap: None,
            device: None,
            offers: HashMap::new(),
            selection: None,
            captures: HashMap::new(),
        };
        let outputs: Vec<_> = globals.contents().with_list(|l| {
            l.iter().filter(|g| g.interface == WlOutput::interface().name).map(|g| (g.name, g.version)).collect()
        });
        for (name, version) in outputs {
            state.add_output(registry, name, version);
        }
        let mut queue = queue;
        // One round trip fills in the monitors' names and sizes, and the keymap.
        queue.roundtrip(&mut state).map_err(|e| format!("The Wayland compositor didn't answer: {e}."))?;
        let has = Has {
            screencopy: state.screencopy.is_some() && state.shm.is_some(),
            pointer: state.pointer_manager.is_some() && state.seat.is_some(),
        };
        if let Some(seat) = &state.seat {
            if let Some(idle) = &state.idle {
                for (ms, kind) in [(NOTICE_MS, Idle::Notice), (QUIET_MS, Idle::Quiet)] {
                    // Version 2's input notifications ignore a video holding the screen awake.
                    if idle.version() >= 2 {
                        idle.get_input_idle_notification(ms, seat, &qh, kind);
                    } else {
                        idle.get_idle_notification(ms, seat, &qh, kind);
                    }
                }
            }
            if let Some(dc) = &state.data_control {
                state.device = Some(dc.get_data_device(seat, &qh, ()));
            }
        }

        let (tx, rx) = channel::<Cmd>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("hatbot-wayland".into())
            .spawn(move || {
                let mut ev: EventLoop<State> = match EventLoop::try_new() {
                    Ok(l) => l,
                    Err(e) => return drop(ready_tx.send(Err(e.to_string()))),
                };
                let handle = ev.handle();
                if let Err(e) = WaylandSource::new(conn, queue).insert(handle.clone()) {
                    return drop(ready_tx.send(Err(e.to_string())));
                }
                if let Err(e) = handle.insert_source(rx, |e, _, state: &mut State| {
                    if let ChannelEvent::Msg(cmd) = e {
                        state.command(cmd);
                    }
                }) {
                    return drop(ready_tx.send(Err(e.to_string())));
                }
                let _ = ready_tx.send(Ok(()));
                let _ = ev.run(None, &mut state, |_| {});
            })
            .map_err(|e| e.to_string())?;
        ready_rx.recv().map_err(|_| GONE.to_string())??;
        Ok(Self { tx, has })
    }

    async fn ask<T>(&self, cmd: impl FnOnce(oneshot::Sender<T>) -> Cmd) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(cmd(tx)).map_err(|_| GONE.to_string())?;
        rx.await.map_err(|_| GONE.to_string())
    }

    pub fn alive(&self) -> bool {
        // A closed channel means the thread has ended.
        self.tx.send(Cmd::Keymap(oneshot::channel().0)).is_ok()
    }

    pub async fn outputs(&self) -> Result<Vec<OutputInfo>> {
        self.ask(Cmd::Outputs).await
    }

    pub async fn capture(&self, output: String) -> Result<Frame> {
        self.ask(|reply| Cmd::Capture { output, reply }).await?
    }

    /// The pointer to a point on a monitor, in its logical pixels.
    pub async fn motion(&self, output: String, x: f64, y: f64) -> Result<()> {
        self.ask(|reply| Cmd::Motion { output, x, y, reply }).await?
    }

    pub async fn button(&self, button: Button, down: bool) -> Result<()> {
        self.ask(|reply| Cmd::Button { button, down, reply }).await?
    }

    pub async fn wheel(&self, dx: i32, dy: i32) -> Result<()> {
        self.ask(|reply| Cmd::Wheel { dx, dy, reply }).await?
    }

    pub async fn keymap(&self) -> Result<Option<String>> {
        self.ask(Cmd::Keymap).await
    }

    /// What the clipboard holds, each type read in turn, up to 16 MB in all.
    pub async fn clipboard(&self) -> Result<Option<Clip>> {
        use tokio::io::AsyncReadExt;
        let pipes = self.ask(Cmd::Clipboard).await??;
        if pipes.is_empty() {
            return Ok(None);
        }
        let mut clip = Clip::default();
        let mut total = 0usize;
        for (mime, fd) in pipes {
            let mut file = tokio::fs::File::from_std(std::fs::File::from(fd));
            let mut data = Vec::new();
            let read = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                (&mut file).take((16 << 20) as u64).read_to_end(&mut data),
            )
            .await;
            if matches!(read, Ok(Ok(_))) && total + data.len() <= 16 << 20 {
                total += data.len();
                clip.0.push((mime, data));
            }
        }
        Ok(Some(clip))
    }

    pub async fn set_clipboard(&self, clip: Option<Clip>) -> Result<oneshot::Receiver<()>> {
        self.ask(|reply| Cmd::SetClipboard { clip, reply }).await?
    }
}

#[derive(Debug, Clone, Copy)]
enum Idle {
    Notice,
    Quiet,
}

struct Out {
    global: u32,
    output: WlOutput,
    name: String,
    logical: Option<(i32, i32, i32, i32)>,
    mode: Option<(i32, i32)>,
    transform_swaps: bool,
}

impl Out {
    fn info(&self) -> Option<OutputInfo> {
        let (x, y, w, h) = self.logical?;
        let scale = self
            .mode
            .map(|(mw, mh)| if self.transform_swaps { mh } else { mw })
            .map_or(1.0, |pw| pw as f64 / w.max(1) as f64);
        Some(OutputInfo { name: self.name.clone(), x, y, width: w as u32, height: h as u32, scale })
    }
}

struct Shm {
    ptr: *mut std::ffi::c_void,
    len: usize,
}

// The mapping is only touched on the Wayland thread; it's made before the state moves there.
unsafe impl Send for Shm {}

impl Drop for Shm {
    fn drop(&mut self) {
        unsafe {
            let _ = rustix::mm::munmap(self.ptr, self.len);
        }
    }
}

struct Capture {
    reply: Option<Reply<Frame>>,
    format: Option<(wl_shm::Format, u32, u32, u32)>,
    buffer: Option<(WlBuffer, WlShmPool, Shm)>,
    y_invert: bool,
}

/// What the agent's own clipboard offer holds, and who to tell once it's been read.
struct Source {
    clip: Arc<Clip>,
    served: Mutex<Option<oneshot::Sender<()>>>,
}

struct State {
    conn: Connection,
    qh: QueueHandle<State>,
    start: Instant,
    events: mpsc::UnboundedSender<SessionEvent>,
    shm: Option<WlShm>,
    seat: Option<WlSeat>,
    xdg: Option<ZxdgOutputManagerV1>,
    screencopy: Option<ZwlrScreencopyManagerV1>,
    pointer_manager: Option<ZwlrVirtualPointerManagerV1>,
    idle: Option<ExtIdleNotifierV1>,
    data_control: Option<ZwlrDataControlManagerV1>,
    outputs: Vec<Out>,
    pointers: HashMap<String, ZwlrVirtualPointerV1>,
    last_pointer: Option<String>,
    keyboard: Option<WlKeyboard>,
    keymap: Option<String>,
    device: Option<ZwlrDataControlDeviceV1>,
    /// Offers being described, by object, with the types they offer.
    offers: HashMap<wayland_client::backend::ObjectId, Vec<String>>,
    selection: Option<(ZwlrDataControlOfferV1, Vec<String>)>,
    captures: HashMap<wayland_client::backend::ObjectId, Capture>,
}

impl State {
    fn time(&self) -> u32 {
        self.start.elapsed().as_millis() as u32
    }

    fn add_output(&mut self, registry: &WlRegistry, global: u32, version: u32) {
        let output = registry.bind::<WlOutput, _, State>(global, version.min(4), &self.qh, ());
        if let Some(xdg) = &self.xdg {
            xdg.get_xdg_output(&output, &self.qh, output.clone());
        }
        self.outputs.push(Out {
            global,
            output,
            name: String::new(),
            logical: None,
            mode: None,
            transform_swaps: false,
        });
    }

    fn out_mut(&mut self, output: &WlOutput) -> Option<&mut Out> {
        self.outputs.iter_mut().find(|o| &o.output == output)
    }

    fn command(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Outputs(reply) => {
                let _ = reply.send(self.outputs.iter().filter_map(Out::info).collect());
            }
            Cmd::Capture { output, reply } => self.capture(output, reply),
            Cmd::Motion { output, x, y, reply } => {
                let _ = reply.send(self.motion(&output, x, y));
            }
            Cmd::Button { button, down, reply } => {
                let r = self.pointer(None).map(|p| {
                    let code = match button {
                        Button::Left => 0x110,
                        Button::Right => 0x111,
                        Button::Middle => 0x112,
                    };
                    let state = if down { wl_pointer::ButtonState::Pressed } else { wl_pointer::ButtonState::Released };
                    p.button(self.time(), code, state);
                    p.frame();
                });
                let _ = reply.send(r.and_then(|_| self.flush()));
            }
            Cmd::Wheel { dx, dy, reply } => {
                let t = self.time();
                let r = self.pointer(None).map(|p| {
                    p.axis_source(wl_pointer::AxisSource::Wheel);
                    for (axis, n) in [(wl_pointer::Axis::VerticalScroll, dy), (wl_pointer::Axis::HorizontalScroll, dx)]
                    {
                        if n != 0 {
                            p.axis_discrete(t, axis, 15.0 * n as f64, n);
                        }
                    }
                    p.frame();
                });
                let _ = reply.send(r.and_then(|_| self.flush()));
            }
            Cmd::Keymap(reply) => {
                let _ = reply.send(self.keymap.clone());
            }
            Cmd::Clipboard(reply) => {
                let _ = reply.send(self.read_selection());
            }
            Cmd::SetClipboard { clip, reply } => {
                let _ = reply.send(self.set_selection(clip));
            }
        }
    }

    fn flush(&self) -> Result<()> {
        self.conn.flush().map_err(|e| format!("Wayland: {e}."))
    }

    /// The virtual pointer for a monitor (made the first time), or the one used last.
    fn pointer(&mut self, output: Option<&str>) -> Result<ZwlrVirtualPointerV1> {
        let (Some(manager), Some(seat)) = (&self.pointer_manager, &self.seat) else {
            return Err("This compositor has no virtual pointer.".into());
        };
        let name = match output.map(str::to_owned).or_else(|| self.last_pointer.clone()) {
            Some(n) => n,
            None => self.outputs.first().map(|o| o.name.clone()).ok_or("There's no monitor.")?,
        };
        if let Some(p) = self.pointers.get(&name) {
            return Ok(p.clone());
        }
        let out = self.outputs.iter().find(|o| o.name == name).map(|o| o.output.clone());
        let p = match out {
            Some(o) if manager.version() >= 2 => {
                manager.create_virtual_pointer_with_output(Some(seat), Some(&o), &self.qh, ())
            }
            _ => manager.create_virtual_pointer(Some(seat), &self.qh, ()),
        };
        self.pointers.insert(name, p.clone());
        Ok(p)
    }

    fn motion(&mut self, output: &str, x: f64, y: f64) -> Result<()> {
        let infos: Vec<OutputInfo> = self.outputs.iter().filter_map(Out::info).collect();
        let info = infos.iter().find(|o| o.name == output).ok_or("That monitor has gone.")?;
        let bound = self.pointer_manager.as_ref().is_some_and(|m| m.version() >= 2);
        let p = self.pointer(Some(output))?;
        self.last_pointer = Some(output.to_owned());
        // A hundredth of a pixel, so scaled monitors get their in-between positions.
        let (px, py, w, h) = if bound {
            (x, y, info.width as f64, info.height as f64)
        } else {
            // A pointer not tied to a monitor spans all of them.
            let x0 = infos.iter().map(|o| o.x).min().unwrap_or(0);
            let y0 = infos.iter().map(|o| o.y).min().unwrap_or(0);
            let x1 = infos.iter().map(|o| o.x + o.width as i32).max().unwrap_or(1);
            let y1 = infos.iter().map(|o| o.y + o.height as i32).max().unwrap_or(1);
            (x + (info.x - x0) as f64, y + (info.y - y0) as f64, (x1 - x0) as f64, (y1 - y0) as f64)
        };
        p.motion_absolute(
            self.time(),
            (px * 100.0).round().max(0.0) as u32,
            (py * 100.0).round().max(0.0) as u32,
            (w * 100.0) as u32,
            (h * 100.0) as u32,
        );
        p.frame();
        self.flush()
    }

    fn capture(&mut self, output: String, reply: Reply<Frame>) {
        let (Some(sc), Some(o)) = (&self.screencopy, self.outputs.iter().find(|o| o.name == output)) else {
            let _ = reply.send(Err("Can't capture that monitor.".into()));
            return;
        };
        let frame = sc.capture_output(1, &o.output, &self.qh, ());
        self.captures.insert(frame.id(), Capture { reply: Some(reply), format: None, buffer: None, y_invert: false });
        let _ = self.flush();
    }

    fn copy(&mut self, frame: &ZwlrScreencopyFrameV1) {
        let Some(shm) = self.shm.clone() else { return };
        let qh = self.qh.clone();
        let Some(c) = self.captures.get_mut(&frame.id()) else { return };
        let Some((format, w, h, stride)) = c.format else {
            if let Some(r) = c.reply.take() {
                let _ = r.send(Err("The compositor offered no pixel format Hatbot reads.".into()));
            }
            frame.destroy();
            return;
        };
        let len = (stride * h) as usize;
        let made = (|| -> std::io::Result<(OwnedFd, Shm)> {
            let fd = rustix::fs::memfd_create("hatbot-capture", rustix::fs::MemfdFlags::CLOEXEC)?;
            rustix::fs::ftruncate(&fd, len as u64)?;
            let ptr = unsafe {
                rustix::mm::mmap(
                    std::ptr::null_mut(),
                    len,
                    rustix::mm::ProtFlags::READ | rustix::mm::ProtFlags::WRITE,
                    rustix::mm::MapFlags::SHARED,
                    &fd,
                    0,
                )?
            };
            Ok((fd, Shm { ptr, len }))
        })();
        let (fd, mem) = match made {
            Ok(m) => m,
            Err(e) => {
                if let Some(r) = c.reply.take() {
                    let _ = r.send(Err(format!("Can't make a buffer for the capture: {e}.")));
                }
                return;
            }
        };
        let pool = shm.create_pool(fd.as_fd(), len as i32, &qh, ());
        let buffer = pool.create_buffer(0, w as i32, h as i32, stride as i32, format, &qh, ());
        frame.copy(&buffer);
        c.buffer = Some((buffer, pool, mem));
        let _ = self.flush();
    }

    fn read_selection(&mut self) -> Result<Vec<(String, OwnedFd)>> {
        let Some((offer, mimes)) = &self.selection else { return Ok(vec![]) };
        let mut out = Vec::new();
        let mut keep = Vec::new();
        for mime in mimes.iter().filter(|m| *m != "SAVE_TARGETS").take(12) {
            let (read, write) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC)
                .map_err(|e| format!("Can't read the clipboard: {e}."))?;
            offer.receive(mime.clone(), write.as_fd());
            keep.push(write);
            out.push((mime.clone(), read));
        }
        // The write ends go out with the requests; ours close after.
        self.flush()?;
        drop(keep);
        Ok(out)
    }

    fn set_selection(&mut self, clip: Option<Clip>) -> Result<oneshot::Receiver<()>> {
        let (Some(dc), Some(device)) = (&self.data_control, &self.device) else {
            return Err("This compositor doesn't let Hatbot use the clipboard.".into());
        };
        let (tx, rx) = oneshot::channel();
        match clip {
            Some(clip) if !clip.0.is_empty() => {
                let data = Arc::new(Source { clip: Arc::new(clip), served: Mutex::new(Some(tx)) });
                let source = dc.create_data_source(&self.qh, data.clone());
                for (mime, _) in &data.clip.0 {
                    source.offer(mime.clone());
                }
                device.set_selection(Some(&source));
            }
            _ => device.set_selection(None),
        }
        self.flush()?;
        Ok(rx)
    }
}

impl Dispatch<WlRegistry, GlobalListContents> for State {
    fn event(
        state: &mut Self,
        registry: &WlRegistry,
        event: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wl_registry::Event::Global { name, interface, version } if interface == WlOutput::interface().name => {
                state.add_output(registry, name, version);
            }
            wl_registry::Event::GlobalRemove { name } => {
                state.outputs.retain(|o| o.global != name);
            }
            _ => {}
        }
    }
}

impl Dispatch<WlOutput, ()> for State {
    fn event(
        state: &mut Self,
        output: &WlOutput,
        event: wl_output::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(o) = state.out_mut(output) else { return };
        match event {
            wl_output::Event::Name { name } => o.name = name,
            wl_output::Event::Mode { flags: WEnum::Value(f), width, height, .. }
                if f.contains(wl_output::Mode::Current) =>
            {
                o.mode = Some((width, height));
            }
            wl_output::Event::Geometry { transform: WEnum::Value(t), .. } => {
                use wl_output::Transform as T;
                o.transform_swaps = matches!(t, T::_90 | T::_270 | T::Flipped90 | T::Flipped270);
            }
            _ => {}
        }
    }
}

impl Dispatch<ZxdgOutputV1, WlOutput> for State {
    fn event(
        state: &mut Self,
        _: &ZxdgOutputV1,
        event: zxdg_output_v1::Event,
        output: &WlOutput,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(o) = state.out_mut(output) else { return };
        let (x, y, w, h) = o.logical.unwrap_or_default();
        match event {
            zxdg_output_v1::Event::LogicalPosition { x, y } => o.logical = Some((x, y, w, h)),
            zxdg_output_v1::Event::LogicalSize { width, height } => o.logical = Some((x, y, width, height)),
            // Old wl_outputs have no name of their own.
            zxdg_output_v1::Event::Name { name } if o.name.is_empty() => o.name = name,
            _ => {}
        }
    }
}

impl Dispatch<WlSeat, ()> for State {
    fn event(state: &mut Self, seat: &WlSeat, event: wl_seat::Event, _: &(), _: &Connection, qh: &QueueHandle<Self>) {
        if let wl_seat::Event::Capabilities { capabilities: WEnum::Value(c) } = event
            && c.contains(wl_seat::Capability::Keyboard)
            && state.keyboard.is_none()
        {
            state.keyboard = Some(seat.get_keyboard(qh, ()));
        }
    }
}

impl Dispatch<WlKeyboard, ()> for State {
    fn event(
        state: &mut Self,
        _: &WlKeyboard,
        event: wl_keyboard::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_keyboard::Event::Keymap { format: WEnum::Value(wl_keyboard::KeymapFormat::XkbV1), fd, size } = event {
            let map = unsafe {
                rustix::mm::mmap(
                    std::ptr::null_mut(),
                    size as usize,
                    rustix::mm::ProtFlags::READ,
                    rustix::mm::MapFlags::PRIVATE,
                    &fd,
                    0,
                )
            };
            if let Ok(ptr) = map {
                let bytes = unsafe { std::slice::from_raw_parts(ptr as *const u8, size as usize) };
                let text = String::from_utf8_lossy(bytes).trim_end_matches('\0').to_owned();
                unsafe {
                    let _ = rustix::mm::munmap(ptr, size as usize);
                }
                state.keymap = Some(text);
            }
        }
    }
}

impl Dispatch<ZwlrScreencopyFrameV1, ()> for State {
    fn event(
        state: &mut Self,
        frame: &ZwlrScreencopyFrameV1,
        event: zwlr_screencopy_frame_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        use zwlr_screencopy_frame_v1::Event;
        let id = frame.id();
        match event {
            Event::Buffer { format: WEnum::Value(f), width, height, stride } => {
                let readable = matches!(
                    f,
                    wl_shm::Format::Argb8888
                        | wl_shm::Format::Xrgb8888
                        | wl_shm::Format::Abgr8888
                        | wl_shm::Format::Xbgr8888
                );
                if let Some(c) = state.captures.get_mut(&id)
                    && readable
                    && c.format.is_none()
                {
                    c.format = Some((f, width, height, stride));
                }
                // Before version 3 there's no buffer_done: the one shm buffer is all there is.
                if frame.version() < 3 {
                    state.copy(frame);
                }
            }
            Event::BufferDone => state.copy(frame),
            Event::Flags { flags: WEnum::Value(f) } => {
                if let Some(c) = state.captures.get_mut(&id) {
                    c.y_invert = f.contains(zwlr_screencopy_frame_v1::Flags::YInvert);
                }
            }
            Event::Ready { .. } => {
                if let Some(mut c) = state.captures.remove(&id) {
                    let pixels = read_pixels(&c);
                    if let Some(r) = c.reply.take() {
                        let _ = r.send(pixels);
                    }
                    if let Some((buffer, pool, _)) = c.buffer.take() {
                        buffer.destroy();
                        pool.destroy();
                    }
                }
                frame.destroy();
            }
            Event::Failed => {
                if let Some(mut c) = state.captures.remove(&id) {
                    if let Some(r) = c.reply.take() {
                        let _ = r.send(Err("The compositor couldn't capture the screen.".into()));
                    }
                    if let Some((buffer, pool, _)) = c.buffer.take() {
                        buffer.destroy();
                        pool.destroy();
                    }
                }
                frame.destroy();
            }
            _ => {}
        }
    }
}

fn read_pixels(c: &Capture) -> Result<Frame> {
    let (Some((format, w, h, stride)), Some((_, _, mem))) = (c.format, &c.buffer) else {
        return Err("The capture came back empty.".into());
    };
    let bytes = unsafe { std::slice::from_raw_parts(mem.ptr as *const u8, mem.len) };
    let bgr = matches!(format, wl_shm::Format::Argb8888 | wl_shm::Format::Xrgb8888);
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for row in 0..h {
        let src = if c.y_invert { h - 1 - row } else { row };
        let line = &bytes[(src * stride) as usize..(src * stride + w * 4) as usize];
        for px in line.as_chunks::<4>().0 {
            if bgr {
                rgb.extend_from_slice(&[px[2], px[1], px[0]]);
            } else {
                rgb.extend_from_slice(&px[..3]);
            }
        }
    }
    Ok(Frame { width: w, height: h, rgb })
}

impl Dispatch<ExtIdleNotificationV1, Idle> for State {
    fn event(
        state: &mut Self,
        _: &ExtIdleNotificationV1,
        event: ext_idle_notification_v1::Event,
        kind: &Idle,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let ev = match (kind, event) {
            (Idle::Notice, ext_idle_notification_v1::Event::Resumed) => SessionEvent::Resumed,
            (Idle::Quiet, ext_idle_notification_v1::Event::Idled) => SessionEvent::Quiet,
            _ => return,
        };
        let _ = state.events.send(ev);
    }
}

impl Dispatch<ZwlrDataControlDeviceV1, ()> for State {
    fn event(
        state: &mut Self,
        _: &ZwlrDataControlDeviceV1,
        event: zwlr_data_control_device_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        use zwlr_data_control_device_v1::Event;
        match event {
            Event::DataOffer { id } => {
                state.offers.insert(id.id(), Vec::new());
            }
            Event::Selection { id } => {
                if let Some((old, _)) = state.selection.take() {
                    old.destroy();
                }
                state.selection = id.map(|offer| {
                    let mimes = state.offers.remove(&offer.id()).unwrap_or_default();
                    (offer, mimes)
                });
            }
            Event::PrimarySelection { id: Some(offer) } => {
                state.offers.remove(&offer.id());
                offer.destroy();
            }
            Event::Finished => state.device = None,
            _ => {}
        }
    }

    event_created_child!(State, ZwlrDataControlDeviceV1, [
        zwlr_data_control_device_v1::EVT_DATA_OFFER_OPCODE => (ZwlrDataControlOfferV1, ()),
    ]);
}

impl Dispatch<ZwlrDataControlOfferV1, ()> for State {
    fn event(
        state: &mut Self,
        offer: &ZwlrDataControlOfferV1,
        event: zwlr_data_control_offer_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let zwlr_data_control_offer_v1::Event::Offer { mime_type } = event
            && let Some(m) = state.offers.get_mut(&offer.id())
        {
            m.push(mime_type);
        }
    }
}

impl Dispatch<ZwlrDataControlSourceV1, Arc<Source>> for State {
    fn event(
        _: &mut Self,
        source: &ZwlrDataControlSourceV1,
        event: zwlr_data_control_source_v1::Event,
        data: &Arc<Source>,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            zwlr_data_control_source_v1::Event::Send { mime_type, fd } => {
                let data = data.clone();
                // A slow reader mustn't hold up the Wayland thread.
                std::thread::spawn(move || {
                    let bytes = data
                        .clip
                        .0
                        .iter()
                        .find(|(m, _)| *m == mime_type)
                        .map(|(_, b)| b.as_slice())
                        .unwrap_or_default();
                    let _ = std::fs::File::from(fd).write_all(bytes);
                    if let Some(tx) = data.served.lock().expect("served lock").take() {
                        let _ = tx.send(());
                    }
                });
            }
            zwlr_data_control_source_v1::Event::Cancelled => source.destroy(),
            _ => {}
        }
    }
}

delegate_noop!(State: ignore WlShm);
delegate_noop!(State: WlShmPool);
delegate_noop!(State: ignore WlBuffer);
delegate_noop!(State: ZxdgOutputManagerV1);
delegate_noop!(State: ZwlrScreencopyManagerV1);
delegate_noop!(State: ZwlrVirtualPointerManagerV1);
delegate_noop!(State: ZwlrVirtualPointerV1);
delegate_noop!(State: ExtIdleNotifierV1);
delegate_noop!(State: ZwlrDataControlManagerV1);
