//! Screenshots are shrunk to the size the model works at, and its coordinates mapped back.

/// The desktop guest's screen: what the model is used to.
pub const MAX_WIDTH: u32 = 1280;
pub const MAX_HEIGHT: u32 = 800;

/// A screen's logical size against its screenshots'.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scaling {
    pub logical_width: u32,
    pub logical_height: u32,
    pub width: u32,
    pub height: u32,
}

impl Scaling {
    /// Fits the screen in the model's size, keeping its shape; a smaller screen stays as it is.
    pub fn new(logical_width: u32, logical_height: u32) -> Self {
        let lw = logical_width.max(1);
        let lh = logical_height.max(1);
        let f = (MAX_WIDTH as f64 / lw as f64).min(MAX_HEIGHT as f64 / lh as f64).min(1.0);
        Self {
            logical_width: lw,
            logical_height: lh,
            width: ((lw as f64 * f).round() as u32).max(1),
            height: ((lh as f64 * f).round() as u32).max(1),
        }
    }

    /// A screenshot point to the screen's logical pixels.
    pub fn logical(&self, x: f64, y: f64) -> (f64, f64) {
        (x * self.logical_width as f64 / self.width as f64, y * self.logical_height as f64 / self.height as f64)
    }

    /// A point on the screen to the screenshot's pixels.
    pub fn shot(&self, x: f64, y: f64) -> (f64, f64) {
        (x * self.width as f64 / self.logical_width as f64, y * self.height as f64 / self.logical_height as f64)
    }

    /// A screenshot point, checked to be on it.
    pub fn point(&self, x: f64, y: f64) -> Result<(f64, f64), String> {
        if !x.is_finite() || !y.is_finite() {
            return Err("coordinate must be [x, y].".into());
        }
        let (rx, ry) = (x.round(), y.round());
        if rx < 0.0 || ry < 0.0 || rx >= self.width as f64 || ry >= self.height as f64 {
            return Err(format!("({rx}, {ry}) is outside the {}x{} screen.", self.width, self.height));
        }
        Ok((rx, ry))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shrinks_to_the_models_size_and_maps_back() {
        let s = Scaling::new(2560, 1440);
        assert_eq!((s.width, s.height), (1280, 720));
        assert_eq!(s.logical(640.0, 360.0), (1280.0, 720.0));
        assert_eq!(s.shot(1280.0, 720.0), (640.0, 360.0));
        // An ultrawide is held by its width, a portrait screen by its height.
        let s = Scaling::new(3440, 1440);
        assert_eq!((s.width, s.height), (1280, 536));
        let s = Scaling::new(1080, 1920);
        assert_eq!((s.width, s.height), (450, 800));
        // A small screen isn't blown up.
        let s = Scaling::new(1024, 768);
        assert_eq!((s.width, s.height), (1024, 768));
    }

    #[test]
    fn refuses_points_off_the_screenshot() {
        let s = Scaling::new(2560, 1440);
        assert!(s.point(1279.0, 719.0).is_ok());
        assert!(s.point(1280.0, 10.0).is_err());
        assert!(s.point(-1.0, 10.0).is_err());
        assert!(s.point(f64::NAN, 10.0).is_err());
    }
}
