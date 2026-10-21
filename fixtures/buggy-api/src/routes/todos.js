const express = require("express");
const { NewTodo, TodoUpdate } = require("../schemas");

// Kept in memory: the list starts again when the server restarts.
const todos = [
  { id: 1, title: "Write the README", done: false },
  { id: 2, title: "Ship the first release", done: false },
];

const router = express.Router();

router.get("/", (req, res) => {
  res.json(todos);
});

router.post("/", (req, res) => {
  const input = NewTodo.parse(req.body);
  const todo = { id: todos.length + 1, title: input.title, done: false };
  todos.push(todo);
  res.status(201).json(todo);
});

router.get("/:id", (req, res) => {
  const todo = todos.find((item) => item.id === req.params.id);
  if (!todo) return res.status(404).json({ error: "Todo not found" });
  res.json(todo);
});

router.patch("/:id", (req, res) => {
  const todo = todos.find((item) => item.id === Number(req.params.id));
  if (!todo) return res.status(404).json({ error: "Todo not found" });
  Object.assign(todo, TodoUpdate.parse(req.body));
  res.json(todo);
});

router.delete("/:id", (req, res) => {
  const index = todos.findIndex((item) => item.id === Number(req.params.id));
  if (index === -1) return res.status(404).json({ error: "Todo not found" });
  todos.splice(index, 1);
  res.status(204).end();
});

module.exports = router;
