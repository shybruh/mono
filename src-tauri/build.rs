fn main() {
    println!("cargo:rerun-if-changed=vendor/mono_stretch.cpp");
    println!("cargo:rerun-if-changed=vendor/signalsmith");
    println!("cargo:rerun-if-changed=vendor/macos_display_stubs.c");

    cc::Build::new()
        .cpp(true)
        .std("c++14")
        .file("vendor/mono_stretch.cpp")
        .include("vendor/signalsmith")
        .opt_level(3)
        .warnings(false)
        .compile("mono_stretch");

    // macOS: link the display-function stubs as a plain object (not an
    // archive), so their definitions are always used instead of imports from
    // CoreGraphics. See vendor/macos_display_stubs.c.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let objects = cc::Build::new()
            .file("vendor/macos_display_stubs.c")
            .opt_level(2)
            .compile_intermediates();
        for o in objects {
            println!("cargo:rustc-link-arg={}", o.display());
        }
    }

    tauri_build::build()
}
