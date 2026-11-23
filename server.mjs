import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);
const MODEL_TIMEOUT_MS = 300;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function manualReview() {
  return { status: "manual_review", topic: null, draft: null };
}

function parseModelOutput(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    parsed == null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !ALLOWED_TOPICS.has(parsed.topic) ||
    typeof parsed.draft !== "string" ||
    parsed.draft.trim() === ""
  ) {
    return null;
  }

  return { topic: parsed.topic, draft: parsed.draft };
}

async function runModel(text) {
  const controller = new AbortController();
  let timeoutId;

  const classifyPromise = classify(text, { signal: controller.signal }).then(
    (raw) => ({ ok: true, raw }),
    () => ({ ok: false }),
  );

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      resolve({ ok: false });
    }, MODEL_TIMEOUT_MS);
  });

  const outcome = await Promise.race([classifyPromise, timeoutPromise]);
  clearTimeout(timeoutId);

  if (!outcome.ok) {
    return null;
  }

  return parseModelOutput(outcome.raw);
}

async function handleTriage(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);

  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }

  if (
    payload == null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.text !== "string" ||
    payload.text.trim() === ""
  ) {
    return json(response, 400, { status: "invalid_input" });
  }

  const model = await runModel(payload.text);
  if (!model) {
    return json(response, 200, manualReview());
  }

  return json(response, 200, {
    status: "ready",
    topic: model.topic,
    draft: model.draft,
  });
}

export function createApp() {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

const thisFile = path.resolve(fileURLToPath(import.meta.url));
const launchedAsMain = process.argv[1] && thisFile === path.resolve(process.argv[1]);

if (launchedAsMain) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`http://127.0.0.1:${port}`);
  });
}
