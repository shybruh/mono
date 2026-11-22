fn main() {
    println!("cargo:rerun-if-changed=vendor/mono_stretch.cpp");
    println!("cargo:rerun-if-changed=vendor/signalsmith");

    cc::Build::new()
        .cpp(true)
        .std("c++14")
        .file("vendor/mono_stretch.cpp")
        .include("vendor/signalsmith")
        .opt_level(3)
        .warnings(false)
        .compile("mono_stretch");

    tauri_build::build()
}
