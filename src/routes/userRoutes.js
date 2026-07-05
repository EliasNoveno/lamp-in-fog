const express = require("express");
const router = express.Router();
const { auth, admin } = require("../middlewares/auth");

// TODO: Добавить контроллеры пользователей
router.get("/", auth, (req, res) => {
    res.json({ message: "Users route" });
});

router.put("/:id", auth, admin, (req, res) => {
    res.json({ message: "Update user" });
});

router.delete("/:id", auth, admin, (req, res) => {
    res.json({ message: "Delete user" });
});

module.exports = router;
