import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

async function withServer(options, run) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(base, body) {
  const reply = await fetch(`${base}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: reply.status, body: await reply.json() };
}

test("корректный ответ модели: 200 и status ready", async () => {
  await withServer({}, async (base) => {
    const cases = [
      ["Какая стоимость доставки в Алматы?", "pricing"],
      ["Когда будет доставка?", "delivery"],
      ["Здравствуйте", "other"],
    ];
    for (const [text, topic] of cases) {
      const { status, body } = await post(base, { text });
      assert.equal(status, 200);
      assert.deepEqual(body, {
        status: "ready",
        topic,
        draft: "Спасибо за обращение. Уточним детали заявки.",
      });
    }
  });
});

test("невалидный ввод: 400 и invalid_input", async () => {
  await withServer({}, async (base) => {
    const bad = [
      "{ это не json",
      "",
      "null",
      "[]",
      '"text"',
      "{}",
      { text: "" },
      { text: "   \n\t" },
      { text: null },
      { text: 123 },
      { text: ["доставка"] },
      { text: { a: 1 } },
    ];
    for (const body of bad) {
      const result = await post(base, body);
      assert.equal(result.status, 400, `ожидали 400 для ${JSON.stringify(body)}`);
      assert.deepEqual(result.body, { status: "invalid_input" });
    }
  });
});

test("слишком большое тело запроса считается невалидным вводом", async () => {
  await withServer({}, async (base) => {
    const { status, body } = await post(base, { text: "а".repeat(200 * 1024) });
    assert.equal(status, 400);
    assert.deepEqual(body, { status: "invalid_input" });
  });
});

// Основной тест на сбои: каждая метка имитатора → 200 и manual_review.
for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`сбой модели ${marker}: 200 и manual_review без темы и черновика`, async () => {
    await withServer({}, async (base) => {
      const startedAt = Date.now();
      const { status, body } = await post(base, { text: `Доставка ${marker}` });
      const elapsed = Date.now() - startedAt;
      assert.equal(status, 200);
      assert.deepEqual(body, MANUAL_REVIEW);
      // Имитатор для [timeout] ждёт 1200 мс, мы должны ответить около 300 мс.
      assert.ok(elapsed < 900, `ответ занял ${elapsed} мс`);
    });
  });
}

test("модель, которая игнорирует отмену и зависает, не блокирует ответ", async () => {
  const hanging = () => new Promise(() => {});
  await withServer({ classify: hanging, timeoutMs: 50 }, async (base) => {
    const { status, body } = await post(base, { text: "привет" });
    assert.equal(status, 200);
    assert.deepEqual(body, MANUAL_REVIEW);
  });
});

test("неподходящие формы ответа модели дают manual_review", async () => {
  const answers = [
    "null",
    "[]",
    "42",
    '"строка"',
    "{}",
    JSON.stringify({ topic: "other" }),
    JSON.stringify({ draft: "Текст" }),
    JSON.stringify({ topic: "refund", draft: "Текст" }),
    JSON.stringify({ topic: null, draft: "Текст" }),
    JSON.stringify({ topic: ["other"], draft: "Текст" }),
    JSON.stringify({ topic: "other", draft: "" }),
    JSON.stringify({ topic: "other", draft: "   " }),
    JSON.stringify({ topic: "other", draft: 5 }),
    JSON.stringify({ topic: "other", draft: { text: "Текст" } }),
    { topic: "other", draft: "Текст" }, // не строка, а объект
    undefined,
  ];
  for (const answer of answers) {
    await withServer({ classify: async () => answer }, async (base) => {
      const { status, body } = await post(base, { text: "привет" });
      assert.equal(status, 200, `ответ модели: ${JSON.stringify(answer)}`);
      assert.deepEqual(body, MANUAL_REVIEW, `ответ модели: ${JSON.stringify(answer)}`);
    });
  }
});

test("синхронное исключение в модели тоже даёт manual_review", async () => {
  const throwing = () => {
    throw new Error("boom");
  };
  await withServer({ classify: throwing }, async (base) => {
    const { status, body } = await post(base, { text: "привет" });
    assert.equal(status, 200);
    assert.deepEqual(body, MANUAL_REVIEW);
  });
});

test("в ответе ready нет лишних полей из ответа модели", async () => {
  const noisy = async () =>
    JSON.stringify({ topic: "delivery", draft: "Привезём завтра.", secret: "x", status: "hacked" });
  await withServer({ classify: noisy }, async (base) => {
    const { status, body } = await post(base, { text: "привет" });
    assert.equal(status, 200);
    assert.deepEqual(body, { status: "ready", topic: "delivery", draft: "Привезём завтра." });
  });
});

test("неизвестные маршруты по-прежнему отдают 404", async () => {
  await withServer({}, async (base) => {
    const reply = await fetch(`${base}/nope`);
    assert.equal(reply.status, 404);
    assert.deepEqual(await reply.json(), { status: "not_found" });
  });
});
