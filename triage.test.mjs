import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const server = createApp();
let baseUrl = "";

before(() => new Promise((resolve, reject) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("Server did not bind to a TCP port"));
      return;
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    resolve();
  });
}));

after(() => new Promise((resolve, reject) => {
  server.close((error) => (error ? reject(error) : resolve()));
}));

async function triage(body, { raw = false } = {}) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function unusedPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function waitForOutput(child, needle, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes(needle)) {
        cleanup();
        resolve(buf);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`process exited ${code}: ${buf}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${needle}: ${buf}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
}

function triageViaNodeHttp(url, jsonBody) {
  const body = JSON.stringify(jsonBody);
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("обычный текст возвращает ready с темой и черновиком", async () => {
  const { status, body } = await triage({ text: "Когда будет доставка заказа?" });
  assert.equal(status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "delivery");
  assert.equal(typeof body.draft, "string");
  assert.ok(body.draft.trim());
});

test("классификация тем: цена, доставка и прочее", async () => {
  const cases = [
    ["Сколько стоит товар?", "pricing"],
    ["Сколько стоит доставка?", "pricing"],
    ["Какая цена?", "pricing"],
    ["Какие у вас расценки?", "pricing"],
    ["Как оплатить заказ?", "pricing"],
    ["Когда будет доставка заказа?", "delivery"],
    ["Какой статус доставки?", "delivery"],
    ["Где мой заказ?", "delivery"],
    ["Нужна консультация", "other"],
  ];

  for (const [text, topic] of cases) {
    const { status, body } = await triage({ text });
    assert.equal(status, 200, text);
    assert.equal(body.status, "ready", text);
    assert.equal(body.topic, topic, text);
    assert.ok(["delivery", "pricing", "other"].includes(body.topic), text);
  }
});

test("Какая цена? возвращает в API topic=pricing, а не подпись из интерфейса", async () => {
  const { status, body } = await triage({ text: "Какая цена?" });
  assert.equal(status, 200);
  assert.equal(body.topic, "pricing");
  assert.notEqual(body.topic, "Стоимость");
});

test("hello через fetch возвращает HTTP 200 ready", async () => {
  const { status, body } = await triage({ text: "hello" });
  assert.equal(status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "other");
  assert.equal(typeof body.draft, "string");
  assert.ok(body.draft.trim());
});

test("hello через node:http возвращает HTTP 200 ready", async () => {
  const { status, body } = await triageViaNodeHttp(`${baseUrl}/api/triage`, { text: "hello" });
  assert.equal(status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "other");
});

test("JSON без кавычек вокруг ключей, как после PowerShell+curl, возвращает HTTP 400", async () => {
  const { status, body } = await triage("{text:hello}", { raw: true });
  assert.equal(status, 400);
  assert.deepEqual(body, { status: "invalid_input" });
});

test("процесс node server.mjs принимает { text: hello } по HTTP", async (t) => {
  const port = await unusedPort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill();
  });
  await waitForOutput(child, `http://127.0.0.1:${port}`);
  const response = await fetch(`http://127.0.0.1:${port}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ready",
    topic: "other",
    draft: "Спасибо за обращение. Уточним детали заявки.",
  });
});

test("пустая строка возвращает HTTP 400 invalid_input", async () => {
  const { status, body } = await triage({ text: "" });
  assert.equal(status, 400);
  assert.deepEqual(body, { status: "invalid_input" });
});

test("строка из пробелов возвращает HTTP 400 invalid_input", async () => {
  const { status, body } = await triage({ text: "   " });
  assert.equal(status, 400);
  assert.deepEqual(body, { status: "invalid_input" });
});

test("отсутствующий text возвращает HTTP 400 invalid_input", async () => {
  const { status, body } = await triage({});
  assert.equal(status, 400);
  assert.deepEqual(body, { status: "invalid_input" });
});

test("нестроковый text возвращает HTTP 400 invalid_input", async () => {
  const { status, body } = await triage({ text: 42 });
  assert.equal(status, 400);
  assert.deepEqual(body, { status: "invalid_input" });
});

test("некорректный JSON возвращает HTTP 400 invalid_input", async () => {
  const { status, body } = await triage("{", { raw: true });
  assert.equal(status, 400);
  assert.deepEqual(body, { status: "invalid_input" });
});

test("[timeout] переводит заявку в manual_review", async () => {
  const started = Date.now();
  const { status, body } = await triage({ text: "[timeout] Когда доставка?" });
  const elapsed = Date.now() - started;
  assert.equal(status, 200);
  assert.deepEqual(body, { status: "manual_review", topic: null, draft: null });
  assert.ok(elapsed < 1000, `таймаут занял слишком долго: ${elapsed}мс`);
});

test("[error] переводит заявку в manual_review", async () => {
  const { status, body } = await triage({ text: "[error] Нужна помощь" });
  assert.equal(status, 200);
  assert.deepEqual(body, { status: "manual_review", topic: null, draft: null });
});

test("[bad-json] переводит заявку в manual_review", async () => {
  const { status, body } = await triage({ text: "[bad-json] Нужна помощь" });
  assert.equal(status, 200);
  assert.deepEqual(body, { status: "manual_review", topic: null, draft: null });
});

test("[bad-topic] переводит заявку в manual_review", async () => {
  const { status, body } = await triage({ text: "[bad-topic] Нужна помощь" });
  assert.equal(status, 200);
  assert.deepEqual(body, { status: "manual_review", topic: null, draft: null });
});

test("[empty-draft] переводит заявку в manual_review", async () => {
  const { status, body } = await triage({ text: "[empty-draft] Нужна помощь" });
  assert.equal(status, 200);
  assert.deepEqual(body, { status: "manual_review", topic: null, draft: null });
});
