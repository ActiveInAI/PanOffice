//! PanOffice shell entry point (desktop). Mobile entry points live in lib.rs
//! per the Tauri v2 layout; we only ship desktop for now.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    panoffice_lib::run()
}
