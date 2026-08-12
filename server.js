const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(process.env.WORK_ROOT || "/tmp/defold-web-tester");
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 100);
const MAX_UPLOAD = MAX_UPLOAD_MB * 1024 * 1024;
const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS || 5 * 60 * 1000);
const BOB = process.env.BOB_JAR || "/opt/defold/bob.jar";

fs.mkdirSync(ROOT, { recursive: true });

const upload = multer({
  dest: path.join(ROOT, "uploads"),
  limits: { fileSize: MAX_UPLOAD },
  fileFilter: (_req, file, cb) => {
    const ok = path.extname(file.originalname).toLowerCase() === ".zip";
    cb(ok ? null : new Error("ZIP 파일만 업로드할 수 있습니다."));
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function jobDir(id) {
  return path.join(ROOT, "jobs", id);
}

function safeResolve(root, entryName) {
  const normalized = path.posix.normalize(entryName.replaceAll("\\", "/"));
  if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) {
    throw new Error(`안전하지 않은 ZIP 경로: ${entryName}`);
  }
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`ZIP 경로가 작업 디렉터리를 벗어납니다: ${entryName}`);
  }
  return target;
}

function extractZipSecurely(zipPath, dest) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  let totalUncompressed = 0;
  const maxUncompressed = Number(process.env.MAX_UNCOMPRESSED_MB || 500) * 1024 * 1024;

  for (const entry of entries) {
    const target = safeResolve(dest, entry.entryName);
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    totalUncompressed += Number(entry.header?.size || 0);
    if (totalUncompressed > maxUncompressed) {
      throw new Error("압축 해제 후 프로젝트가 너무 큽니다.");
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }
  return entries.length;
}

async function findGameProject(root) {
  const candidates = [];

  async function walk(dir, depth) {
    if (depth > 4) return;
    const names = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of names) {
      if (item.name === "node_modules" || item.name === ".git") continue;
      const full = path.join(dir, item.name);
      if (item.isFile() && item.name === "game.project") {
        candidates.push(path.dirname(full));
      } else if (item.isDirectory()) {
        await walk(full, depth + 1);
      }
    }
  }

  await walk(root, 0);

  if (candidates.length === 0) throw new Error("game.project를 찾지 못했습니다.");
  if (candidates.length > 1) throw new Error("game.project가 여러 개 발견되었습니다. 하나의 Defold 프로젝트 ZIP만 업로드하세요.");
  return candidates[0];
}

function parseGameProject(file) {
  const text = fs.readFileSync(file, "utf8");
  const values = {};
  let section = "";

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const m = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = section ? `${section}.${m[1].trim()}` : m[1].trim();
    values[key] = m[2].trim();
  }
  return values;
}

function runBob(cwd, args, logFile) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(logFile, { flags: "a" });
    const child = spawn("java", ["-Xmx2g", "-jar", BOB, ...args], {
      cwd,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let combined = "";
    const append = (chunk) => {
      const text = chunk.toString();
      combined += text;
      if (combined.length > 300000) combined = combined.slice(-300000);
      output.write(text);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      output.end();
      reject(new Error(`Defold 빌드가 ${BUILD_TIMEOUT_MS / 1000}초를 초과했습니다.`));
    }, BUILD_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      output.end();
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      output.end();
      if (code === 0) resolve(combined);
      else {
        const err = new Error(`Bob 빌드 실패 (exit ${code})`);
        err.output = combined;
        reject(err);
      }
    });
  });
}

function findIndexHtml(dir) {
  let found = null;
  function walk(current, depth) {
    if (found || depth > 4) return;
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stat = fs.statSync(full);
      if (stat.isFile() && name.toLowerCase() === "index.html") {
        found = full;
        return;
      }
      if (stat.isDirectory()) walk(full, depth + 1);
      if (found) return;
    }
  }
  walk(dir, 0);
  return found;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    bob: fs.existsSync(BOB),
    port: PORT,
    maxUploadMB: MAX_UPLOAD_MB
  });
});

app.post("/api/build", upload.single("project"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ZIP 파일이 없습니다." });

  const id = crypto.randomUUID();
  const dir = jobDir(id);
  const source = path.join(dir, "source");
  const bundle = path.join(dir, "bundle");
  const logFile = path.join(dir, "build.log");

  try {
    await fsp.mkdir(source, { recursive: true });
    await fsp.mkdir(bundle, { recursive: true });

    extractZipSecurely(req.file.path, source);
    const projectRoot = await findGameProject(source);
    const project = parseGameProject(path.join(projectRoot, "game.project"));

    const report = {
      id,
      originalName: req.file.originalname,
      projectRoot: path.relative(source, projectRoot) || ".",
      projectName: project.project?.title || project.project?.name || "Unknown",
      version: project.project?.version || "Unknown",
      engine: project.project?.dependencies ? "external dependencies detected" : "standard",
      status: "building"
    };

    await fsp.writeFile(path.join(dir, "analysis.json"), JSON.stringify(report, null, 2));

    if (!fs.existsSync(BOB)) throw new Error(`bob.jar를 찾지 못했습니다: ${BOB}`);

    // Bob must build the project archive before bundling.
    await runBob(projectRoot, [
      "--platform", "wasm-web",
      "--variant", "debug",
      "--archive",
      "resolve",
      "build"
    ], logFile);

    await runBob(projectRoot, [
      "--platform", "wasm-web",
      "--variant", "debug",
      "--bundle-output", bundle,
      "bundle"
    ], logFile);

    const index = findIndexHtml(bundle);
    if (!index) throw new Error("HTML5 bundle에서 index.html을 찾지 못했습니다.");

    report.status = "ready";
    report.gameUrl = `/games/${id}/${path.relative(bundle, index).split(path.sep).join("/")}`;
    report.logUrl = `/api/jobs/${id}/log`;
    await fsp.writeFile(path.join(dir, "analysis.json"), JSON.stringify(report, null, 2));

    await fsp.rm(req.file.path, { force: true });
    res.json(report);
  } catch (err) {
    await fsp.rm(req.file.path, { force: true }).catch(() => {});
    const report = {
      id,
      status: "error",
      error: err.message,
      output: err.output ? err.output.slice(-30000) : ""
    };
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    await fsp.writeFile(path.join(dir, "analysis.json"), JSON.stringify(report, null, 2)).catch(() => {});
    res.status(422).json(report);
  }
});

app.get("/api/jobs/:id/log", async (req, res) => {
  try {
    const log = await fsp.readFile(path.join(jobDir(req.params.id), "build.log"), "utf8");
    res.type("text/plain").send(log);
  } catch {
    res.status(404).send("로그를 찾을 수 없습니다.");
  }
});

app.use("/games/:id", (req, res, next) => {
  const root = path.join(ROOT, "jobs", req.params.id, "bundle");
  if (!fs.existsSync(root)) return res.status(404).send("게임을 찾을 수 없습니다.");
  express.static(root)(req, res, next);
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `ZIP은 최대 ${MAX_UPLOAD_MB}MB까지 업로드할 수 있습니다.` });
  }
  res.status(400).json({ error: err.message || "요청 처리 중 오류가 발생했습니다." });
});

app.listen(PORT, () => {
  console.log(`Defold Web Tester: http://localhost:${PORT}`);
  console.log(`Bob: ${BOB} (${fs.existsSync(BOB) ? "found" : "MISSING"})`);
});
