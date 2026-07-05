const express = require("express");
const router = express.Router();
const { auth } = require("../middlewares/auth");

// TODO: Добавить контроллеры уведомлений
router.get("/:username", auth, (req, res) => {
    res.json({ message: "Get notifications" });
});

router.post("/", auth, (req, res) => {
    res.json({ message: "Create notification" });
});

router.put("/:id/read", auth, (req, res) => {
    res.json({ message: "Mark notification as read" });
});

module.exports = router;
