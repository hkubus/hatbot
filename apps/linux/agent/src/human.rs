//! Input timed and shaped like a person's, as desktop-agent's human.ts: the pointer travels a slight
//! curve, speeding up and slowing down, and keys come at an uneven pace.

use rand::Rng;

fn ease_in_out(t: f64) -> f64 {
    if t < 0.5 { 2.0 * t * t } else { 1.0 - (-2.0 * t + 2.0).powi(2) / 2.0 }
}

/// The points between `from` and `to`, ending exactly on `to`; none when they're the same.
pub fn path(from: (f64, f64), to: (f64, f64)) -> Vec<(f64, f64)> {
    let mut rng = rand::rng();
    let (dx, dy) = (to.0 - from.0, to.1 - from.1);
    let dist = dx.hypot(dy);
    if dist < 1.0 {
        return vec![];
    }
    let steps = (dist / 25.0).round().clamp(4.0, 30.0) as usize;
    // Two control points pushed off the straight line to one side, so the path bows.
    let side = if rng.random_bool(0.5) { -1.0 } else { 1.0 };
    let bow = side * dist * (0.05 + rng.random::<f64>() * 0.15);
    let (nx, ny) = (-dy / dist, dx / dist);
    let c1 = (from.0 + dx * 0.3 + nx * bow, from.1 + dy * 0.3 + ny * bow);
    let c2 = (from.0 + dx * 0.7 + nx * bow * 0.6, from.1 + dy * 0.7 + ny * bow * 0.6);
    let mut out: Vec<(f64, f64)> = Vec::with_capacity(steps);
    for i in 1..steps {
        let t = ease_in_out(i as f64 / steps as f64);
        let u = 1.0 - t;
        let bez =
            |a: f64, b: f64, c: f64, d: f64| u.powi(3) * a + 3.0 * u * u * t * b + 3.0 * u * t * t * c + t.powi(3) * d;
        let p = (bez(from.0, c1.0, c2.0, to.0).round(), bez(from.1, c1.1, c2.1, to.1).round());
        if out.last() != Some(&p) {
            out.push(p);
        }
    }
    out.push((to.0.round(), to.1.round()));
    out
}

pub fn between(min: u64, max: u64) -> u64 {
    rand::rng().random_range(min..=max)
}

/// The gap before the next key: mostly quick, now and then a pause as if thinking.
pub fn key_gap() -> u64 {
    if rand::rng().random_bool(0.05) { between(180, 400) } else { between(35, 110) }
}
