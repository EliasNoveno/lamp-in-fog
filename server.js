const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const https = require('https');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== БЕЗОПАСНОСТЬ =====
// Защита заголовков
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:"],
            mediaSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
        },
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    }
}));

// Лимиты запросов
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests' }
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many login attempts' }
});

app.use(limiter);
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// ===== БАЗА ДАННЫХ =====
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 20,
});

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====
const sanitize = (input) => {
    if (typeof input !== 'string') return input;
    return input.replace(/[^\x20-\x7E\u0400-\u04FF]/g, '').trim();
};

const validateUsername = (username) => {
    if (!username || typeof username !== 'string') return false;
    return /^[a-zA-Z0-9_.-]{2,30}$/.test(username);
};

const validatePassword = (password) => {
    if (!password || typeof password !== 'string') return false;
    return password.length >= 8 && password.length <= 100;
};

const generateToken = () => crypto.randomBytes(64).toString('hex');

// ===== ИНИЦИАЛИЗАЦИЯ БД =====
const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password TEXT NOT NULL,
                description TEXT DEFAULT '',
                banned INTEGER DEFAULT 0,
                isAdmin INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                token TEXT NOT NULL UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL
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
        
        // Создаем админа если нет
        const res = await pool.query("SELECT COUNT(*) FROM users");
        if (parseInt(res.rows[0].count) === 0) {
            const hashedPassword = await bcrypt.hash('hell_yeah', 12);
            await pool.query(
                "INSERT INTO users (username, password, description, isAdmin) VALUES ($1, $2, $3, $4)",
                ['Edd_Leon_CAt', hashedPassword, 'the primordial admin', 1]
            );
            console.log('✅ Primordial admin created');
        }
    } catch (err) {
        console.error('DB init error:', err);
    }
};

initDb();

// ===== МИДЛВЭР АУТЕНТИФИКАЦИИ =====
const authenticate = async (req) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return null;
    
    const result = await pool.query(
        "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
        [token]
    );
    
    return result.rows[0] || null;
};

// ===== API РОУТЫ =====

// Users
app.get('/api/users', async (req, res) => {
    try {
        const result = await pool.query("SELECT username, description, isAdmin, banned FROM users");
        const users = {};
        for (const u of result.rows) {
            const friendsRes = await pool.query("SELECT friend_id FROM friends WHERE user_id = $1", [u.username]);
            users[u.username] = {
                description: sanitize(u.description || ''),
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

// Register
app.post('/api/register', authLimiter, async (req, res) => {
    let { username, password } = req.body;
    username = sanitize(username);
    password = sanitize(password);
    
    if (!validateUsername(username) || !validatePassword(password)) {
        return res.status(400).json({ error: 'Invalid username or password' });
    }
    
    try {
        const existing = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Username taken' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 12);
        await pool.query(
            "INSERT INTO users (username, password, description, isAdmin) VALUES ($1, $2, $3, $4)",
            [username, hashedPassword, '', 0]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Login
app.post('/api/login', authLimiter, async (req, res) => {
    let { username, password } = req.body;
    username = sanitize(username);
    password = sanitize(password);
    
    if (!validateUsername(username) || !validatePassword(password)) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    try {
        const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
        if (result.rows.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        if (user.banned === 1) {
            return res.status(403).json({ error: 'Account banned' });
        }
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Создаем сессию
        const token = generateToken();
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        
        await pool.query(
            "INSERT INTO sessions (username, token, expires_at) VALUES ($1, $2, $3)",
            [username, token, expiresAt]
        );
        
        res.json({ 
            username: user.username, 
            isAdmin: user.isadmin === 1,
            token: token
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Logout
app.post('/api/logout', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
        try {
            await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
        } catch (err) {}
    }
    res.json({ success: true });
});

// Change password
app.post('/api/changePassword', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    let { oldPassword, newPassword } = req.body;
    oldPassword = sanitize(oldPassword);
    newPassword = sanitize(newPassword);
    
    if (!validatePassword(oldPassword) || !validatePassword(newPassword)) {
        return res.status(400).json({ error: 'Invalid password' });
    }
    
    try {
        const result = await pool.query("SELECT * FROM users WHERE username = $1", [session.username]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        
        const user = result.rows[0];
        const valid = await bcrypt.compare(oldPassword, user.password);
        if (!valid) return res.status(401).json({ error: 'Wrong password' });
        
        const hashedPassword = await bcrypt.hash(newPassword, 12);
        await pool.query("UPDATE users SET password = $1 WHERE username = $2", [hashedPassword, session.username]);
        
        // Удаляем все старые сессии
        await pool.query("DELETE FROM sessions WHERE username = $1", [session.username]);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Posts
app.get('/api/posts', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    
    try {
        const result = await pool.query(
            "SELECT * FROM posts ORDER BY time DESC LIMIT $1 OFFSET $2",
            [limit, offset]
        );
        const posts = result.rows.map(p => ({
            ...p,
            content: sanitize(p.content || ''),
            fileName: p.fileName ? sanitize(p.fileName) : null,
            hashtags: p.hashtags || []
        }));
        res.json(posts);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/posts', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        let { content, time, isPoem, photo, pendingApproval, pendingId, fileName, fileData, fileType, hashtags } = req.body;
        
        content = sanitize(content || '');
        if (content.length > 10000) return res.status(400).json({ error: 'Content too long' });
        
        if (fileData && Buffer.byteLength(fileData, 'utf8') > 10 * 1024 * 1024) {
            return res.status(400).json({ error: 'File too large' });
        }
        
        if (hashtags) {
            if (!Array.isArray(hashtags)) hashtags = [];
            hashtags = hashtags.slice(0, 30).map(h => sanitize(h).toLowerCase()).filter(h => /^[a-z0-9_]+$/.test(h));
        } else {
            hashtags = [];
        }
        
        const result = await pool.query(
            `INSERT INTO posts (author, content, time, isPoem, photo, pendingApproval, pendingId, fileName, fileData, fileType, hashtags)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
            [session.username, content, time || Date.now(), isPoem ? 1 : 0, photo, pendingApproval ? 1 : 0, pendingId, fileName, fileData, fileType, hashtags]
        );
        res.json({ id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/posts/:id', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const postId = parseInt(req.params.id);
        if (isNaN(postId)) return res.status(400).json({ error: 'Invalid post ID' });
        
        const post = await pool.query("SELECT author FROM posts WHERE id = $1", [postId]);
        if (post.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
        
        if (post.rows[0].author !== session.username) {
            const admin = await pool.query("SELECT isAdmin FROM users WHERE username = $1", [session.username]);
            if (admin.rows[0].isadmin !== 1) return res.status(403).json({ error: 'Forbidden' });
        }
        
        let { content, hashtags } = req.body;
        content = sanitize(content || '');
        if (content.length > 10000) return res.status(400).json({ error: 'Content too long' });
        
        if (hashtags) {
            if (!Array.isArray(hashtags)) hashtags = [];
            hashtags = hashtags.slice(0, 30).map(h => sanitize(h).toLowerCase()).filter(h => /^[a-z0-9_]+$/.test(h));
        } else {
            hashtags = [];
        }
        
        await pool.query(
            "UPDATE posts SET content = $1, hashtags = $2, edited = 1 WHERE id = $3",
            [content, hashtags, postId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/posts/:id', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const postId = parseInt(req.params.id);
        if (isNaN(postId)) return res.status(400).json({ error: 'Invalid post ID' });
        
        const post = await pool.query("SELECT author FROM posts WHERE id = $1", [postId]);
        if (post.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
        
        if (post.rows[0].author !== session.username) {
            const admin = await pool.query("SELECT isAdmin FROM users WHERE username = $1", [session.username]);
            if (admin.rows[0].isadmin !== 1) return res.status(403).json({ error: 'Forbidden' });
        }
        
        await pool.query("DELETE FROM posts WHERE id = $1", [postId]);
        await pool.query("DELETE FROM comments WHERE postId = $1", [postId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Остальные роуты с аналогичной защитой
app.get('/api/pendingPhotos', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const admin = await pool.query("SELECT isAdmin FROM users WHERE username = $1", [session.username]);
        if (admin.rows[0].isadmin !== 1) return res.status(403).json({ error: 'Forbidden' });
        
        const result = await pool.query("SELECT * FROM pendingPhotos");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ... (остальные роуты с аналогичной защитой)

// ===== PING SERVICE =====
const myUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
    const protocol = myUrl.startsWith('https') ? https : require('http');
    protocol.get(myUrl, (res) => {
        console.log(`🤍 ping: ${myUrl} answered ${res.statusCode}`);
    }).on('error', (err) => {
        console.log(`💔 ping error: ${err.message}`);
    });
}, 10 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`🌫️ Lamp in Fog running at http://localhost:${PORT}`);
});
