const express = require('express');
const router = express.Router();
const { auth } = require('../middlewares/auth');
const rateLimiter = require('../middlewares/rateLimiter');
const authController = require('../controllers/authController');

// Используем authLimiter для защиты от брутфорса
router.post('/register', rateLimiter.auth, authController.register);
router.post('/login', rateLimiter.auth, authController.login);
router.post('/logout', auth, authController.logout);
router.post('/change-password', auth, authController.changePassword);

module.exports = router;
