const express = require("express");
const todos = require("./routes/todos");

const app = express();
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.use("/api/todos", todos);

app.listen(3456, () => {
  console.log("Todo API on http://localhost:3456");
});
