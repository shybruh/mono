fn main() {
    println!("cargo:rerun-if-changed=vendor/mono_stretch.cpp");
    println!("cargo:rerun-if-changed=vendor/signalsmith");
    println!("cargo:rerun-if-changed=vendor/macos_display_stubs.c");

    let mut stretch = cc::Build::new();
    stretch
        .cpp(true)
        .std("c++14")
        .file("vendor/mono_stretch.cpp")
        .include("vendor/signalsmith")
        .opt_level(3)
        .warnings(false);
    // Android: link the C++ runtime statically, so the APK doesn't need to
    // ship libc++_shared.so alongside the app.
    let android = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android");
    if android {
        stretch.cpp_link_stdlib("c++_static");
    }
    stretch.compile("mono_stretch");
    // The static runtime comes in two halves; libc++abi holds the exception
    // type info (e.g. std::length_error) that libc++_static refers to.
    if android {
        // Passed to the NDK's clang, which knows where its sysroot keeps it.
        println!("cargo:rustc-link-arg=-lc++abi");
    }

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
