// The commit this app is built from: a brain it sets up on this computer is fetched at the same one.
use std::process::Command;

fn main() {
    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let commit = std::env::var("HATBOT_COMMIT").ok().or_else(|| git(&["rev-parse", "HEAD"])).unwrap_or_default();
    println!("cargo:rustc-env=HATBOT_COMMIT={commit}");
    println!("cargo:rerun-if-env-changed=HATBOT_COMMIT");
    if let Some(dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        println!("cargo:rerun-if-changed={dir}/HEAD");
        if let Some(head) = git(&["symbolic-ref", "-q", "HEAD"]) {
            println!("cargo:rerun-if-changed={dir}/{head}");
        }
    }
}
