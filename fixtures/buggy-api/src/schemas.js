const { z } = require("zod");

const NewTodo = z.object({
  title: z.string().min(1).max(200),
});

const TodoUpdate = z.object({
  title: z.string().min(1).max(200).optional(),
  done: z.boolean().optional(),
});

module.exports = { NewTodo, TodoUpdate };
