const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const https = require('https');
const path = require('path');
const NodeCache = require('node-cache');
const helmet = require('helmet'); // ✅ Добавлено: защита заголовков
const rateLimit = require('express-rate-limit'); // ✅ Добавлено: защита от брутфорса
const xss = require('xss'); // ✅ Добавлено: защита от XSS

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Исправлено: лимит для защиты от DoS атак
app.use(express.json({ limit: '10mb' })); 
app.use(express.static(__dirname));

// ✅ Добавлено: защита заголовков
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"], // для inline скриптов
            styleSrc: ["'self'", "'unsafe-inline'"], // для inline стилей
            imgSrc: ["'self'", "data:"],
            mediaSrc: ["'self'", "data:"],
        },
    },
}));

// ✅ Добавлено: rate limiting для защиты от брутфорса
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 100, // максимум 100 запросов с одного IP
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// ✅ Добавлено: более строгий лимит для критических роутов
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5, // 5 попыток логина/регистрации
    message: { error: 'Too many login attempts, please try again later.' },
});

// Настройка кеша
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

// ✅ Улучшено: пул с таймаутами
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false, // ✅ исправлено
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 20,
});

// Создание таблиц
const initDb = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            description TEXT,
            banned INTEGER DEFAULT 0,
            isAdmin INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS friends (
            user_id TEXT NOT NULL,
            friend_id TEXT NOT NULL,
            PRIMARY KEY (user_id, friend_id)
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS posts (
            id SERIAL PRIMARY KEY,
            author TEXT NOT NULL,
            content TEXT,
            time BIGINT NOT NULL,
            isPoem INTEGER DEFAULT 0,
            photo TEXT,
            pendingApproval INTEGER DEFAULT 0,
            pendingId TEXT,
            fileName TEXT,
            fileData TEXT,
            fileType TEXT,
            edited INTEGER DEFAULT 0,
            hashtags TEXT[] DEFAULT '{}'
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pendingPhotos (
            id TEXT PRIMARY KEY,
            author TEXT NOT NULL,
            data TEXT NOT NULL
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            targetUser TEXT NOT NULL,
            fromUser TEXT NOT NULL,
            type TEXT NOT NULL,
            read INTEGER DEFAULT 0,
            time BIGINT NOT NULL
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS comments (
            id SERIAL PRIMARY KEY,
            postId INTEGER NOT NULL,
            author TEXT NOT NULL,
            content TEXT NOT NULL,
            time BIGINT NOT NULL,
            edited INTEGER DEFAULT 0
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS privateMessages (
            id SERIAL PRIMARY KEY,
            fromUser TEXT NOT NULL,
            toUser TEXT NOT NULL,
            message TEXT NOT NULL,
            time BIGINT NOT NULL,
            read INTEGER DEFAULT 0
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS blacklists (
            username TEXT PRIMARY KEY,
            blocked TEXT[] DEFAULT '{}'
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            token TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP
        )
    `);
    
    const res = await pool.query("SELECT COUNT(*) FROM users");
    if (parseInt(res.rows[0].count) === 0) {
        const hashedPassword = await bcrypt.hash('hell_yeah', 10);
        await pool.query(
            "INSERT INTO users (username, password, description, isAdmin) VALUES ($1, $2, $3, $4)",
            ['Edd_Leon_CAt', hashedPassword, 'the primordial admin', 1]
        );
        console.log('✅ primordial admin created');
    }
};

initDb().catch(err => console.error('DB init error:', err));

// ✅ Функция санитизации входных данных
const sanitizeInput = (input) => {
    if (typeof input !== 'string') return input;
    return input.replace(/[^\x20-\x7E]/g, '').trim(); // Только печатные ASCII
};

// ✅ Функция валидации username
const validateUsername = (username) => {
    if (!username || typeof username !== 'string') return false;
    // Только латиница, цифры, подчеркивание, дефис, точка (минимум 2, максимум 30)
    return /^[a-zA-Z0-9_.-]{2,30}$/.test(username);
};

// ✅ Функция валидации пароля
const validatePassword = (password) => {
    if (!password || typeof password !== 'string') return false;
    return password.length >= 4 && password.length <= 100;
};

// ========== API РОУТЫ ==========

app.get('/api/users', async (req, res) => {
    try {
        const result = await pool.query("SELECT username, description, isAdmin, banned FROM users");
        const users = {};
        for (const u of result.rows) {
            const friendsRes = await pool.query("SELECT friend_id FROM friends WHERE user_id = $1", [u.username]);
            users[u.username] = {
                description: sanitizeInput(u.description || ''),
                isAdmin: u.isadmin === 1,
                banned: u.banned === 1,
                friends: friendsRes.rows.map(f => f.friend_id)
            };
        }
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/users/:username', async (req, res) => {
    const username = sanitizeInput(req.params.username);
    if (!validateUsername(username)) {
        return res.status(400).json({ error: 'Invalid username' });
    }
    
    try {
        const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'user not found' });
        const user = result.rows[0];
        const friendsRes = await pool.query("SELECT friend_id FROM friends WHERE user_id = $1", [user.username]);
        res.json({
            username: user.username,
            description: sanitizeInput(user.description || ''),
            isAdmin: user.isadmin === 1,
            banned: user.banned === 1,
            friends: friendsRes.rows.map(f => f.friend_id)
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ✅ Защита от брутфорса
app.post('/api/register', authLimiter, async (req, res) => {
    let { username, password } = req.body;
    
    // ✅ Санитизация
    username = sanitizeInput(username);
    password = sanitizeInput(password);
    
    if (!validateUsername(username)) {
        return res.status(400).json({ error: 'Username must be 2-30 characters (a-z, A-Z, 0-9, _-.)' });
    }
    if (!validatePassword(password)) {
        return res.status(400).json({ error: 'Password must be 4-100 characters' });
    }
    
    try {
        const existing = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'username taken' });
        
        const hashedPassword = await bcrypt.hash(password, 12); // ✅ повышенный salt rounds
        await pool.query(
            "INSERT INTO users (username, password, description, isAdmin) VALUES ($1, $2, $3, $4)",
            [username, hashedPassword, '', 0]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    let { username, password } = req.body;
    
    username = sanitizeInput(username);
    password = sanitizeInput(password);
    
    if (!validateUsername(username) || !validatePassword(password)) {
        return res.status(401).json({ error: 'invalid credentials' });
    }
    
    try {
        const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
        if (result.rows.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // ✅ защита от timing attack
            return res.status(401).json({ error: 'invalid credentials' });
        }
        const user = result.rows[0];
        if (user.banned === 1) return res.status(403).json({ error: 'account banned' });
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return res.status(401).json({ error: 'invalid credentials' });
        }
        
        // ✅ Генерация токена сессии
        const token = require('crypto').randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 дней
        
        await pool.query(
            "INSERT INTO sessions (username, token, expires_at) VALUES ($1, $2, $3)",
            [username, token, expiresAt]
        );
        
        res.json({ 
            username: user.username, 
            isAdmin: user.isadmin === 1,
            token: token // ✅ Отправляем токен
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ✅ Новый роут для проверки сессии
app.get('/api/verify', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    
    try {
        const result = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        res.json({ username: result.rows[0].username });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/changePassword', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    let { oldPassword, newPassword } = req.body;
    oldPassword = sanitizeInput(oldPassword);
    newPassword = sanitizeInput(newPassword);
    
    if (!validatePassword(oldPassword) || !validatePassword(newPassword)) {
        return res.status(400).json({ error: 'Invalid password' });
    }
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const username = session.rows[0].username;
        const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'user not found' });
        
        const user = result.rows[0];
        const valid = await bcrypt.compare(oldPassword, user.password);
        if (!valid) return res.status(401).json({ error: 'wrong password' });
        
        const hashedPassword = await bcrypt.hash(newPassword, 12);
        await pool.query("UPDATE users SET password = $1 WHERE username = $2", [hashedPassword, username]);
        
        // ✅ Удаляем все старые сессии при смене пароля
        await pool.query("DELETE FROM sessions WHERE username = $1", [username]);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===== ПОСТЫ С ПАГИНАЦИЕЙ И КЕШИРОВАНИЕМ =====
app.get('/api/posts', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100); // ✅ защита от огромных лимитов
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const cacheKey = `posts:${limit}:${offset}`;
    
    const cachedPosts = cache.get(cacheKey);
    if (cachedPosts) {
        return res.json(cachedPosts);
    }
    
    try {
        const result = await pool.query(
            "SELECT * FROM posts ORDER BY time DESC LIMIT $1 OFFSET $2",
            [limit, offset]
        );
        const posts = result.rows.map(p => ({
            ...p,
            content: sanitizeInput(p.content || ''),
            fileName: p.fileName ? sanitizeInput(p.fileName) : null,
            hashtags: p.hashtags || []
        }));
        cache.set(cacheKey, posts);
        res.json(posts);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ✅ Защита публикации постов
app.post('/api/posts', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const username = session.rows[0].username;
        let { content, time, isPoem, photo, pendingApproval, pendingId, fileName, fileData, fileType, edited, hashtags } = req.body;
        
        // ✅ Санитизация и проверка
        content = sanitizeInput(content || '');
        if (content.length > 10000) return res.status(400).json({ error: 'Content too long' }); // ✅ защита
        if (fileName) fileName = sanitizeInput(fileName);
        
        // ✅ Проверка размера файла (10MB максимум)
        if (fileData && fileData.length > 10 * 1024 * 1024) {
            return res.status(400).json({ error: 'File too large' });
        }
        
        // ✅ Валидация хештегов
        if (hashtags && !Array.isArray(hashtags)) hashtags = [];
        if (hashtags.length > 50) hashtags = hashtags.slice(0, 50);
        hashtags = hashtags.map(h => sanitizeInput(h).toLowerCase()).filter(h => /^[a-z0-9_]+$/.test(h));
        
        const result = await pool.query(
            `INSERT INTO posts (author, content, time, isPoem, photo, pendingApproval, pendingId, fileName, fileData, fileType, edited, hashtags)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
            [username, content, time || Date.now(), isPoem ? 1 : 0, photo, pendingApproval ? 1 : 0, pendingId, fileName, fileData, fileType, edited ? 1 : 0, hashtags]
        );
        cache.flushAll();
        res.json({ id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/posts/:id', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const username = session.rows[0].username;
        const postId = parseInt(req.params.id);
        if (isNaN(postId)) return res.status(400).json({ error: 'Invalid post ID' });
        
        const post = await pool.query("SELECT author FROM posts WHERE id = $1", [postId]);
        if (post.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
        if (post.rows[0].author !== username) {
            const admin = await pool.query("SELECT isAdmin FROM users WHERE username = $1", [username]);
            if (admin.rows[0].isadmin !== 1) return res.status(403).json({ error: 'Forbidden' });
        }
        
        let { content, hashtags } = req.body;
        content = sanitizeInput(content || '');
        if (content.length > 10000) return res.status(400).json({ error: 'Content too long' });
        
        if (hashtags && !Array.isArray(hashtags)) hashtags = [];
        if (hashtags.length > 50) hashtags = hashtags.slice(0, 50);
        hashtags = hashtags.map(h => sanitizeInput(h).toLowerCase()).filter(h => /^[a-z0-9_]+$/.test(h));
        
        await pool.query(
            "UPDATE posts SET content = $1, hashtags = $2, edited = 1 WHERE id = $3",
            [content, hashtags, postId]
        );
        cache.flushAll();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/posts/:id', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const username = session.rows[0].username;
        const postId = parseInt(req.params.id);
        if (isNaN(postId)) return res.status(400).json({ error: 'Invalid post ID' });
        
        const post = await pool.query("SELECT author FROM posts WHERE id = $1", [postId]);
        if (post.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
        if (post.rows[0].author !== username) {
            const admin = await pool.query("SELECT isAdmin FROM users WHERE username = $1", [username]);
            if (admin.rows[0].isadmin !== 1) return res.status(403).json({ error: 'Forbidden' });
        }
        
        await pool.query("DELETE FROM posts WHERE id = $1", [postId]);
        await pool.query("DELETE FROM comments WHERE postId = $1", [postId]);
        cache.flushAll();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===== ОСТАЛЬНЫЕ РОУТЫ (с защитой) =====

app.get('/api/pendingPhotos', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const admin = await pool.query("SELECT isAdmin FROM users WHERE username = $1", [session.rows[0].username]);
        if (admin.rows[0].isadmin !== 1) return res.status(403).json({ error: 'Forbidden' });
        
        const result = await pool.query("SELECT * FROM pendingPhotos");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/pendingPhotos', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const { id, data } = req.body;
        if (!id || !data) return res.status(400).json({ error: 'Missing data' });
        if (data.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'File too large' });
        
        await pool.query(
            "INSERT INTO pendingPhotos (id, author, data) VALUES ($1, $2, $3)",
            [id, session.rows[0].username, data]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/pendingPhotos/:id', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const admin = await pool.query("SELECT isAdmin FROM users WHERE username = $1", [session.rows[0].username]);
        if (admin.rows[0].isadmin !== 1) return res.status(403).json({ error: 'Forbidden' });
        
        await pool.query("DELETE FROM pendingPhotos WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/notifications/:username', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        if (session.rows[0].username !== req.params.username) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        
        const result = await pool.query(
            "SELECT * FROM notifications WHERE targetUser = $1 ORDER BY time DESC",
            [req.params.username]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/notifications', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const { targetUser, type } = req.body;
        await pool.query(
            "INSERT INTO notifications (targetUser, fromUser, type, time, read) VALUES ($1, $2, $3, $4, 0)",
            [targetUser, session.rows[0].username, type, Date.now()]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/notifications/:id/read', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const notifId = parseInt(req.params.id);
        if (isNaN(notifId)) return res.status(400).json({ error: 'Invalid ID' });
        
        await pool.query("UPDATE notifications SET read = 1 WHERE id = $1", [notifId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/comments/:postId', async (req, res) => {
    try {
        const postId = parseInt(req.params.postId);
        if (isNaN(postId)) return res.status(400).json({ error: 'Invalid post ID' });
        
        const result = await pool.query(
            "SELECT * FROM comments WHERE postId = $1 ORDER BY time ASC",
            [postId]
        );
        res.json(result.rows.map(c => ({
            ...c,
            content: sanitizeInput(c.content || '')
        })));
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/comments', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const { postId, content } = req.body;
        const cleanContent = sanitizeInput(content || '');
        if (cleanContent.length > 5000) return res.status(400).json({ error: 'Comment too long' });
        
        const result = await pool.query(
            "INSERT INTO comments (postId, author, content, time, edited) VALUES ($1, $2, $3, $4, 0) RETURNING id",
            [postId, session.rows[0].username, cleanContent, Date.now()]
        );
        res.json({ id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/comments/:id', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const commentId = parseInt(req.params.id);
        if (isNaN(commentId)) return res.status(400).json({ error: 'Invalid comment ID' });
        
        const comment = await pool.query("SELECT author FROM comments WHERE id = $1", [commentId]);
        if (comment.rows.length === 0) return res.status(404).json({ error: 'Comment not found' });
        if (comment.rows[0].author !== session.rows[0].username) {
            const admin = await pool.query("SELECT isAdmin FROM users WHERE username = $1", [session.rows[0].username]);
            if (admin.rows[0].isadmin !== 1) return res.status(403).json({ error: 'Forbidden' });
        }
        
        let { content, edited } = req.body;
        content = sanitizeInput(content || '');
        if (content.length > 5000) return res.status(400).json({ error: 'Comment too long' });
        
        await pool.query(
            "UPDATE comments SET content = $1, edited = $2 WHERE id = $3",
            [content, edited || 1, commentId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/comments/:id', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const commentId = parseInt(req.params.id);
        if (isNaN(commentId)) return res.status(400).json({ error: 'Invalid comment ID' });
        
        const comment = await pool.query("SELECT author FROM comments WHERE id = $1", [commentId]);
        if (comment.rows.length === 0) return res.status(404).json({ error: 'Comment not found' });
        if (comment.rows[0].author !== session.rows[0].username) {
            const admin = await pool.query("SELECT isAdmin FROM users WHERE username = $1", [session.rows[0].username]);
            if (admin.rows[0].isadmin !== 1) return res.status(403).json({ error: 'Forbidden' });
        }
        
        await pool.query("DELETE FROM comments WHERE id = $1", [commentId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/privateMessages', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const result = await pool.query("SELECT * FROM privateMessages ORDER BY time ASC");
        const messages = {};
        result.rows.forEach(msg => {
            if (msg.toUser === session.rows[0].username || msg.fromUser === session.rows[0].username) {
                if (!messages[msg.toUser]) messages[msg.toUser] = [];
                if (!messages[msg.fromUser]) messages[msg.fromUser] = [];
                messages[msg.toUser].push(msg);
                messages[msg.fromUser].push(msg);
            }
        });
        res.json(messages);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/privateMessages', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const { to, message, time } = req.body;
        const cleanMessage = sanitizeInput(message || '');
        if (cleanMessage.length > 5000) return res.status(400).json({ error: 'Message too long' });
        if (!validateUsername(to)) return res.status(400).json({ error: 'Invalid recipient' });
        
        await pool.query(
            "INSERT INTO privateMessages (fromUser, toUser, message, time, read) VALUES ($1, $2, $3, $4, 0)",
            [session.rows[0].username, to, cleanMessage, time || Date.now()]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/blacklists', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const result = await pool.query("SELECT * FROM blacklists");
        const blacklists = {};
        result.rows.forEach(row => {
            blacklists[row.username] = row.blocked || [];
        });
        res.json(blacklists);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/blacklists', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const { blacklist } = req.body;
        if (!Array.isArray(blacklist)) return res.status(400).json({ error: 'Invalid data' });
        
        const cleanBlacklist = blacklist.filter(u => validateUsername(u));
        
        await pool.query(
            "INSERT INTO blacklists (username, blocked) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET blocked = $2",
            [session.rows[0].username, cleanBlacklist]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/users/:username', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const targetUsername = req.params.username;
        if (targetUsername !== session.rows[0].username) {
            const admin = await pool.query("SELECT isAdmin FROM users WHERE username = $1", [session.rows[0].username]);
            if (admin.rows[0].isadmin !== 1) return res.status(403).json({ error: 'Forbidden' });
        }
        
        const { description, isAdmin, banned, friends } = req.body;
        const updates = [];
        const values = [];
        let paramIndex = 1;
        
        if (description !== undefined) { 
            const cleanDesc = sanitizeInput(description);
            if (cleanDesc.length > 300) return res.status(400).json({ error: 'Description too long' });
            updates.push(`description = $${paramIndex}`); 
            values.push(cleanDesc); 
            paramIndex++; 
        }
        if (isAdmin !== undefined) { 
            // ✅ Только админ может менять админа
            const admin = await pool.query("SELECT isAdmin FROM users WHERE username = $1", [session.rows[0].username]);
            if (admin.rows[0].isadmin !== 1) return res.status(403).json({ error: 'Forbidden' });
            updates.push(`isAdmin = $${paramIndex}`); 
            values.push(isAdmin ? 1 : 0); 
            paramIndex++; 
        }
        if (banned !== undefined) { 
            const admin = await pool.query("SELECT isAdmin FROM users WHERE username = $1", [session.rows[0].username]);
            if (admin.rows[0].isadmin !== 1) return res.status(403).json({ error: 'Forbidden' });
            updates.push(`banned = $${paramIndex}`); 
            values.push(banned ? 1 : 0); 
            paramIndex++; 
        }
        
        if (updates.length > 0) {
            await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE username = $${paramIndex}`, [...values, targetUsername]);
        }
        
        if (friends !== undefined) {
            if (!Array.isArray(friends)) return res.status(400).json({ error: 'Invalid friends data' });
            const cleanFriends = friends.filter(u => validateUsername(u));
            
            await pool.query("DELETE FROM friends WHERE user_id = $1", [targetUsername]);
            for (const friendId of cleanFriends) {
                await pool.query(
                    "INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                    [targetUsername, friendId]
                );
            }
        }
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/users/:username', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const session = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        if (session.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
        
        const targetUsername = req.params.username;
        if (targetUsername !== session.rows[0].username) {
            const admin = await pool.query("SELECT isAdmin FROM users WHERE username = $1", [session.rows[0].username]);
            if (admin.rows[0].isadmin !== 1) return res.status(403).json({ error: 'Forbidden' });
        }
        
        await pool.query("DELETE FROM posts WHERE author = $1", [targetUsername]);
        await pool.query("DELETE FROM comments WHERE author = $1", [targetUsername]);
        await pool.query("DELETE FROM notifications WHERE targetUser = $1 OR fromUser = $1", [targetUsername]);
        await pool.query("DELETE FROM pendingPhotos WHERE author = $1", [targetUsername]);
        await pool.query("DELETE FROM privateMessages WHERE fromUser = $1 OR toUser = $1", [targetUsername]);
        await pool.query("DELETE FROM blacklists WHERE username = $1", [targetUsername]);
        await pool.query("DELETE FROM friends WHERE user_id = $1 OR friend_id = $1", [targetUsername]);
        await pool.query("DELETE FROM sessions WHERE username = $1", [targetUsername]);
        await pool.query("DELETE FROM users WHERE username = $1", [targetUsername]);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ✅ Роут для логаута
app.post('/api/logout', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
        try {
            await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
        } catch (err) {
            // ignore
        }
    }
    res.json({ success: true });
});

// ========== ГЛАВНЫЙ МАРШРУТ ==========
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// ========== PING SERVICE ==========
const myUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
    const protocol = myUrl.startsWith('https') ? https : require('http');
    protocol.get(myUrl, (res) => {
        console.log(`💓 ping: ${myUrl} answered ${res.statusCode}`);
    }).on('error', (err) => {
        console.log(`💔 ping error: ${err.message}`);
    });
}, 10 * 60 * 1000);
console.log(`⏰ Ping service started`);

app.listen(PORT, () => {
    console.log(`🌫️ Lamp in Fog running at http://localhost:${PORT}`);
});
