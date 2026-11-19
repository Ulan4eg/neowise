import { createApp } from "./app.mjs";

const port = Number(process.env.PORT || 3000);
const server = createApp();

server.on("error", (error) => {
  console.error(
      error.code === "EADDRINUSE"
          ? `Порт ${port} занят. Запустите с другим портом: PORT=3001 node server.mjs`
          : error
  );
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Сервер запущен: http://127.0.0.1:${port}`);
});
