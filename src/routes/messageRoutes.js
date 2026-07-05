const express = require("express");
const router = express.Router();
const { auth } = require("../middlewares/auth");

// TODO: Добавить контроллеры сообщений
router.get("/", auth, (req, res) => {
    res.json({ message: "Get messages" });
});

router.post("/", auth, (req, res) => {
    res.json({ message: "Send message" });
});

module.exports = router;
