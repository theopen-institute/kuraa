// The app's commands (src/bridge.rs), each with a permission of its own, which
// the capabilities (capabilities/) give to the pages they are for.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "open_folder",
        "join",
        "leave",
        "home",
        "choose_folder",
        "update_ready",
        "restart_to_update",
        "spelling",
        "learn_word",
        "updates_ready",
        "updates_choose",
        "updates_size",
        "closing_saved",
        "quit_now",
        "test_result",
    ])))
    .expect("the app's build");
}
