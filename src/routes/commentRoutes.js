const express = require("express");
const router = express.Router();
const { auth } = require("../middlewares/auth");

// TODO: Добавить контроллеры комментариев
router.get("/:postId", auth, (req, res) => {
    res.json({ message: "Get comments" });
});

router.post("/", auth, (req, res) => {
    res.json({ message: "Add comment" });
});

router.put("/:id", auth, (req, res) => {
    res.json({ message: "Update comment" });
});

router.delete("/:id", auth, (req, res) => {
    res.json({ message: "Delete comment" });
});

module.exports = router;
