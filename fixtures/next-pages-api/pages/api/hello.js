// No method checks: answers every method.
export default function handler(req, res) {
  res.status(200).json({ hello: "world" });
}
