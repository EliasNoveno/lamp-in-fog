const express = require("express");
const router = express.Router();
const { auth } = require("../middlewares/auth");

// TODO: Добавить контроллеры сохранённых постов
router.get("/", auth, (req, res) => {
    res.json({ message: "Get saved posts" });
});

router.post("/", auth, (req, res) => {
    res.json({ message: "Toggle save" });
});

module.exports = router;
