//! Engine registry: the download catalog, installing from GitHub releases,
//! importing a local binary, and checking that a binary really speaks UCI.

use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct EngineInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    /// "downloaded" or "imported"
    pub source: String,
    pub version: String,
}

#[derive(Clone, Serialize)]
pub struct CatalogEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub repo: &'static str,
    pub blurb: &'static str,
    /// (cpu architecture, substring of the release file name, required cpu flags joined by '+')
    #[serde(skip)]
    pub picks: &'static [(&'static str, &'static str, &'static str)],
}

pub fn catalog() -> Vec<CatalogEntry> {
    vec![
        CatalogEntry {
            id: "stockfish",
            name: "Stockfish",
            repo: "official-stockfish/Stockfish",
            blurb: "The strongest open-source engine. The best default for analysis.",
            picks: &[
                ("x86_64", "linux-x86-64-universal", ""),
                ("x86_64", "ubuntu-x86-64-avx2", "avx2"),
                ("x86_64", "ubuntu-x86-64-sse41-popcnt", "sse4_1+popcnt"),
                ("x86_64", "ubuntu-x86-64", ""),
                ("aarch64", "linux-arm64-universal", ""),
            ],
        },
        CatalogEntry {
            id: "patricia",
            name: "Patricia",
            repo: "Adam-Kulju/Patricia",
            blurb: "The most aggressive engine: built to attack and sacrifice rather than play safe.",
            picks: &[
                ("x86_64", "patricia_v3", "avx2+bmi2"),
                ("x86_64", "patricia_v2", "sse4_2+popcnt"),
            ],
        },
        CatalogEntry {
            id: "viridithas",
            name: "Viridithas",
            repo: "cosmobobak/viridithas",
            blurb: "Top-tier engine written in Rust with its own neural network.",
            picks: &[
                ("x86_64", "linux-x86-64-v3", "avx2+bmi2"),
                ("aarch64", "linux-aarch64-generic", ""),
            ],
        },
        CatalogEntry {
            id: "plentychess",
            name: "PlentyChess",
            repo: "Yoshie2000/PlentyChess",
            blurb: "Very strong engine, regularly near the top of the rating lists.",
            picks: &[
                ("x86_64", "linux-avx2", "avx2"),
                ("x86_64", "linux-ssse3", "ssse3"),
                ("x86_64", "linux-generic", ""),
                ("aarch64", "linux-neon", ""),
            ],
        },
        CatalogEntry {
            id: "stormphrax",
            name: "Stormphrax",
            repo: "Ciekce/Stormphrax",
            blurb: "Strong engine with a distinct, sharp evaluation style.",
            picks: &[("x86_64", "avx2-bmi2", "avx2+bmi2")],
        },
        CatalogEntry {
            id: "reckless",
            name: "Reckless",
            repo: "codedeliveryservice/Reckless",
            blurb: "Fast-improving Rust engine among the strongest available.",
            picks: &[
                ("x86_64", "linux-avx2", "avx2"),
                ("x86_64", "linux-generic", ""),
            ],
        },
    ]
}

fn cpu_flags() -> HashSet<String> {
    fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("flags") || l.starts_with("Features"))
                .map(|l| l.split(':').nth(1).unwrap_or("").split_whitespace().map(String::from).collect())
        })
        .unwrap_or_default()
}

fn is_elf(path: &Path) -> bool {
    let mut magic = [0u8; 4];
    fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut magic))
        .map(|_| magic == [0x7f, b'E', b'L', b'F'])
        .unwrap_or(false)
}

/// Largest ELF file under `dir` — the engine binary inside an unpacked archive.
fn find_binary(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(u64, PathBuf)> = None;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in fs::read_dir(&d).ok()?.flatten() {
            let p = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(p);
            } else if meta.is_file() && is_elf(&p) && best.as_ref().map_or(true, |(s, _)| meta.len() > *s) {
                best = Some((meta.len(), p));
            }
        }
    }
    best.map(|(_, p)| p)
}

/// Runs the binary, sends `uci`, and returns the name it reports.
pub fn probe_uci(path: &Path) -> Result<String, String> {
    let mut cmd = Command::new(path);
    if let Some(dir) = path.parent() {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("This file could not be run as a program: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let _ = stdin.write_all(b"uci\n");
    let _ = stdin.flush();

    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut name: Option<String> = None;
    let mut ok = false;
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(line) => {
                let line = line.trim();
                if let Some(n) = line.strip_prefix("id name ") {
                    name = Some(n.trim().to_string());
                } else if line == "uciok" {
                    ok = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let _ = stdin.write_all(b"quit\n");
    let _ = stdin.flush();
    std::thread::sleep(Duration::from_millis(50));
    let _ = child.kill();
    let _ = child.wait();

    if !ok {
        return Err("This program did not answer as a UCI chess engine.".into());
    }
    Ok(name.unwrap_or_else(|| {
        path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Engine".into())
    }))
}

/// Tag of the newest release of a GitHub repository.
fn latest_tag(repo: &str, user_agent: &str) -> Result<String, String> {
    let api = format!("https://api.github.com/repos/{repo}/releases/latest");
    let body = ureq::get(&api)
        .timeout(Duration::from_secs(20))
        .set("User-Agent", user_agent)
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(v["tag_name"].as_str().unwrap_or("").to_string())
}

pub struct Registry {
    dir: PathBuf,
}

impl Registry {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn file(&self) -> PathBuf {
        self.dir.join("engines.json")
    }

    /// Installed engines whose binary still exists on disk.
    pub fn list(&self) -> Result<Vec<EngineInfo>, String> {
        let all: Vec<EngineInfo> = match fs::read_to_string(self.file()) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        Ok(all.into_iter().filter(|e| Path::new(&e.path).is_file()).collect())
    }

    fn save(&self, list: &[EngineInfo]) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
        fs::write(self.file(), json).map_err(|e| e.to_string())
    }

    fn upsert(&self, info: EngineInfo) -> Result<EngineInfo, String> {
        let mut list = self.list()?;
        list.retain(|e| e.id != info.id);
        list.push(info.clone());
        self.save(&list)?;
        Ok(info)
    }

    /// Registers an engine binary that already exists on disk. It is used in place, not copied.
    pub fn add_path(&self, path: &Path) -> Result<EngineInfo, String> {
        let path = fs::canonicalize(path).map_err(|_| "That file does not exist.".to_string())?;
        if !path.is_file() {
            return Err("That is not a file.".into());
        }
        let mode = fs::metadata(&path).map_err(|e| e.to_string())?.permissions().mode();
        if mode & 0o111 == 0 {
            // A freshly downloaded engine usually lacks the executable bit.
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(mode | 0o755));
        }
        let name = probe_uci(&path)?;
        let p = path.to_string_lossy().into_owned();
        if let Some(existing) = self.list()?.into_iter().find(|e| e.path == p) {
            return Ok(existing);
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        self.upsert(EngineInfo {
            id: format!("imported-{stamp}"),
            name,
            path: p,
            source: "imported".into(),
            version: String::new(),
        })
    }

    /// Downloaded engines for which GitHub has a newer release: (engine id, newest tag).
    pub fn updates(&self, user_agent: &str) -> Result<Vec<(String, String)>, String> {
        let cat = catalog();
        let mut out = Vec::new();
        let (mut asked, mut failed) = (0, 0);
        for e in self.list()?.into_iter().filter(|e| e.source == "downloaded") {
            let Some(entry) = cat.iter().find(|c| c.id == e.id) else { continue };
            asked += 1;
            match latest_tag(entry.repo, user_agent) {
                Ok(tag) if !tag.is_empty() && tag != e.version => out.push((e.id, tag)),
                Ok(_) => {}
                Err(_) => failed += 1,
            }
        }
        if asked > 0 && failed == asked {
            return Err("Could not reach GitHub to check for updates.".into());
        }
        Ok(out)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut list = self.list()?;
        if let Some(e) = list.iter().find(|e| e.id == id) {
            if e.source == "downloaded" {
                let _ = fs::remove_dir_all(self.dir.join("engines").join(id));
            }
        }
        list.retain(|e| e.id != id);
        self.save(&list)
    }

    /// Downloads the newest release of a catalog engine that fits this CPU.
    pub fn install(
        &self,
        catalog_id: &str,
        user_agent: &str,
        progress: impl Fn(&str, u64, u64),
    ) -> Result<EngineInfo, String> {
        let entry = catalog()
            .into_iter()
            .find(|c| c.id == catalog_id)
            .ok_or("Unknown engine.")?;

        progress("lookup", 0, 0);
        let api = format!("https://api.github.com/repos/{}/releases/latest", entry.repo);
        let release: serde_json::Value = ureq::get(&api)
            .timeout(Duration::from_secs(30))
            .set("User-Agent", user_agent)
            .set("Accept", "application/vnd.github+json")
            .call()
            .map_err(|e| match e {
                ureq::Error::Status(403, _) | ureq::Error::Status(429, _) => {
                    "GitHub is limiting requests right now. Try again in a few minutes.".to_string()
                }
                other => format!("Could not reach GitHub: {other}"),
            })?
            .into_string()
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))?;
        let tag = release["tag_name"].as_str().unwrap_or("").to_string();
        let assets = release["assets"].as_array().cloned().unwrap_or_default();

        let flags = cpu_flags();
        let arch = std::env::consts::ARCH;
        let asset = entry
            .picks
            .iter()
            .filter(|(a, _, need)| *a == arch && need.split('+').all(|f| f.is_empty() || flags.contains(f)))
            .find_map(|(_, pat, _)| {
                assets.iter().find(|a| {
                    let n = a["name"].as_str().unwrap_or("").to_lowercase();
                    n.contains(pat) && !n.ends_with(".exe") && !n.contains("win") && !n.contains("mac")
                })
            })
            .ok_or_else(|| format!("{} has no ready-made Linux build for this processor.", entry.name))?;
        let file_name = asset["name"].as_str().unwrap_or("engine").to_string();
        let url = asset["browser_download_url"].as_str().ok_or("Release file has no download link.")?;
        let total = asset["size"].as_u64().unwrap_or(0);

        let engines_dir = self.dir.join("engines");
        let staging = engines_dir.join(format!("{catalog_id}.partial"));
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        let download = staging.join(&file_name);

        let result = (|| -> Result<PathBuf, String> {
            let resp = ureq::get(url)
                .set("User-Agent", user_agent)
                .call()
                .map_err(|e| format!("Download failed: {e}"))?;
            let mut reader = resp.into_reader();
            let mut out = fs::File::create(&download).map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 256 * 1024];
            let (mut received, mut last) = (0u64, Instant::now());
            loop {
                let n = reader.read(&mut buf).map_err(|e| format!("Download interrupted: {e}"))?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                received += n as u64;
                if last.elapsed() > Duration::from_millis(120) {
                    progress("download", received, total);
                    last = Instant::now();
                }
            }
            drop(out);
            progress("download", received, total.max(received));

            let lower = file_name.to_lowercase();
            if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") || lower.ends_with(".tar") {
                progress("unpack", 0, 0);
                let f = fs::File::open(&download).map_err(|e| e.to_string())?;
                let res = if lower.ends_with(".tar") {
                    tar::Archive::new(f).unpack(&staging)
                } else {
                    tar::Archive::new(flate2::read::GzDecoder::new(f)).unpack(&staging)
                };
                res.map_err(|e| format!("Could not unpack the download: {e}"))?;
                let _ = fs::remove_file(&download);
            }
            let bin = find_binary(&staging).ok_or("The download did not contain an engine program.")?;
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
            Ok(bin)
        })();
        let bin = match result {
            Ok(b) => b,
            Err(e) => {
                let _ = fs::remove_dir_all(&staging);
                return Err(e);
            }
        };

        progress("verify", 0, 0);
        let name = match probe_uci(&bin) {
            Ok(n) => n,
            Err(e) => {
                let _ = fs::remove_dir_all(&staging);
                return Err(e);
            }
        };

        let final_dir = engines_dir.join(catalog_id);
        let _ = fs::remove_dir_all(&final_dir);
        fs::rename(&staging, &final_dir).map_err(|e| e.to_string())?;
        let rel = bin.strip_prefix(&staging).map_err(|e| e.to_string())?;
        let info = EngineInfo {
            id: catalog_id.to_string(),
            name,
            path: final_dir.join(rel).to_string_lossy().into_owned(),
            source: "downloaded".into(),
            version: tag,
        };
        progress("done", 0, 0);
        self.upsert(info)
    }
}
