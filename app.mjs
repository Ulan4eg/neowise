import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify as defaultClassify } from "./mock-ai.mjs";

const TOPICS = new Set(["delivery", "pricing", "other"]);
const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 64 * 1024;
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

const defaultHtml = await readFile(new URL("./index.html", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

// Возвращает строку тела запроса или null, если тело слишком большое.
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Возвращает text, если тело — JSON-объект с непустой строкой text, иначе null.
function parseText(raw) {
  if (raw === null) return null;
  try {
    const body = JSON.parse(raw);
    if (body && typeof body === "object" && typeof body.text === "string" && body.text.trim() !== "") {
      return body.text;
    }
  } catch {
    // битый JSON — обрабатывается как невалидный ввод
  }
  return null;
}

// Ждём модель не дольше timeoutMs. Сигнал отмены передаём модели, а Promise.race
// гарантирует ответ вовремя, даже если провайдер сигнал игнорирует.
async function askModel(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("model timeout"));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Ответ модели — недоверенные данные: проверяем форму, тему и черновик.
// Возвращает { topic, draft } или null, если ответ не подходит.
function parseModelAnswer(raw) {
  if (typeof raw !== "string") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { topic, draft } = data;
  if (typeof topic !== "string" || !TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft };
}

async function handleTriage(request, response, { classify, timeoutMs }) {
  const text = parseText(await readBody(request));
  if (text === null) return json(response, 400, { status: "invalid_input" });

  let answer = null;
  try {
    answer = parseModelAnswer(await askModel(classify, text, timeoutMs));
  } catch {
    answer = null; // таймаут или ошибка модели
  }
  if (answer === null) return json(response, 200, MANUAL_REVIEW);

  return json(response, 200, { status: "ready", topic: answer.topic, draft: answer.draft });
}

export function createApp({
  classify = defaultClassify,
  timeoutMs = MODEL_TIMEOUT_MS,
  html = defaultHtml,
} = {}) {
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
      await handleTriage(request, response, { classify, timeoutMs });
    } catch {
      if (!response.headersSent) json(response, 500, { status: "server_error" });
    }
  });
}
