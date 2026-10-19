import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const port = 4731;
const base = `http://127.0.0.1:${port}`;
const repo = fileURLToPath(new URL("../", import.meta.url));
const child = spawn(process.execPath, ["app/server.mjs"], {
  cwd: repo,
  env: { ...process.env, PORT: String(port), COUNCIL_RUNNER: "viewer" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/api/seats`);
      if (r.ok) return r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become ready: ${stderr}`);
}

try {
  const data = await waitForServer();
  if (data.runner !== "viewer") throw new Error(`expected viewer runner, got ${data.runner}`);
  if (!Array.isArray(data.seats) || data.seats.length !== 7) throw new Error(`expected 7 seats, got ${data.seats?.length}`);
  console.log(`CI smoke OK: runner=${data.runner}, seats=${data.seats.length}`);
} finally {
  child.kill();
}
