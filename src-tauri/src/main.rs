#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engines;

use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use engines::{EngineInfo, Registry};

const USER_AGENT: &str = "Chesslens/0.1 (desktop chess analysis app)";

struct Running {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
struct EngineState {
    running: Mutex<Option<Running>>,
    generation: AtomicU64,
}

#[derive(Clone, Serialize)]
struct EngineLine {
    gen: u64,
    line: String,
}

fn registry(app: &AppHandle) -> Result<Registry, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(Registry::new(dir))
}

#[tauri::command]
fn catalog() -> Vec<engines::CatalogEntry> {
    engines::catalog()
}

#[tauri::command(async)]
fn list_engines(app: AppHandle) -> Result<Vec<EngineInfo>, String> {
    registry(&app)?.list()
}

#[tauri::command(async)]
fn install_engine(app: AppHandle, catalog_id: String) -> Result<EngineInfo, String> {
    let reg = registry(&app)?;
    let emitter = app.clone();
    let id = catalog_id.clone();
    reg.install(&catalog_id, USER_AGENT, move |stage, received, total| {
        let _ = emitter.emit(
            "install-progress",
            serde_json::json!({ "id": id, "stage": stage, "received": received, "total": total }),
        );
    })
}

#[tauri::command(async)]
fn import_engine(app: AppHandle) -> Result<Option<EngineInfo>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Choose a UCI chess engine")
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    registry(&app)?.add_path(&path).map(Some)
}

#[tauri::command(async)]
fn check_updates(app: AppHandle) -> Result<Vec<(String, String)>, String> {
    registry(&app)?.updates(USER_AGENT)
}

#[tauri::command(async)]
fn add_engine_path(app: AppHandle, path: String) -> Result<EngineInfo, String> {
    registry(&app)?.add_path(std::path::Path::new(path.trim()))
}

/// Asks where to save and writes the text there. Returns the chosen path, or None if cancelled.
#[tauri::command(async)]
fn save_text_file(app: AppHandle, name: String, contents: String) -> Result<Option<String>, String> {
    let picked = app.dialog().file().set_file_name(&name).blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, contents).map_err(|e| format!("Could not save the file: {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command(async)]
fn remove_engine(app: AppHandle, state: State<EngineState>, id: String) -> Result<(), String> {
    kill_running(&state);
    registry(&app)?.remove(&id)
}

fn kill_running(state: &EngineState) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    if let Some(mut r) = state.running.lock().unwrap().take() {
        let _ = r.stdin.write_all(b"quit\n");
        let _ = r.stdin.flush();
        std::thread::sleep(Duration::from_millis(60));
        let _ = r.child.kill();
        let _ = r.child.wait();
    }
}

/// Starts the engine process and streams every stdout line as an `engine-line` event.
#[tauri::command(async)]
fn engine_start(app: AppHandle, state: State<EngineState>, id: String) -> Result<u64, String> {
    kill_running(&state);
    let info = registry(&app)?
        .list()?
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| "That engine is no longer installed.".to_string())?;
    let path = std::path::PathBuf::from(&info.path);
    let mut cmd = Command::new(&path);
    if let Some(dir) = path.parent() {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", info.name))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    *state.running.lock().unwrap() = Some(Running { child, stdin });

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let _ = app.emit("engine-line", EngineLine { gen, line });
        }
        let _ = app.emit("engine-exit", gen);
    });
    Ok(gen)
}

#[tauri::command]
fn engine_send(state: State<EngineState>, line: String) -> Result<(), String> {
    let mut guard = state.running.lock().unwrap();
    let running = guard.as_mut().ok_or("The engine is not running.")?;
    running
        .stdin
        .write_all(format!("{line}\n").as_bytes())
        .and_then(|_| running.stdin.flush())
        .map_err(|e| format!("Lost connection to the engine: {e}"))
}

#[tauri::command(async)]
fn engine_stop(state: State<EngineState>) {
    kill_running(&state);
}

/// Fetches game lists. Only the chess.com and Lichess public APIs are allowed.
#[tauri::command(async)]
fn http_get(url: String, accept: Option<String>) -> Result<String, String> {
    const ALLOWED: [&str; 2] = ["https://api.chess.com/", "https://lichess.org/"];
    if !ALLOWED.iter().any(|p| url.starts_with(p)) {
        return Err("That address is not allowed.".into());
    }
    let mut req = ureq::get(&url)
        .timeout(Duration::from_secs(30))
        .set("User-Agent", USER_AGENT);
    if let Some(a) = accept {
        req = req.set("Accept", &a);
    }
    match req.call() {
        Ok(resp) => {
            let mut body = String::new();
            resp.into_reader()
                .take(64 * 1024 * 1024)
                .read_to_string(&mut body)
                .map_err(|e| e.to_string())?;
            Ok(body)
        }
        Err(ureq::Error::Status(404, _)) => Err("not-found".into()),
        Err(ureq::Error::Status(code, _)) => Err(format!("The server answered with status {code}.")),
        Err(e) => Err(format!("Network error: {e}")),
    }
}

#[tauri::command]
fn system_info() -> serde_json::Value {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    serde_json::json!({ "threads": threads, "args": std::env::args().skip(1).collect::<Vec<_>>() })
}

#[tauri::command]
fn log_line(line: String) {
    println!("{line}");
}

#[tauri::command]
fn quit(app: AppHandle, code: i32) {
    kill_running(&app.state::<EngineState>());
    app.exit(code);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineState::default())
        .setup(|app| {
            // `--test` runs the logic tests without ever showing the window.
            if !std::env::args().any(|a| a == "--test") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            catalog,
            list_engines,
            install_engine,
            import_engine,
            add_engine_path,
            check_updates,
            save_text_file,
            remove_engine,
            engine_start,
            engine_send,
            engine_stop,
            http_get,
            system_info,
            log_line,
            quit
        ])
        .build(tauri::generate_context!())
        .expect("error while building Chesslens")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                kill_running(&app.state::<EngineState>());
            }
        });
}
