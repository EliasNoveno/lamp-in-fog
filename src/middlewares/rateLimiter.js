const rateLimit = require('express-rate-limit');

// Глобальный лимит для всех запросов
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 200, // максимум 200 запросов за 15 минут
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Строгий лимит для авторизации (защита от брутфорса)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 5, // всего 5 попыток входа за 15 минут
    message: { error: 'Too many login attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Лимит для загрузки файлов
const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 час
    max: 20, // 20 загрузок в час
    message: { error: 'Upload limit exceeded. Please try again in an hour.' },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = {
    global: globalLimiter,
    auth: authLimiter,
    upload: uploadLimiter
};
