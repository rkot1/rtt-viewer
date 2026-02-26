#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri::menu::{MenuBuilder, SubmenuBuilder};

static SEQ: AtomicU64 = AtomicU64::new(0);

struct AppState {
    stop_flag: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
struct ElfInfo {
    rtt_address: String,
    chip_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct LogEntry {
    id: u64,
    device_timestamp: Option<String>,
    level: String,
    tag: Option<String>,
    terminal: Option<u8>,
    message: String,
    raw: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Profile {
    name: String,
    chip: String,
    /// Hex address like "0x20031010"
    rtt_address: Option<String>,
    /// Path to ELF for symbol lookup
    elf_path: Option<String>,
    /// Core index (0 = app core, 1 = net core on nRF5340)
    core: Option<usize>,
}

#[tauri::command]
async fn list_probes() -> Result<Vec<ProbeInfo>, String> {
    let lister = probe_rs::probe::list::Lister::new();
    let probes = lister.list_all();
    Ok(probes
        .iter()
        .enumerate()
        .map(|(i, p)| ProbeInfo {
            index: i,
            name: p.identifier.clone(),
            serial: p.serial_number.clone(),
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
struct ProbeInfo {
    index: usize,
    name: String,
    serial: Option<String>,
}

// Initialize the probe lister

use std::sync::OnceLock;

struct SendLister(probe_rs::probe::list::Lister);
unsafe impl Send for SendLister {}
unsafe impl Sync for SendLister {}

static LISTER: OnceLock<SendLister> = OnceLock::new();

fn get_lister() -> &'static probe_rs::probe::list::Lister {
    &LISTER
        .get_or_init(|| SendLister(probe_rs::probe::list::Lister::new()))
        .0
}

fn parse_line(raw: &str) -> LogEntry {
    let clean = raw.trim();

    let zephyr_re =
        Regex::new(r"^\[(\d{2}:\d{2}:\d{2}\.\d{3}(?:,\d{3})?)\]\s*<(\w+)>\s*([\w._-]+):\s*(.*)$")
            .unwrap();

    if let Some(caps) = zephyr_re.captures(clean) {
        return LogEntry {
            id: SEQ.fetch_add(1, Ordering::Relaxed),
            device_timestamp: Some(caps[1].to_string()),
            level: normalize_level(&caps[2]),
            tag: Some(caps[3].to_string()),
            terminal: None,
            message: caps[4].to_string(),
            raw: clean.to_string(),
        };
    }

    let generic_re = Regex::new(r"^\[([^\]]+)\]\s*<(\w+)>\s*(.*)$").unwrap();
    if let Some(caps) = generic_re.captures(clean) {
        return LogEntry {
            id: SEQ.fetch_add(1, Ordering::Relaxed),
            device_timestamp: None,
            level: normalize_level(&caps[2]),
            tag: Some(caps[1].to_string()),
            terminal: None,
            message: caps[3].to_string(),
            raw: clean.to_string(),
        };
    }

    LogEntry {
        id: SEQ.fetch_add(1, Ordering::Relaxed),
        device_timestamp: None,
        level: "raw".to_string(),
        tag: None,
        terminal: None,
        message: clean.to_string(),
        raw: clean.to_string(),
    }
}

fn normalize_level(s: &str) -> String {
    match s.to_lowercase().as_str() {
        "err" | "error" => "error",
        "wrn" | "warn" | "warning" => "warn",
        "inf" | "info" => "info",
        "dbg" | "debug" => "debug",
        _ => "info",
    }
    .to_string()
}

// ── Config ──

fn config_dir() -> std::path::PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("rtt-viewer")
}

fn load_profiles() -> Vec<Profile> {
    let path = config_dir().join("profiles.json");
    if let Ok(data) = std::fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        vec![]
    }
}

fn save_profiles_to_disk(profiles: &[Profile]) {
    let dir = config_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("profiles.json");
    if let Ok(json) = serde_json::to_string_pretty(profiles) {
        let _ = std::fs::write(path, json);
    }
}

// ── Tauri commands ──

#[tauri::command]
async fn get_profiles() -> Result<Vec<Profile>, String> {
    Ok(load_profiles())
}

#[tauri::command]
async fn save_profile(profile: Profile) -> Result<Vec<Profile>, String> {
    let mut profiles = load_profiles();
    if let Some(existing) = profiles.iter_mut().find(|p| p.name == profile.name) {
        *existing = profile;
    } else {
        profiles.push(profile);
    }
    save_profiles_to_disk(&profiles);
    Ok(profiles)
}

#[tauri::command]
async fn delete_profile(name: String) -> Result<Vec<Profile>, String> {
    let mut profiles = load_profiles();
    profiles.retain(|p| p.name != name);
    save_profiles_to_disk(&profiles);
    Ok(profiles)
}

#[tauri::command]
async fn stop_source(app: AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    state.stop_flag.store(true, Ordering::Relaxed);
    let _ = app.emit("rtt-stopped", ());
    Ok("Stopped".to_string())
}

fn emit_rtt_status(app: &AppHandle, level: &str, msg: &str) {
    let _ = app.emit(
        "rtt-log",
        &LogEntry {
            id: SEQ.fetch_add(1, Ordering::Relaxed),
            device_timestamp: None,
            level: level.to_string(),
            tag: Some("rtt".to_string()),
            terminal: None,
            message: msg.to_string(),
            raw: msg.to_string(),
        },
    );
}

// ── Parse RTT address from optional hex string ──

fn parse_scan_region(addr: &Option<String>) -> probe_rs::rtt::ScanRegion {
    match addr {
        Some(s) => {
            let addr = u64::from_str_radix(s.trim_start_matches("0x"), 16).unwrap_or(0);
            probe_rs::rtt::ScanRegion::Exact(addr)
        }
        None => probe_rs::rtt::ScanRegion::Ram,
    }
}

// ── Open probe + attach session + core ──

struct RttSession {
    rtt: probe_rs::rtt::Rtt,
    core: probe_rs::Core<'static>, // lifetime managed by caller
}

enum ConnectError {
    Retry(String), // transient — retry after delay
    Fatal(String), // permanent — stop trying
}

fn open_session(
    lister: &probe_rs::probe::list::Lister,
    chip: &str,
    core_idx: usize,
    app: &AppHandle,
) -> Result<(probe_rs::Session, usize), ConnectError> {
    emit_rtt_status(app, "info", "Searching for debug probe...");

    let probes = lister.list_all();
    if probes.is_empty() {
        return Err(ConnectError::Retry("No debug probe found".into()));
    }

    let probe = probes[0]
        .open()
        .map_err(|e| ConnectError::Retry(format!("Failed to open probe: {e}")))?;

    emit_rtt_status(app, "info", "Probe found. Attaching to target...");

    let target = probe_rs::config::get_target_by_name(chip)
        .map_err(|e| ConnectError::Fatal(format!("Unknown chip '{chip}': {e}")))?;

    let session = probe
        .attach(target, probe_rs::Permissions::default())
        .map_err(|e| ConnectError::Retry(format!("Cannot attach (device off?): {e}")))?;

    Ok((session, core_idx))
}

fn attach_rtt(
    session: &mut probe_rs::Session,
    core_idx: usize,
    scan_region: &probe_rs::rtt::ScanRegion,
    app: &AppHandle,
) -> Result<probe_rs::rtt::Rtt, ConnectError> {
    let mut core = session
        .core(core_idx)
        .map_err(|e| ConnectError::Retry(format!("Cannot access core {core_idx}: {e}")))?;

    emit_rtt_status(
        app,
        "info",
        "Target attached. Searching for RTT control block...",
    );

    let mut rtt = probe_rs::rtt::Rtt::attach_region(&mut core, scan_region)
        .map_err(|e| ConnectError::Retry(format!("RTT not found (fw not running?): {e}")))?;

    let ch_count = rtt.up_channels().len();
    emit_rtt_status(
        app,
        "info",
        &format!("RTT connected! {ch_count} up channel(s) found."),
    );
    let _ = app.emit("rtt-connected", ());

    Ok(rtt)
}

// ── Process raw RTT bytes into log entries ──

struct RttParser {
    line_buf: String,
    current_terminal: u8,
}

impl RttParser {
    fn new() -> Self {
        Self {
            line_buf: String::new(),
            current_terminal: 0,
        }
    }

    fn reset(&mut self) {
        self.line_buf.clear();
    }

    /// Parse raw RTT bytes, emit log entries. Returns Err if the app channel is closed.
    fn process_bytes(&mut self, buf: &[u8], count: usize, app: &AppHandle) -> Result<(), ()> {
        let mut i = 0;
        while i < count {
            match buf[i] {
                0xFF => {
                    i += 1;
                    if i < count && buf[i].is_ascii_digit() {
                        self.current_terminal = buf[i] - b'0';
                        i += 1;
                    }
                }
                0x1B => {
                    // Skip ANSI escape sequence
                    i += 1;
                    if i < count && buf[i] == b'[' {
                        i += 1;
                        while i < count && !buf[i].is_ascii_alphabetic() {
                            i += 1;
                        }
                        if i < count {
                            i += 1;
                        }
                    }
                }
                b'\n' => {
                    let line = self.line_buf.trim_end().to_string();
                    self.line_buf.clear();
                    i += 1;

                    if line.is_empty() {
                        continue;
                    }

                    let mut entry = parse_line(&line);
                    entry.terminal = Some(self.current_terminal);
                    if app.emit("rtt-log", &entry).is_err() {
                        return Err(());
                    }
                }
                b if b < 0x20 && b != b'\r' && b != b'\t' => {
                    i += 1;
                }
                _ => {
                    self.line_buf.push(buf[i] as char);
                    i += 1;
                }
            }
        }
        Ok(())
    }
}

// ── RTT read loop — returns when connection is lost or user stops ──

enum ReadResult {
    Disconnected, // connection lost, should reconnect
    Stopped,      // user requested stop
    AppClosed,    // webview gone
}

fn rtt_read_loop(
    rtt: &mut probe_rs::rtt::Rtt,
    core: &mut probe_rs::Core<'_>,
    parser: &mut RttParser,
    stop_flag: &Arc<AtomicBool>,
    app: &AppHandle,
) -> ReadResult {
    let mut buf = [0u8; 4096];
    let mut consecutive_errors = 0u32;

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            emit_rtt_status(app, "info", "Disconnected by user.");
            return ReadResult::Stopped;
        }

        let mut got_data = false;

        if let Some(ch) = rtt.up_channels().into_iter().next() {
            match ch.read(core, &mut buf) {
                Ok(count) if count > 0 => {
                    got_data = true;
                    consecutive_errors = 0;
                    if parser.process_bytes(&buf, count, app).is_err() {
                        return ReadResult::AppClosed;
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    consecutive_errors += 1;
                    if consecutive_errors >= 3 {
                        emit_rtt_status(
                            app,
                            "warn",
                            &format!("Lost connection: {e}. Reconnecting..."),
                        );
                        parser.reset();
                        return ReadResult::Disconnected;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
        }

        if !got_data {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}

// ── Main command ──

#[tauri::command]
async fn start_rtt(
    app: AppHandle,
    chip: String,
    rtt_address: Option<String>,
    core_index: Option<usize>,
    probe_index: Option<usize>,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    state.stop_flag.store(false, Ordering::Relaxed);
    let stop_flag = state.stop_flag.clone();
    let core_idx = core_index.unwrap_or(0);
    let probe_idx = probe_index.unwrap_or(0);

    // Enumerate on Tauri async thread — safe for macOS HID
    let lister = probe_rs::probe::list::Lister::new();
    let probes = lister.list_all();
    if probes.is_empty() {
        return Err("No debug probes found".to_string());
    }
    if probe_idx >= probes.len() {
        return Err(format!(
            "Probe index {probe_idx} out of range (found {})",
            probes.len()
        ));
    }
    let probe_info = probes[probe_idx].clone();
    drop(lister);

    let msg = format!("RTT connecting ({chip}, core {core_idx}, probe {probe_idx})...");

    std::thread::spawn(move || {
        let scan_region = parse_scan_region(&rtt_address);
        let mut parser = RttParser::new();

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }

            let probe = match probe_info.open() {
                Ok(p) => p,
                Err(e) => {
                    emit_rtt_status(
                        &app,
                        "warn",
                        &format!("Probe open failed: {e}. Retrying in 3s..."),
                    );
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    continue;
                }
            };

            let target = match probe_rs::config::get_target_by_name(&chip) {
                Ok(t) => t,
                Err(e) => {
                    emit_rtt_status(&app, "error", &format!("Unknown chip '{chip}': {e}"));
                    break;
                }
            };

            let mut session = match probe.attach(target, probe_rs::Permissions::default()) {
                Ok(s) => s,
                Err(e) => {
                    emit_rtt_status(
                        &app,
                        "warn",
                        &format!("Attach failed: {e}. Retrying in 3s..."),
                    );
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    continue;
                }
            };

            let mut rtt = match attach_rtt(&mut session, core_idx, &scan_region, &app) {
                Ok(r) => r,
                Err(ConnectError::Fatal(msg)) => {
                    emit_rtt_status(&app, "error", &msg);
                    break;
                }
                Err(ConnectError::Retry(msg)) => {
                    emit_rtt_status(&app, "warn", &format!("{msg}. Retrying in 3s..."));
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    continue;
                }
            };

            let mut core = match session.core(core_idx) {
                Ok(c) => c,
                Err(e) => {
                    emit_rtt_status(
                        &app,
                        "warn",
                        &format!("Core access failed: {e}. Retrying in 3s..."),
                    );
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    continue;
                }
            };

            match rtt_read_loop(&mut rtt, &mut core, &mut parser, &stop_flag, &app) {
                ReadResult::Stopped | ReadResult::AppClosed => {
                    let _ = app.emit("rtt-disconnected", ());
                    return;
                }
                ReadResult::Disconnected => {
                    emit_rtt_status(&app, "warn", "Disconnected. Reconnecting in 2s...");
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
            }
        }
        let _ = app.emit("rtt-disconnected", ());
    });

    Ok(msg)
}

#[tauri::command]
async fn start_mock(app: AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    state.stop_flag.store(false, Ordering::Relaxed);

    let stop_flag = state.stop_flag.clone();
    let app_clone = app.clone();

    let messages: Vec<(&'static str, &'static str, &'static str)> = vec![
        ("ble_mesh", "inf", "Mesh network initialized, node count: 5"),
        ("cellular", "inf", "Modem powered on"),
        ("gps", "inf", "Cold start, searching for satellites..."),
        ("main", "inf", "System boot, fw v2.4.1"),
        ("uwb", "dbg", "TWR ranging started with anchor 1"),
        ("battery", "inf", "Voltage: 3.8V (72%)"),
        ("plas", "inf", "PLAS engine started"),
        ("ble_mesh", "wrn", "Peer timeout: 0x1A3F"),
        ("cellular", "err", "Network registration failed"),
        ("gps", "inf", "Fix acquired: 8 satellites"),
        ("main", "dbg", "Heap: 42KB used / 128KB total"),
        ("uwb", "inf", "Distance to anchor 1: 4.2m"),
        ("ble_mesh", "inf", "Peer connected: 0xAB12"),
        ("cellular", "inf", "Signal: RSRP=-87 dBm"),
        ("plas", "wrn", "Worker approaching restricted area"),
        ("battery", "dbg", "Current draw: 34mA"),
    ];

    tokio::spawn(async move {
        let mut idx = 0u64;
        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
            let (tag, level, msg) = messages[(idx as usize) % messages.len()];
            let secs = idx * 250 / 1000;
            let ms = (idx * 250) % 1000;
            let raw = format!(
                "[00:{:02}:{:02}.{:03},000] <{level}> {tag}: {msg}",
                secs / 60,
                secs % 60,
                ms
            );
            let entry = parse_line(&raw);
            if app_clone.emit("rtt-log", &entry).is_err() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(150 + (idx % 7) * 50)).await;
            idx += 1;
        }
        let _ = app_clone.emit("rtt-stopped", ());
    });

    Ok("Mock started".to_string())
}

#[tauri::command]
async fn extract_rtt_address_from_elf(elf_path: String) -> Result<ElfInfo, String> {
    let data = std::fs::read(&elf_path).map_err(|e| format!("Failed to read ELF file: {e}"))?;

    let elf = goblin::elf::Elf::parse(&data).map_err(|e| format!("Failed to parse ELF: {e}"))?;

    // Find _SEGGER_RTT address
    let mut rtt_address = None;
    let mut symbols: Vec<(String, u64)> = Vec::new();

    for sym in &elf.syms {
        if let Some(name) = elf.strtab.get_at(sym.st_name) {
            if name == "_SEGGER_RTT" {
                rtt_address = Some(format!("0x{:08X}", sym.st_value));
            }
            symbols.push((name.to_string(), sym.st_value));
        }
    }

    let rtt_address = rtt_address.ok_or("_SEGGER_RTT symbol not found in ELF")?;

    // Detect chip from ELF metadata
    let chip_hint = detect_chip(&elf, &symbols).map(|s| s.replace("-", "_"));

    Ok(ElfInfo {
        rtt_address,
        chip_hint,
    })
}

fn detect_chip(elf: &goblin::elf::Elf, symbols: &[(String, u64)]) -> Option<String> {
    // Must be ARM
    if elf.header.e_machine != goblin::elf::header::EM_ARM {
        return None;
    }

    // Check entry point and symbol addresses to identify chip family
    let entry = elf.header.e_entry;

    // Look for known Zephyr/Nordic config symbols
    let has_symbol = |prefix: &str| symbols.iter().any(|(name, _)| name.contains(prefix));

    // nRF5340 detection
    if has_symbol("NRF5340") || has_symbol("nrf5340") {
        // Check if app or net core based on RAM address
        let ram_base = symbols
            .iter()
            .find(|(name, _)| name == "_SEGGER_RTT")
            .map(|(_, addr)| *addr)
            .unwrap_or(0);

        if ram_base >= 0x2100_0000 {
            return Some("nRF5340_xxAA".to_string()); // net core RAM starts at 0x21000000
        }
        return Some("nRF5340_xxAA".to_string());
    }

    // nRF52840
    if has_symbol("NRF52840") || has_symbol("nrf52840") {
        return Some("nRF52840_xxAA".to_string());
    }

    // nRF52833
    if has_symbol("NRF52833") || has_symbol("nrf52833") {
        return Some("nRF52833_xxAA".to_string());
    }

    // nRF52832
    if has_symbol("NRF52832") || has_symbol("nrf52832") {
        return Some("nRF52832_xxAA".to_string());
    }

    // nRF9160
    if has_symbol("NRF9160") || has_symbol("nrf9160") {
        return Some("nRF9160_xxAA".to_string());
    }

    // nRF91x1 (nRF9151/9161)
    if has_symbol("NRF9151")
        || has_symbol("nrf9151")
        || has_symbol("NRF91X1")
        || has_symbol("nrf91x1")
    {
        return Some("nRF9151_xxAA".to_string());
    }

    if has_symbol("NRF9161") || has_symbol("nrf9161") {
        return Some("nRF9161_xxAA".to_string());
    }

    // STM32 detection by RAM/flash ranges
    if has_symbol("STM32") || has_symbol("stm32") {
        return Some("STM32 (check exact variant)".to_string());
    }

    // ESP32 — won't be ARM, but just in case
    if has_symbol("ESP32") || has_symbol("esp32") {
        return Some("ESP32".to_string());
    }

    // Fallback: try to guess from memory map
    // nRF52 family has RAM at 0x20000000, flash at 0x00000000
    // nRF53 app core: RAM 0x20000000, flash 0x00000000
    // nRF53 net core: RAM 0x21000000, flash 0x01000000
    // nRF91: RAM 0x20000000, flash 0x00000000
    if entry < 0x0010_0000 {
        // Looks like nRF5x or nRF91 flash region
        let rtt_addr = symbols
            .iter()
            .find(|(name, _)| name == "_SEGGER_RTT")
            .map(|(_, addr)| *addr)
            .unwrap_or(0);

        if rtt_addr >= 0x2100_0000 {
            return Some("nRF5340_xxAA (net core?)".to_string());
        }
        if rtt_addr >= 0x2000_0000 {
            return Some("Nordic (nRF52/53/91 — check variant)".to_string());
        }
    }

    None
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{e}"))
}

#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, &contents).map_err(|e| format!("{e}"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            stop_flag: Arc::new(AtomicBool::new(false)),
        })
                .setup(|app| {
            let file_menu = SubmenuBuilder::new(app.handle(), "File")
                .text("import", "Import Logs…")
                .separator()
                .text("export_json", "Export as JSON…")
                .text("export_csv", "Export as CSV…")
                .text("export_txt", "Export as Text…")
                .separator()
                .quit()
                .build()?;

            let menu = MenuBuilder::new(app.handle())
                .item(&file_menu)
                .build()?;

            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu-event", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            start_rtt,
            start_mock,
            stop_source,
            list_probes,
            get_profiles,
            save_profile,
            delete_profile,
            extract_rtt_address_from_elf,
            read_text_file,
            write_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
