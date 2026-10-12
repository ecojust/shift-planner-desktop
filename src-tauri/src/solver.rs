//! The desktop renderer can submit schedule data, never an executable or command line.
//! Development runs fixed project Python; installed apps run their bundled native runtime.
//! One solver process is launched per request and its whole tree is owned here.
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    process::{ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(test)]
use tokio::io::AsyncRead;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::watch,
};

const INPUT_LIMIT: usize = 2 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const STDERR_LIMIT: usize = 256 * 1024;
const ENGINE: &str = "ortools-cp-sat";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct JobDirectory(PathBuf);

impl JobDirectory {
    fn create(root: &std::path::Path) -> Result<Self, String> {
        std::fs::create_dir_all(root).map_err(|_| "无法创建本地求解缓存目录。")?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        for _ in 0..32 {
            // Never interpolate a caller-provided request ID or path into the file system.
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = root.join(format!("job-{}-{timestamp}-{sequence}", std::process::id()));
            match std::fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("无法创建本地求解临时目录。".into()),
            }
        }
        Err("无法分配本地求解临时目录。".into())
    }
}

impl Drop for JobDirectory {
    fn drop(&mut self) {
        // All solver scratch files stay in this owned per-request directory.
        // This guard outlives supervise(), so the process tree has stopped before deletion.
        // Failure to clean temporary files must never discard a valid solver result.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone, Default)]
pub struct SolverRuntime {
    active: Arc<Mutex<Option<RunningJob>>>,
    pub closing: Arc<AtomicBool>,
    info: Arc<Mutex<Option<Value>>>,
}

struct RunningJob {
    id: String,
    cancel: watch::Sender<bool>,
    done: watch::Receiver<bool>,
    pid: Arc<AtomicU32>,
}

struct JobGuard {
    runtime: SolverRuntime,
    id: String,
    done: watch::Sender<bool>,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.runtime.active.lock() {
            if active.as_ref().map(|job| job.id.as_str()) == Some(self.id.as_str()) {
                *active = None;
            }
        }
        let _ = self.done.send(true);
    }
}

impl SolverRuntime {
    fn reserve(
        &self,
        id: &str,
    ) -> Result<(JobGuard, watch::Receiver<bool>, Arc<AtomicU32>), String> {
        let mut active = self.active.lock().map_err(|_| "求解任务状态不可用。")?;
        // Check after taking the same lock used by shutdown, avoiding a reserve/exit race.
        if self.closing.load(Ordering::SeqCst) {
            return Err("应用正在关闭，无法开始新的排班。".into());
        }
        if active.is_some() {
            return Err("已有本地求解任务正在运行，请等待完成或先取消。".into());
        }
        let (cancel, receiver) = watch::channel(false);
        let (done, done_receiver) = watch::channel(false);
        let pid = Arc::new(AtomicU32::new(0));
        *active = Some(RunningJob {
            id: id.into(),
            cancel,
            done: done_receiver,
            pid: pid.clone(),
        });
        Ok((
            JobGuard {
                runtime: self.clone(),
                id: id.into(),
                done,
            },
            receiver,
            pid,
        ))
    }

    pub fn cancel_active(&self) -> Option<watch::Receiver<bool>> {
        let active = self.active.lock().ok()?;
        let job = active.as_ref()?;
        let _ = job.cancel.send(true);
        Some(job.done.clone())
    }

    pub fn force_shutdown(&self) {
        // Used only during application shutdown. No mutex is held while terminating.
        let pid = self
            .active
            .lock()
            .ok()
            .and_then(|active| active.as_ref().map(|job| job.pid.load(Ordering::SeqCst)));
        if let Some(pid) = pid.filter(|pid| *pid != 0) {
            kill_tree_sync(pid);
        }
    }
}

#[cfg(any(debug_assertions, test))]
fn development_solver_command(project_root: &std::path::Path) -> Result<Command, String> {
    let solver_dir = project_root.join("solver");
    let python = if cfg!(windows) {
        solver_dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        solver_dir.join(".venv").join("bin").join("python")
    };
    let entry = solver_dir.join("main.py");
    if !python.is_file() || !entry.is_file() {
        return Err("STARTUP_ERROR: 开发环境的本地 Python 求解器尚未准备好。请在项目根目录运行 npm run solver:setup，再重新启动桌面开发模式。".into());
    }
    let mut command = Command::new(python);
    command.arg(entry);
    Ok(command)
}

#[cfg(any(not(debug_assertions), test))]
fn bundled_solver_command(resource_dir: &std::path::Path) -> Result<Command, String> {
    let runtime_dir = resource_dir.join("solver-runtime");
    let executable = runtime_dir.join(if cfg!(windows) {
        "shiftflow-solver.exe"
    } else {
        "shiftflow-solver"
    });
    if !executable.is_file() || !runtime_dir.join("_internal").is_dir() {
        return Err("STARTUP_ERROR: 安装包中的本地求解运行时不完整。请重新安装完整桌面版本；构建时必须包含 solver-runtime 可执行文件和整个 _internal 目录。".into());
    }
    Ok(Command::new(executable))
}

fn solver_command(_app: &AppHandle) -> Result<Command, String> {
    #[cfg(debug_assertions)]
    {
        // Compile-time project location only; IPC callers cannot select Python or the script.
        let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("STARTUP_ERROR: 无法定位开发项目。")?;
        development_solver_command(project_root)
    }
    #[cfg(not(debug_assertions))]
    {
        // The installed app carries its own native onedir runtime. No system Python/PATH.
        let resources = _app
            .path()
            .resource_dir()
            .map_err(|_| "STARTUP_ERROR: 无法定位应用资源目录。")?;
        bundled_solver_command(&resources)
    }
}

fn normalized_request(mut request: Value) -> Result<(String, Vec<u8>, Duration), String> {
    if request.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        return Err("不支持的求解协议版本。".into());
    }
    let id = request
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or("缺少求解任务编号。")?
        .to_owned();
    if id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err("求解任务编号格式不正确。".into());
    }
    if !request.get("state").is_some_and(Value::is_object) {
        return Err("排班数据必须是对象。".into());
    }
    if request.get("options").is_none() {
        request["options"] = json!({});
    }
    if !request["options"].is_object() {
        return Err("求解选项必须是对象。".into());
    }
    let options = &mut request["options"];
    let seconds = options
        .get("timeLimitSeconds")
        .and_then(Value::as_f64)
        .unwrap_or(15.0)
        .clamp(1.0, 60.0);
    options["timeLimitSeconds"] = json!(seconds);
    if options.get("allowPartial").is_none() {
        options["allowPartial"] = json!(false);
    }
    if !options["allowPartial"].is_boolean() {
        return Err("允许缺员选项必须为布尔值。".into());
    }
    let input = serde_json::to_vec(&request).map_err(|_| "排班数据无法编码。")?;
    if input.len() > INPUT_LIMIT {
        return Err("排班数据超过 2 MB 上限，请缩小排班范围。".into());
    }
    // Startup is budgeted separately and never consumes the requested solver time.
    Ok((id, input, Duration::from_secs_f64(seconds)))
}

#[cfg(test)]
async fn read_limited<R: AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|_| "读取本地求解器输出失败。")?;
        if count == 0 {
            return Ok(output);
        }
        if output.len() + count > limit {
            return Err("本地求解器输出超过安全上限，任务已停止。".into());
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

#[cfg(windows)]
fn taskkill_command(pid: u32) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    // Fixed system executable and numeric PID only: no caller-controlled paths/arguments.
    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let mut command = std::process::Command::new(
        PathBuf::from(system_root)
            .join("System32")
            .join("taskkill.exe"),
    );
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn kill_tree_sync(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = taskkill_command(pid).status();
    }
}

struct ProcessGuard {
    pid: u32,
    armed: bool,
}
impl Drop for ProcessGuard {
    fn drop(&mut self) {
        if self.armed {
            kill_tree_sync(self.pid);
        }
    }
}

async fn terminate_and_reap(child: &mut Child, pid: u32) {
    #[cfg(unix)]
    kill_tree_sync(pid);
    #[cfg(windows)]
    {
        let _ = tauri::async_runtime::spawn_blocking(move || kill_tree_sync(pid)).await;
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

async fn wait_cancel(cancel: &mut watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    let _ = cancel.changed().await;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SolverPhase {
    Starting,
    Loading,
    Reading,
    Solving,
    Finishing,
}

impl SolverPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Loading => "loading",
            Self::Reading => "reading",
            Self::Solving => "solving",
            Self::Finishing => "finishing",
        }
    }
}

type ProgressSink = Option<Arc<dyn Fn(SolverPhase) + Send + Sync>>;

#[derive(Clone, Copy)]
struct Watchdog {
    startup: Duration,
    solve: Duration,
    exit: Duration,
}

impl Watchdog {
    fn production(time_limit: Duration) -> Self {
        Self {
            startup: Duration::from_secs(120),
            solve: time_limit + Duration::from_secs(15),
            exit: Duration::from_secs(5),
        }
    }
}

#[derive(Clone)]
enum ExpectedResponse {
    Info,
    Schedule(String),
}

fn parse_response(bytes: &[u8], expected: &ExpectedResponse) -> Result<Value, String> {
    let output: Value = serde_json::from_slice(bytes).map_err(|_| {
        "OUTPUT_INVALID: 内置求解器未返回完整有效的 JSON，原排班未被替换。".to_string()
    })?;
    let common = output.get("protocolVersion").and_then(Value::as_u64) == Some(1)
        && output.get("engine").and_then(Value::as_str) == Some(ENGINE);
    let compatible = match expected {
        ExpectedResponse::Info => output.get("version").is_some_and(Value::is_string),
        ExpectedResponse::Schedule(id) => {
            output.get("requestId").and_then(Value::as_str) == Some(id.as_str())
                && matches!(
                    output.get("status").and_then(Value::as_str),
                    Some(
                        "OPTIMAL"
                            | "FEASIBLE"
                            | "INFEASIBLE"
                            | "UNKNOWN"
                            | "MODEL_INVALID"
                            | "ERROR"
                    )
                )
                && output.get("issues").is_some_and(Value::is_array)
                && output.get("message").is_some_and(Value::is_string)
                && output.get("stats").is_some_and(|stats| {
                    stats
                        .get("wallTimeSeconds")
                        .and_then(Value::as_f64)
                        .is_some_and(|seconds| seconds >= 0.0)
                        && stats.get("shortageCount").and_then(Value::as_u64).is_some()
                        && stats.get("optimal").is_some_and(Value::is_boolean)
                })
                && (!matches!(
                    output.get("status").and_then(Value::as_str),
                    Some("OPTIMAL" | "FEASIBLE")
                ) || output.get("assignments").is_some_and(Value::is_array))
        }
    };
    if !common || !compatible {
        return Err("OUTPUT_INVALID: 内置求解器协议或任务编号不匹配，原排班未被替换。".into());
    }
    Ok(output)
}

#[derive(Default)]
struct Diagnostics {
    total: usize,
    line: Vec<u8>,
    summary: Vec<String>,
}

impl Diagnostics {
    fn accept_line(&mut self) -> Result<Option<SolverPhase>, String> {
        let line = String::from_utf8_lossy(&self.line)
            .trim_end_matches('\r')
            .to_owned();
        self.line.clear();
        if let Some(stage) = line.strip_prefix("SHIFTFLOW_STAGE_V1:") {
            return match stage {
                "loading" => Ok(Some(SolverPhase::Loading)),
                "reading" => Ok(Some(SolverPhase::Reading)),
                "solving" => Ok(Some(SolverPhase::Solving)),
                "finishing" => Ok(Some(SolverPhase::Finishing)),
                _ => Err(
                    "STAGE_PROTOCOL_ERROR: 本地求解器返回了不支持的启动阶段，请更新完整安装包。"
                        .into(),
                ),
            };
        }
        // Keep a bounded diagnostic tail, never a serialized schedule/input object.
        if !line.trim().is_empty()
            && !line.trim_start().starts_with(['{', '['])
            && !line.contains("\"state\"")
            && !line.contains("\"employees\"")
            && line.chars().count() <= 300
        {
            self.summary.push(
                line.chars()
                    .filter(|ch| !ch.is_control() || *ch == '\t')
                    .take(180)
                    .collect(),
            );
            if self.summary.len() > 6 {
                self.summary.remove(0);
            }
        }
        Ok(None)
    }

    fn push(&mut self, bytes: &[u8]) -> Result<Vec<SolverPhase>, String> {
        self.total += bytes.len();
        if self.total > STDERR_LIMIT {
            return Err("OUTPUT_LIMIT: 本地求解器诊断输出超过安全上限，任务已停止。".into());
        }
        let mut phases = Vec::new();
        for &byte in bytes {
            if byte == b'\n' {
                if let Some(phase) = self.accept_line()? {
                    phases.push(phase);
                }
            } else {
                self.line.push(byte);
            }
        }
        Ok(phases)
    }

    fn finish(&mut self) -> Result<Vec<SolverPhase>, String> {
        if self.line.is_empty() {
            return Ok(Vec::new());
        }
        Ok(self.accept_line()?.into_iter().collect())
    }

    fn decorate(&self, message: String) -> String {
        if self.summary.is_empty() || message.starts_with("CANCELLED:") {
            return message;
        }
        format!("{message}\n诊断摘要：{}", self.summary.join(" | "))
    }
}

fn advance_phase(
    current: &mut SolverPhase,
    next: SolverPhase,
    expected: &ExpectedResponse,
    watchdog: Watchdog,
    deadline: &mut tokio::time::Instant,
    progress: &ProgressSink,
) -> Result<(), String> {
    if *current == next {
        return Ok(());
    } // Repeated markers never extend a deadline.
    let valid = matches!(
        (*current, next),
        (SolverPhase::Starting, SolverPhase::Loading)
            | (SolverPhase::Loading, SolverPhase::Reading)
            | (SolverPhase::Reading, SolverPhase::Solving)
            | (SolverPhase::Solving, SolverPhase::Finishing)
    ) || (matches!(expected, ExpectedResponse::Info)
        && *current == SolverPhase::Loading
        && next == SolverPhase::Finishing);
    if !valid
        || (matches!(expected, ExpectedResponse::Info)
            && matches!(next, SolverPhase::Reading | SolverPhase::Solving))
    {
        return Err(format!(
            "STAGE_PROTOCOL_ERROR: 求解器阶段顺序不正确（{} → {}），原排班未被替换。",
            current.as_str(),
            next.as_str()
        ));
    }
    *current = next;
    if next == SolverPhase::Solving {
        *deadline = tokio::time::Instant::now() + watchdog.solve;
    }
    if next == SolverPhase::Finishing {
        *deadline = tokio::time::Instant::now() + watchdog.exit;
    }
    if let Some(progress) = progress {
        progress(next);
    }
    Ok(())
}

fn watchdog_error(phase: SolverPhase) -> String {
    match phase {
        SolverPhase::Starting => "STARTUP_TIMEOUT: 内置求解器尚未完成启动（阶段 starting），可能仍在等待系统安全检查或载入运行时；尚未开始排班求解，原排班未被替换。".into(),
        SolverPhase::Loading => "STARTUP_TIMEOUT: 内置求解器加载依赖超时（阶段 loading）；尚未开始排班求解，原排班未被替换。".into(),
        SolverPhase::Reading => "STARTUP_TIMEOUT: 内置求解器读取排班数据超时（阶段 reading）；尚未开始排班求解，原排班未被替换。".into(),
        SolverPhase::Solving => "SOLVE_TIMEOUT: 本地求解超过设定时限及结束缓冲（阶段 solving），已停止任务；这不代表规则无解，原排班未被替换。".into(),
        SolverPhase::Finishing => "EXIT_TIMEOUT: 求解器进入结束阶段后未交付完整合法的结果（阶段 finishing），已回收进程；原排班未被替换。".into(),
    }
}

async fn execute(
    app: &AppHandle,
    request_id: &str,
    input: Option<Vec<u8>>,
    time_limit: Duration,
    cancel: watch::Receiver<bool>,
    active_pid: Arc<AtomicU32>,
) -> Result<Value, String> {
    let mut command = solver_command(app)?;
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| "无法获取本地缓存目录。")?;
    let job_directory = JobDirectory::create(&cache_dir.join("solver-runtime"))?;
    command
        .current_dir(&job_directory.0)
        .env("TMPDIR", &job_directory.0)
        .env("TMP", &job_directory.0)
        .env("TEMP", &job_directory.0)
        .env("PYTHONUTF8", "1")
        .arg("--hosted");
    let expected = if input.is_none() {
        command.arg("--info");
        ExpectedResponse::Info
    } else {
        ExpectedResponse::Schedule(request_id.to_owned())
    };
    let handle = app.clone();
    let event_id = request_id.to_owned();
    let progress: ProgressSink = Some(Arc::new(move |phase| {
        let _ = handle.emit(
            "solver-progress",
            json!({ "requestId": event_id, "phase": phase.as_str() }),
        );
    }));
    supervise(
        command,
        input,
        Watchdog::production(time_limit),
        cancel,
        active_pid,
        expected,
        progress,
    )
    .await
}

// Production callers always obtain the fixed path above. Tests can provide controlled child programs.
async fn supervise(
    mut command: Command,
    input: Option<Vec<u8>>,
    watchdog: Watchdog,
    mut cancel: watch::Receiver<bool>,
    active_pid: Arc<AtomicU32>,
    expected: ExpectedResponse,
    progress: ProgressSink,
) -> Result<Value, String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    if let Some(progress) = &progress {
        progress(SolverPhase::Starting);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("STARTUP_ERROR: 无法启动内置求解器：{error}"))?;
    let pid = child
        .id()
        .ok_or("STARTUP_ERROR: 无法获取本地求解器进程编号。")?;
    active_pid.store(pid, Ordering::SeqCst);
    let mut process_guard = ProcessGuard { pid, armed: true };
    let mut stdin = child
        .stdin
        .take()
        .ok_or("STARTUP_ERROR: 求解器输入通道不可用。")?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("STARTUP_ERROR: 求解器输出通道不可用。")?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or("STARTUP_ERROR: 求解器诊断通道不可用。")?;
    let mut diagnostics = Diagnostics::default();
    let mut phase = SolverPhase::Starting;
    let mut deadline = tokio::time::Instant::now() + watchdog.startup;
    let result: Result<(Value, bool), String> = {
        let writer = async {
            if let Some(mut input) = input {
                input.push(b'\n');
                stdin
                    .write_all(&input)
                    .await
                    .map_err(|_| "INPUT_ERROR: 向内置求解器传递数据失败。".to_string())?;
            }
            drop(stdin);
            Ok::<(), String>(())
        };
        tokio::pin!(writer);
        let mut writer_done = false;
        let mut stdout_done = false;
        let mut stderr_done = false;
        let mut status: Option<ExitStatus> = None;
        let mut output = Vec::new();
        let mut complete: Option<Value> = None;
        let mut out_buffer = [0_u8; 8192];
        let mut err_buffer = [0_u8; 8192];
        loop {
            if stdout_done && stderr_done && writer_done && status.is_some() {
                if phase != SolverPhase::Finishing {
                    break Err(format!("STARTUP_PROTOCOL_ERROR: 内置求解器未完成 hosted 阶段握手（最后阶段 {}），请重新构建或安装匹配的完整版本。", phase.as_str()));
                }
                break parse_response(&output, &expected).map(|value| (value, false));
            }
            tokio::select! {
                biased;
                _ = wait_cancel(&mut cancel) => break Err("CANCELLED: 排班求解已取消。".into()),
                _ = tokio::time::sleep_until(deadline) => {
                    if let Ok(Some(exit)) = child.try_wait() {
                        if !exit.success() { break Err(format!("PROCESS_EXIT: 内置求解器异常退出（{exit}），原排班未被替换。")); }
                    }
                    // A fully validated result is usable even if the PyInstaller parent hangs
                    // during cleanup. Normal nonzero exits are still errors in the wait branch.
                    if phase == SolverPhase::Finishing {
                        if let Some(mut value) = complete.take() {
                            value["hostDiagnostics"] = json!({"exitTimedOut": true, "phase": "finishing", "code": "EXIT_TIMEOUT"});
                            break Ok((value, true));
                        }
                    }
                    break Err(watchdog_error(phase));
                }
                written = &mut writer, if !writer_done => {
                    if let Err(error) = written { break Err(error); }
                    writer_done = true;
                }
                read = stdout.read(&mut out_buffer), if !stdout_done => {
                    let count = match read { Ok(count) => count, Err(_) => break Err("OUTPUT_ERROR: 读取内置求解器结果失败。".into()) };
                    if count == 0 {
                        stdout_done = true;
                        complete = parse_response(&output, &expected).ok();
                    } else {
                        if output.len() + count > OUTPUT_LIMIT { break Err("OUTPUT_LIMIT: 本地求解器结果超过 8 MB 上限，任务已停止。".into()); }
                        output.extend_from_slice(&out_buffer[..count]);
                        complete = None;
                        if output.last() == Some(&b'\n') || (phase == SolverPhase::Finishing && output.iter().rfind(|byte| !byte.is_ascii_whitespace()) == Some(&b'}')) {
                            complete = parse_response(&output, &expected).ok();
                        }
                    }
                }
                read = stderr.read(&mut err_buffer), if !stderr_done => {
                    let count = match read { Ok(count) => count, Err(_) => break Err("OUTPUT_ERROR: 读取内置求解器诊断失败。".into()) };
                    let phases = if count == 0 { stderr_done = true; diagnostics.finish() } else { diagnostics.push(&err_buffer[..count]) };
                    let phases = match phases { Ok(phases) => phases, Err(error) => break Err(error) };
                    let mut stage_error = None;
                    for next in phases {
                        if let Err(error) = advance_phase(&mut phase, next, &expected, watchdog, &mut deadline, &progress) {
                            stage_error = Some(error); break;
                        }
                    }
                    if let Some(error) = stage_error { break Err(error); }
                    if phase == SolverPhase::Finishing { complete = parse_response(&output, &expected).ok(); }
                }
                exited = child.wait(), if status.is_none() => {
                    match exited {
                        Ok(exit) if exit.success() => status = Some(exit),
                        Ok(exit) => break Err(format!("PROCESS_EXIT: 内置求解器异常退出（{exit}，阶段 {}），原排班未被替换。", phase.as_str())),
                        Err(_) => break Err("PROCESS_EXIT: 无法获取内置求解器退出状态，原排班未被替换。".into()),
                    }
                }
            }
        }
    };
    let force_cleanup = result.as_ref().map(|(_, force)| *force).unwrap_or(true);
    if force_cleanup {
        terminate_and_reap(&mut child, pid).await;
    }
    process_guard.armed = false;
    active_pid.store(0, Ordering::SeqCst);
    result
        .map(|(value, _)| value)
        .map_err(|error| diagnostics.decorate(error))
}

#[tauri::command]
pub async fn solve_schedule(
    app: AppHandle,
    runtime: State<'_, SolverRuntime>,
    request: Value,
) -> Result<Value, String> {
    let (id, input, deadline) = normalized_request(request)?;
    let (_guard, cancel, pid) = runtime.reserve(&id)?;
    let output = execute(&app, &id, Some(input), deadline, cancel, pid).await?;
    if output.get("requestId").and_then(Value::as_str) != Some(id.as_str())
        || output.get("protocolVersion").and_then(Value::as_u64) != Some(1)
        || output.get("engine").and_then(Value::as_str) != Some(ENGINE)
        || !matches!(
            output.get("status").and_then(Value::as_str),
            Some("OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "UNKNOWN" | "MODEL_INVALID" | "ERROR")
        )
    {
        return Err("本地求解器协议或任务编号不匹配，原排班未被替换。".into());
    }
    Ok(output)
}

#[tauri::command]
pub async fn cancel_solve(
    runtime: State<'_, SolverRuntime>,
    request_id: String,
) -> Result<bool, String> {
    let receiver = {
        let active = runtime.active.lock().map_err(|_| "求解任务状态不可用。")?;
        match active.as_ref().filter(|job| job.id == request_id) {
            Some(job) => {
                let _ = job.cancel.send(true);
                Some(job.done.clone())
            }
            None => None,
        }
    };
    if let Some(mut done) = receiver {
        if !*done.borrow() {
            let _ = done.changed().await;
        }
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn solver_info(
    app: AppHandle,
    runtime: State<'_, SolverRuntime>,
) -> Result<Value, String> {
    if let Some(info) = runtime
        .info
        .lock()
        .map_err(|_| "求解器状态不可用。")?
        .clone()
    {
        return Ok(info);
    }
    let (_guard, cancel, pid) = runtime.reserve("internal-solver-info")?;
    let output = execute(
        &app,
        "internal-solver-info",
        None,
        Duration::ZERO,
        cancel,
        pid,
    )
    .await?;
    if output.get("engine").and_then(Value::as_str) != Some(ENGINE)
        || output.get("protocolVersion").and_then(Value::as_u64) != Some(1)
        || !output.get("version").is_some_and(Value::is_string)
    {
        return Err("内置求解器版本不兼容。".into());
    }
    *runtime.info.lock().map_err(|_| "求解器状态不可用。")? = Some(output.clone());
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_resolver_uses_only_the_fixed_project_virtual_environment() {
        let project = JobDirectory::create(&std::env::temp_dir()).unwrap();
        assert!(development_solver_command(&project.0)
            .unwrap_err()
            .contains("npm run solver:setup"));
        let solver = project.0.join("solver");
        let python = if cfg!(windows) {
            solver.join(".venv/Scripts/python.exe")
        } else {
            solver.join(".venv/bin/python")
        };
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, b"test executable placeholder").unwrap();
        std::fs::write(solver.join("main.py"), b"# test entry").unwrap();
        let command = development_solver_command(&project.0).unwrap();
        assert_eq!(command.as_std().get_program(), python.as_os_str());
        assert_eq!(
            command.as_std().get_args().collect::<Vec<_>>(),
            vec![solver.join("main.py").as_os_str()]
        );
    }

    #[test]
    fn release_resolver_requires_the_complete_onedir_resource_directory() {
        let resources = JobDirectory::create(&std::env::temp_dir()).unwrap();
        assert!(bundled_solver_command(&resources.0).is_err());
        let runtime = resources.0.join("solver-runtime");
        std::fs::create_dir(&runtime).unwrap();
        let executable = runtime.join(if cfg!(windows) {
            "shiftflow-solver.exe"
        } else {
            "shiftflow-solver"
        });
        std::fs::write(&executable, b"test executable placeholder").unwrap();
        assert!(
            bundled_solver_command(&resources.0).is_err(),
            "a binary without its libraries must be rejected"
        );
        std::fs::create_dir(runtime.join("_internal")).unwrap();
        let command = bundled_solver_command(&resources.0).unwrap();
        assert_eq!(command.as_std().get_program(), executable.as_os_str());
        assert_eq!(command.as_std().get_args().count(), 0);
    }

    /// Uses the fixed project virtual environment directly, without freezing or extraction.
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "requires npm run solver:setup for the local project virtual environment"]
    async fn python_source_solver_solves_real_schedule() {
        let project = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        assert_real_solver(
            || {
                development_solver_command(project)
                    .expect("run npm run solver:setup before this test")
            },
            "project-python",
        )
        .await;
    }

    /// Kept under its original name for CI; explicitly tests the onedir resources, never debug Python.
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "requires the complete PyInstaller onedir runtime in src-tauri/solver-runtime"]
    async fn frozen_sidecar_solves_real_schedule() {
        let resources = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        assert_real_solver(
            || {
                bundled_solver_command(resources)
                    .expect("build the complete onedir solver-runtime before this test")
            },
            "bundled-onedir",
        )
        .await;
    }

    async fn assert_real_solver(make_command: impl Fn() -> Command, runtime_name: &str) {
        // Verify the exact initial --info path that previously hung before attempting a schedule.
        let directory = JobDirectory::create(&std::env::temp_dir()).unwrap();
        let path = directory.0.clone();
        let mut command = make_command();
        command
            .current_dir(&directory.0)
            .env("PYTHONUTF8", "1")
            .env("TMPDIR", &directory.0)
            .env("TMP", &directory.0)
            .env("TEMP", &directory.0)
            .args(["--hosted", "--info"]);
        let (_sender, cancel) = watch::channel(false);
        let pid = Arc::new(AtomicU32::new(0));
        let info = supervise(
            command,
            None,
            Watchdog::production(Duration::ZERO),
            cancel,
            pid.clone(),
            ExpectedResponse::Info,
            None,
        )
        .await
        .unwrap();
        assert!(info["version"].is_string());
        assert_eq!(pid.load(Ordering::SeqCst), 0);
        drop(directory);
        assert!(!path.exists());
        let employee = |id: &str, name: &str, unavailable: Value| {
            json!({
                "id": id, "name": name, "role": "员工", "group": "", "color": "#123456",
                "maxHoursPerWeek": 48, "eligibleShiftIds": ["early"], "unavailableDates": unavailable,
            })
        };
        let request = json!({
            "protocolVersion": 1, "requestId": "rust-local-solver-integration",
            "state": {
                "version": 1, "teamName": "桌面真实求解链路验证", "month": "2026-02",
                "employees": [employee("a", "张明", json!(["2026-02-02"])), employee("b", "李华", json!([]))],
                "shifts": [{"id": "early", "name": "早班", "shortName": "早", "color": "#123456", "start": "08:00", "end": "16:00", "required": 1}],
                "assignments": [{"employeeId": "a", "date": "2026-02-01", "shiftId": "off", "locked": true}],
                "rules": {"minRestHours": 11, "maxConsecutiveDays": 6, "balanceWeekends": true, "separationGroups": []}
            },
            "options": {"timeLimitSeconds": 5, "allowPartial": false, "seed": 1010}
        });
        let (id, input, deadline) = normalized_request(request).unwrap();
        let runtime = SolverRuntime::default();
        let (guard, cancel, pid) = runtime.reserve(&id).unwrap();
        let observed_pid = pid.clone();
        let directory = JobDirectory::create(&std::env::temp_dir()).unwrap();
        let directory_path = directory.0.clone();
        let mut command = make_command();
        command
            .current_dir(&directory.0)
            .env("PYTHONUTF8", "1")
            .env("TMPDIR", &directory.0)
            .env("TMP", &directory.0)
            .env("TEMP", &directory.0)
            .arg("--hosted");
        let result = supervise(
            command,
            Some(input),
            Watchdog::production(deadline),
            cancel,
            pid,
            ExpectedResponse::Schedule(id.clone()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(result["engine"], ENGINE);
        assert_eq!(result["protocolVersion"], 1);
        assert_eq!(result["requestId"], id);
        assert!(
            matches!(result["status"].as_str(), Some("OPTIMAL" | "FEASIBLE")),
            "{result}"
        );
        assert_eq!(result["stats"]["shortageCount"], 0);
        let assignments = result["assignments"]
            .as_array()
            .expect("solver must return assignments");
        for day in 1..=28 {
            let date = format!("2026-02-{day:02}");
            let work: Vec<_> = assignments
                .iter()
                .filter(|item| item["date"] == date && item["shiftId"] == "early")
                .collect();
            assert_eq!(work.len(), 1, "missing or excess coverage on {date}");
            if day <= 2 {
                assert_eq!(
                    work[0]["employeeId"], "b",
                    "locked rest and leave must be respected"
                );
            }
        }
        assert!(assignments.iter().any(|item| item["employeeId"] == "a"
            && item["date"] == "2026-02-01"
            && item["shiftId"] == "off"
            && item["locked"] == true));
        assert_eq!(observed_pid.load(Ordering::SeqCst), 0);
        drop(guard);
        assert!(runtime.active.lock().unwrap().is_none());
        drop(directory);
        assert!(
            !directory_path.exists(),
            "the per-request temporary directory must be cleaned"
        );
        println!("real solver ({runtime_name}), info version={}: status={}, assignments={}, shortageCount=0; processes reaped and temporary directories removed", info["version"], result["status"], assignments.len());
    }

    #[test]
    fn job_temp_directories_are_unique_and_remove_only_their_own_files() {
        let first = JobDirectory::create(&std::env::temp_dir()).unwrap();
        let second = JobDirectory::create(&std::env::temp_dir()).unwrap();
        let first_path = first.0.clone();
        assert_ne!(first.0, second.0);
        std::fs::create_dir(first.0.join("_MEI-unpacked")).unwrap();
        std::fs::write(
            first.0.join("_MEI-unpacked").join("solver-runtime.tmp"),
            b"temporary",
        )
        .unwrap();
        drop(first);
        assert!(!first_path.exists());
        assert!(second.0.exists());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn output_reader_enforces_actual_byte_limit() {
        assert_eq!(read_limited(&b"12345"[..], 5).await.unwrap(), b"12345");
        assert!(read_limited(&b"123456"[..], 5).await.is_err());
    }

    #[cfg(unix)]
    fn test_command(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn reads_stdout_and_stderr_without_pipe_deadlock() {
        let (_sender, cancel) = watch::channel(false);
        let pid = Arc::new(AtomicU32::new(0));
        let output = supervise(
            test_command("head -c 100000 /dev/zero >&2; printf '\\nSHIFTFLOW_STAGE_V1:loading\\n' >&2; cat >/dev/null; printf '{\"engine\":\"ortools-cp-sat\",\"protocolVersion\":1,\"version\":\"test\"}\\n'; printf 'SHIFTFLOW_STAGE_V1:finishing\\n' >&2"),
            Some(vec![b'x'; 100000]),
            Watchdog::production(Duration::from_secs(3)),
            cancel,
            pid.clone(), ExpectedResponse::Info, None,
        )
        .await
        .unwrap();
        assert_eq!(output["version"], "test");
        assert_eq!(pid.load(Ordering::SeqCst), 0);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_stops_and_reaps_a_running_process() {
        let (sender, cancel) = watch::channel(false);
        let pid = Arc::new(AtomicU32::new(0));
        let observed_pid = pid.clone();
        let task = tokio::spawn(supervise(
            test_command("sleep 30 & wait"),
            Some(Vec::new()),
            Watchdog::production(Duration::from_secs(30)),
            cancel,
            pid,
            ExpectedResponse::Info,
            None,
        ));
        while observed_pid.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
        sender.send(true).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert!(result.unwrap_err().starts_with("CANCELLED:"));
        assert_eq!(observed_pid.load(Ordering::SeqCst), 0);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn timeout_and_oversized_diagnostics_stop_the_process() {
        for (script, deadline, expected) in [
            (
                "sleep 30 & wait",
                Duration::from_millis(50),
                "STARTUP_TIMEOUT:",
            ),
            (
                "head -c 300000 /dev/zero >&2; sleep 30",
                Duration::from_secs(3),
                "OUTPUT_LIMIT:",
            ),
        ] {
            let (_sender, cancel) = watch::channel(false);
            let pid = Arc::new(AtomicU32::new(0));
            let result = supervise(
                test_command(script),
                Some(Vec::new()),
                Watchdog {
                    startup: deadline,
                    solve: deadline,
                    exit: deadline,
                },
                cancel,
                pid.clone(),
                ExpectedResponse::Info,
                None,
            )
            .await;
            assert!(result.unwrap_err().starts_with(expected));
            assert_eq!(pid.load(Ordering::SeqCst), 0);
        }
    }

    #[cfg(unix)]
    const SCHEDULE_RESULT: &str = r#"{"protocolVersion":1,"requestId":"staged-test","engine":"ortools-cp-sat","status":"FEASIBLE","assignments":[],"issues":[],"stats":{"shortageCount":0,"optimal":false,"wallTimeSeconds":0},"message":"test"}"#;

    #[cfg(unix)]
    async fn staged_script(
        script: &str,
        startup_ms: u64,
        solve_ms: u64,
        exit_ms: u64,
        info: bool,
        progress: ProgressSink,
    ) -> Result<Value, String> {
        let (_sender, cancel) = watch::channel(false);
        let pid = Arc::new(AtomicU32::new(0));
        let expected = if info {
            ExpectedResponse::Info
        } else {
            ExpectedResponse::Schedule("staged-test".into())
        };
        let result = supervise(
            test_command(script),
            Some(Vec::new()),
            Watchdog {
                startup: Duration::from_millis(startup_ms),
                solve: Duration::from_millis(solve_ms),
                exit: Duration::from_millis(exit_ms),
            },
            cancel,
            pid.clone(),
            expected,
            progress,
        )
        .await;
        assert_eq!(pid.load(Ordering::SeqCst), 0);
        result
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn slow_startup_does_not_consume_the_solver_time_budget() {
        let phases = Arc::new(Mutex::new(Vec::new()));
        let observed = phases.clone();
        let progress: ProgressSink =
            Some(Arc::new(move |phase| observed.lock().unwrap().push(phase)));
        let script = format!("printf 'SHIFTFLOW_STAGE_V1:loading\\n' >&2; sleep 0.25; printf 'SHIFTFLOW_STAGE_V1:reading\\n' >&2; cat >/dev/null; printf 'SHIFTFLOW_STAGE_V1:solving\\n' >&2; sleep 0.03; printf '%s\\n' '{}'; printf 'SHIFTFLOW_STAGE_V1:finishing\\n' >&2", SCHEDULE_RESULT);
        let began = std::time::Instant::now();
        let output = staged_script(&script, 2000, 150, 500, false, progress)
            .await
            .unwrap();
        assert_eq!(output["status"], "FEASIBLE");
        assert!(began.elapsed() >= Duration::from_millis(250));
        assert_eq!(
            *phases.lock().unwrap(),
            vec![
                SolverPhase::Starting,
                SolverPhase::Loading,
                SolverPhase::Reading,
                SolverPhase::Solving,
                SolverPhase::Finishing
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn info_loading_has_its_own_budget_and_does_not_require_solving() {
        let output = staged_script("printf 'SHIFTFLOW_STAGE_V1:loading\\n' >&2; sleep 0.12; printf '{\"engine\":\"ortools-cp-sat\",\"protocolVersion\":1,\"version\":\"test\"}\\n'; printf 'SHIFTFLOW_STAGE_V1:finishing\\n' >&2", 2000, 1, 500, true, None).await.unwrap();
        assert_eq!(output["version"], "test");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn solving_timeout_is_separate_from_startup_and_cannot_be_extended_by_repeated_markers() {
        let script = "printf 'SHIFTFLOW_STAGE_V1:loading\\nSHIFTFLOW_STAGE_V1:reading\\n' >&2; cat >/dev/null; printf 'SHIFTFLOW_STAGE_V1:solving\\n' >&2; sleep 0.03; printf 'SHIFTFLOW_STAGE_V1:solving\\n' >&2; sleep 30";
        let began = std::time::Instant::now();
        let error = staged_script(script, 2000, 80, 500, false, None)
            .await
            .unwrap_err();
        assert!(error.starts_with("SOLVE_TIMEOUT:"), "{error}");
        assert!(began.elapsed() < Duration::from_secs(1));
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn stuck_reading_reports_the_stage_and_a_bounded_diagnostic_summary() {
        let error = staged_script("printf 'SHIFTFLOW_STAGE_V1:loading\\nSHIFTFLOW_STAGE_V1:reading\\nWaiting for input pipe\\n' >&2; sleep 30", 80, 2000, 500, false, None).await.unwrap_err();
        assert!(error.starts_with("STARTUP_TIMEOUT:"), "{error}");
        assert!(
            error.contains("reading") && error.contains("Waiting for input pipe"),
            "{error}"
        );
        let mut diagnostics = Diagnostics::default();
        diagnostics
            .push(b"{\"state\":{\"employees\":[\"private name\"]}}\nshort diagnostic\n")
            .unwrap();
        let summary = diagnostics.decorate("STARTUP_TIMEOUT: test".into());
        assert!(!summary.contains("private name"));
        assert!(summary.contains("short diagnostic"));
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn complete_result_survives_a_hung_onefile_parent_but_invalid_output_does_not() {
        for (response, valid) in [(SCHEDULE_RESULT, true), ("incomplete-json", false)] {
            let script = format!("printf 'SHIFTFLOW_STAGE_V1:loading\\nSHIFTFLOW_STAGE_V1:reading\\n' >&2; cat >/dev/null; printf 'SHIFTFLOW_STAGE_V1:solving\\n' >&2; printf '%s\\n' '{}'; printf 'SHIFTFLOW_STAGE_V1:finishing\\n' >&2; sleep 30", response);
            let result = staged_script(&script, 2000, 2000, 80, false, None).await;
            if valid {
                assert_eq!(result.unwrap()["hostDiagnostics"]["exitTimedOut"], true);
            } else {
                assert!(result.unwrap_err().starts_with("EXIT_TIMEOUT:"));
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn abnormal_exit_and_missing_hosted_markers_never_succeed() {
        let abnormal = format!("printf 'SHIFTFLOW_STAGE_V1:loading\\nSHIFTFLOW_STAGE_V1:reading\\n' >&2; cat >/dev/null; printf 'SHIFTFLOW_STAGE_V1:solving\\n' >&2; printf '%s\\n' '{}'; printf 'SHIFTFLOW_STAGE_V1:finishing\\n' >&2; exit 4", SCHEDULE_RESULT);
        assert!(staged_script(&abnormal, 2000, 2000, 500, false, None)
            .await
            .unwrap_err()
            .starts_with("PROCESS_EXIT:"));
        let legacy = format!("cat >/dev/null; printf '%s\\n' '{}'", SCHEDULE_RESULT);
        assert!(staged_script(&legacy, 2000, 2000, 500, false, None)
            .await
            .unwrap_err()
            .starts_with("STARTUP_PROTOCOL_ERROR:"));
    }

    #[test]
    fn normalizes_limits_and_requires_plain_request_ids() {
        let (_, bytes, timeout) = normalized_request(json!({"protocolVersion":1,"requestId":"safe-id_1","state":{},"options":{"timeLimitSeconds":999}})).unwrap();
        let normalized: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(normalized["options"]["timeLimitSeconds"], 60.0);
        assert_eq!(normalized["options"]["allowPartial"], false);
        assert_eq!(timeout, Duration::from_secs(60));
        assert!(normalized_request(
            json!({"protocolVersion":1,"requestId":"../../bad;cmd","state":{}})
        )
        .is_err());
        assert!(
            normalized_request(json!({"protocolVersion":2,"requestId":"ok","state":{}})).is_err()
        );
        assert!(
            normalized_request(json!({"protocolVersion":1,"requestId":"ok","state":[]})).is_err()
        );
    }

    #[test]
    fn rejects_oversized_input_and_conflicting_jobs_then_releases_slot() {
        assert!(normalized_request(json!({"protocolVersion":1,"requestId":"ok","state":{"oversized":"x".repeat(INPUT_LIMIT)}})).is_err());
        let runtime = SolverRuntime::default();
        let (guard, cancel, _) = runtime.reserve("first").unwrap();
        assert!(runtime.reserve("second").is_err());
        let done = runtime.cancel_active().unwrap();
        assert!(*cancel.borrow());
        drop(guard);
        assert!(*done.borrow());
        assert!(runtime.reserve("second").is_ok());
    }
}
