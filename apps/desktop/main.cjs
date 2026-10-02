const { app, BrowserWindow, dialog, Menu, shell } = require("electron");
const { spawn } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

app.setName("ChessRabbit");
const dataArgument = process.argv.find((arg) => arg.startsWith("--data-dir="));
if (dataArgument) {
  const directory = path.resolve(dataArgument.slice(11));
  fs.mkdirSync(directory, { recursive: true });
  app.setPath("userData", directory);
}
const smoke = process.argv.includes("--smoke-test");
const controlToken = randomBytes(48).toString("hex");
let backend, window, origin, quitting = false, backendExited = false;

function openExternal(url) {
  try {
    const target = new URL(url);
    if (target.protocol === "https:" && !target.username && !target.password) shell.openExternal(target.href);
  } catch { /* Invalid destinations are ignored. */ }
}

async function control(endpoint, body) {
  const response = await fetch(`${origin}/desktop/${endpoint}`, {
    method: "POST", headers: { Authorization: `Bearer ${controlToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || "The desktop service could not complete the request");
  return result;
}

async function addEngine(leela) {
  if (!origin) return;
  const executable = await dialog.showOpenDialog(window, {
    title: leela ? "Choose your Leela Chess Zero executable" : "Choose a UCI engine executable",
    filters: [{ name: "Windows executable", extensions: ["exe"] }], properties: ["openFile"],
  });
  if (executable.canceled) return;
  const binary = executable.filePaths[0];
  const profile = {
    id: leela ? "lc0" : `uci-${createHash("sha256").update(binary).digest("hex").slice(0, 12)}`,
    name: leela ? "Leela Chess Zero" : path.basename(binary, ".exe"), binary,
  };
  if (leela) {
    const network = await dialog.showOpenDialog(window, {
      title: "Choose the Leela neural network file", properties: ["openFile"],
      filters: [{ name: "Leela network", extensions: ["gz", "pb"] }],
    });
    if (network.canceled) return;
    profile.options = { WeightsFile: network.filePaths[0] };
  }
  try {
    await control("engines", profile);
    await dialog.showMessageBox(window, { type: "info", title: "Engine ready",
      message: `${profile.name} is ready`, detail: "Open Analysis settings and select this engine. Its files must remain at the location you chose." });
  } catch (error) {
    await dialog.showMessageBox(window, { type: "error", title: "Could not start engine", message: error.message });
  }
}

function setMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "File", submenu: [
      { label: "Open data folder", click: () => shell.openPath(path.join(app.getPath("userData"), "local")) },
      { type: "separator" }, { role: "quit" },
    ] },
    { label: "Engines", submenu: [
      { label: "Add Leela Chess Zero…", click: () => addEngine(true) },
      { label: "Add UCI engine…", click: () => addEngine(false) },
      { type: "separator" },
      { label: "Leela downloads", click: () => openExternal("https://lczero.org/play/download/") },
    ] },
    { label: "View", submenu: [{ role: "reload" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] },
    { label: "Help", submenu: [
      { label: "Donate", click: () => openExternal("https://buymeacoffee.com/shivamjg101") },
      { label: "Source code", click: () => openExternal("https://github.com/shivamjg101/chessrabbit/tree/codex/open-source-local-engines") },
      { label: "Licenses", click: () => shell.openPath(path.join(process.resourcesPath, "licenses")) },
      { label: "About ChessRabbit", click: () => dialog.showMessageBox(window, { title: "ChessRabbit", message: `ChessRabbit ${app.getVersion()}`,
        detail: "Free, open-source chess analysis and training. Stockfish 19 is included. Licensed under GPL-3.0. Your games stay on this computer." }) },
    ] },
  ]));
}

async function start() {
  setMenu();
  window = new BrowserWindow({ width: 1400, height: 920, minWidth: 760, minHeight: 600,
    show: !smoke, title: "ChessRabbit", backgroundColor: "#0e1929",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: "deny" }; });
  window.webContents.on("will-navigate", (event, url) => {
    if (!origin || new URL(url).origin !== origin) { event.preventDefault(); openExternal(url); }
  });
  await window.loadFile(path.join(__dirname, "loading.html"));
  const resources = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "../../dist/desktop-dev");
  const data = path.join(app.getPath("userData"), "local");
  fs.mkdirSync(data, { recursive: true });
  const log = fs.createWriteStream(path.join(data, "desktop.log"), { flags: "a" });
  backend = spawn(path.join(resources, "backend", "ChessRabbitBackend.exe"), ["--resources", resources, "--data-dir", data], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"], cwd: data,
    env: { ...process.env, CHESSRABBIT_CONTROL_TOKEN: controlToken },
  });
  backend.stderr.pipe(log);
  const startupTimer = setTimeout(() => failure("Local services did not start within three minutes. See desktop.log in the data folder."), 180000);
  const lines = readline.createInterface({ input: backend.stdout });
  lines.on("line", async (line) => {
    let message;
    try { message = JSON.parse(line); } catch { log.write(`${line}\n`); return; }
    if (message.type !== "ready" || origin) return;
    const url = new URL(message.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return;
    clearTimeout(startupTimer);
    origin = url.origin;
    console.log(`CHESSRABBIT_READY ${origin}`);
    try {
      if (smoke) {
        await require("./smoke.cjs").run(origin, data, control);
        console.log("CHESSRABBIT_SMOKE_PASSED");
        app.quit();
      } else await window.loadURL(`${origin}/app/`);
    } catch (error) { failure(error.stack || error.message); }
  });
  backend.on("error", (error) => { clearTimeout(startupTimer); failure(error.message); });
  backend.on("exit", (code) => {
    backendExited = true;
    clearTimeout(startupTimer);
    log.end();
    if (!quitting) failure(`Local services stopped (exit ${code}). Your data has been preserved. See ${path.join(data, "desktop.log")}.`);
  });
}

function failure(message) {
  console.error(message);
  if (!smoke && !quitting) dialog.showErrorBox("ChessRabbit could not start", message);
  process.exitCode = 1;
  app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(start).catch((error) => failure(error.stack));
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting || !backend || backendExited) return;
    event.preventDefault();
    quitting = true;
    if (window) window.hide();
    const stop = async () => {
      if (origin) await control("shutdown").catch(() => {});
      backend.stdin.end();
      await new Promise((resolve) => {
        if (backendExited) return resolve();
        const timer = setTimeout(() => { backend.kill(); resolve(); }, 20000);
        backend.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      app.exit(process.exitCode || 0);
    };
    stop().catch(() => { backend.kill(); app.exit(1); });
  });
}
