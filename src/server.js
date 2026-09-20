const express = require("express");
const config = require("./config");
const db = require("./db");
const routes = require("./routes");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));

// nginx forwards /chat-ai/ as-is
app.use("/chat-ai", routes);

app.use((err, req, res, next) => {
  console.log("[error]", err.message);
  if (!res.headersSent) {
    if (err.code === "AUTH_UNAVAILABLE") res.status(502).json({ error: "AUTH_UNAVAILABLE" });
    else res.status(500).json({ error: "INTERNAL" });
  }
});

db.connect()
  .then(() => {
    app.listen(config.port, () => console.log(`chat_with_actor listening on ${config.port}`));
  })
  .catch((error) => {
    console.error("startup failed:", error.message);
    process.exit(1);
  });
