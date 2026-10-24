// Query the running kernel, without creating a ruleset or changing restrictions.
// Linux x86-64 and asm-generic (including aarch64) assign this syscall number 444.
// https://docs.kernel.org/userspace-api/landlock.html#landlock-abi-versions
use std::ffi::{c_long, c_void};

extern "C" {
    fn syscall(number: c_long, ...) -> c_long;
}

fn main() {
    if !cfg!(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))) {
        eprintln!("Landlock ABI probe does not support this architecture");
        std::process::exit(2);
    }
    // LANDLOCK_CREATE_RULESET_VERSION = 1, attr = NULL, size = 0.
    let abi = unsafe { syscall(444 as c_long, std::ptr::null::<c_void>(), 0usize, 1u32) };
    if abi < 1 {
        eprintln!("Landlock ABI query failed (errno {})", std::io::Error::last_os_error().raw_os_error().unwrap_or(0));
        std::process::exit(1);
    }
    println!("{abi}");
}
