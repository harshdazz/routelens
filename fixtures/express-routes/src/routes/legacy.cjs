// CommonJS router, mounted from an ES module.
const express = require("express");

const router = express.Router();

router.get("/status", (req, res) => {
  res.json({ ok: true });
});

router.post("/echo", (req, res) => {
  const { message } = req.body;
  res.json({ message });
});

module.exports = router;
