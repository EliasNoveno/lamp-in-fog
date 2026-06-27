const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3002;

// ===== БЕЗОПАСНОСТЬ =====
app.use((req, res, next) => {
    if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
        return res.redirect(301, 'https://' + req.headers.host + req.url);
    }
    next();
});

// Временно отключаем helmet для теста
// app.use(helmet({ ... }));

// Лимиты запросов
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many login attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: { error: 'Upload limit exceeded. Please try again in an hour.' },
});

app.use(globalLimiter);
app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname));

// ===== БАЗА ДАННЫХ =====
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost/lamp_forum_db',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 20,
});

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====
const sanitize = (input) => {
    if (typeof input !== 'string') return input;
    return input.replace(/[^\x20-\x7E\u0400-\u04FF]/g, '').trim().slice(0, 10000);
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
                float_text TEXT DEFAULT ':>',
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
            CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
            CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);
            CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author);
            CREATE INDEX IF NOT EXISTS idx_posts_time ON posts(time);
            CREATE INDEX IF NOT EXISTS idx_comments_postid ON comments(postId);
        `).catch(() => {});
        
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
                read INTEGER DEFAULT 0,
                postQuote TEXT
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS blacklists (
                username TEXT PRIMARY KEY,
                blocked TEXT[] DEFAULT '{}'
            )
        `);
        
        // === НОВАЯ ТАБЛИЦА ДЛЯ ЗАКЛАДОК ===
        await pool.query(`
            CREATE TABLE IF NOT EXISTS saved_posts (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                post_id INTEGER NOT NULL,
                saved_at BIGINT NOT NULL,
                UNIQUE(username, post_id)
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
    
    try {
        const result = await pool.query(
            "SELECT username FROM sessions WHERE token = $1 AND expires_at > NOW()",
            [token]
        );
        return result.rows[0] || null;
    } catch (err) {
        return null;
    }
};

// ===== API РОУТЫ =====

// Users
app.get('/api/users', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT username, description, isAdmin, banned, float_text FROM users"
        );
        const users = {};
        for (const u of result.rows) {
            const friendsRes = await pool.query(
                "SELECT friend_id FROM friends WHERE user_id = $1",
                [u.username]
            );
            users[u.username] = {
                description: sanitize(u.description || ''),
                isAdmin: u.isadmin === 1,
                banned: u.banned === 1,
                float_text: u.float_text || ':>',
                friends: friendsRes.rows.map(f => f.friend_id)
            };
        }
        res.json(users);
    } catch (err) {
        console.error('Users fetch error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Register
app.post('/api/register', authLimiter, async (req, res) => {
    let { username, password } = req.body;
    username = sanitize(username);
    password = sanitize(password);
    
    if (!validateUsername(username)) {
        return res.status(400).json({ error: 'Invalid username: 2-30 characters, letters, numbers, underscores, dots or hyphens only' });
    }
    
    if (!validatePassword(password)) {
        return res.status(400).json({ error: 'Invalid password: minimum 8 characters, maximum 100' });
    }
    
    try {
        const existing = await pool.query(
            "SELECT * FROM users WHERE username = $1",
            [username]
        );
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Username already taken' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 12);
        await pool.query(
            "INSERT INTO users (username, password, description, isAdmin) VALUES ($1, $2, $3, $4)",
            [username, hashedPassword, '', 0]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Registration error:', err);
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
        const result = await pool.query(
            "SELECT * FROM users WHERE username = $1",
            [username]
        );
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
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Logout
app.post('/api/logout', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
        try {
            await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
        } catch (err) {
            console.error('Logout error:', err);
        }
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
        const result = await pool.query(
            "SELECT * FROM users WHERE username = $1",
            [session.username]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = result.rows[0];
        const valid = await bcrypt.compare(oldPassword, user.password);
        if (!valid) {
            return res.status(401).json({ error: 'Wrong password' });
        }
        
        const hashedPassword = await bcrypt.hash(newPassword, 12);
        await pool.query(
            "UPDATE users SET password = $1 WHERE username = $2",
            [hashedPassword, session.username]
        );
        
        await pool.query(
            "DELETE FROM sessions WHERE username = $1",
            [session.username]
        );
        
        res.json({ success: true });
    } catch (err) {
        console.error('Change password error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Posts
app.get('/api/posts', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
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
        console.error('Posts fetch error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Post creation
app.post('/api/posts', uploadLimiter, async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        let { content, time, isPoem, photo, pendingApproval, pendingId, fileName, fileData, fileType, hashtags } = req.body;
        
        content = sanitize(content || '');
        if (content.length > 10000) {
            return res.status(400).json({ error: 'Content too long' });
        }
        
        if (fileData && Buffer.byteLength(fileData, 'utf8') > 5 * 1024 * 1024) {
            return res.status(400).json({ error: 'File too large (max 5MB)' });
        }
        
        if (hashtags) {
            if (!Array.isArray(hashtags)) hashtags = [];
            hashtags = hashtags.slice(0, 30)
                .map(h => sanitize(h).toLowerCase())
                .filter(h => /^[a-z0-9_]+$/.test(h));
        } else {
            hashtags = [];
        }
        
        const result = await pool.query(
            `INSERT INTO posts (author, content, time, isPoem, photo, pendingApproval, pendingId, fileName, fileData, fileType, hashtags)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
            [session.username, content, time || Date.now(), isPoem ? 1 : 0, 
             photo, pendingApproval ? 1 : 0, pendingId, fileName, fileData, fileType, hashtags]
        );
        res.json({ id: result.rows[0].id });
    } catch (err) {
        console.error('Post creation error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update post
app.put('/api/posts/:id', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    const { id } = req.params;
    let { content, hashtags } = req.body;
    content = sanitize(content || '');
    
    try {
        const postResult = await pool.query(
            "SELECT * FROM posts WHERE id = $1",
            [id]
        );
        if (postResult.rows.length === 0) {
            return res.status(404).json({ error: 'Post not found' });
        }
        
        const post = postResult.rows[0];
        if (post.author !== session.username && !session.isAdmin) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        
        if (hashtags) {
            if (!Array.isArray(hashtags)) hashtags = [];
            hashtags = hashtags.slice(0, 30)
                .map(h => sanitize(h).toLowerCase())
                .filter(h => /^[a-z0-9_]+$/.test(h));
        } else {
            hashtags = [];
        }
        
        await pool.query(
            "UPDATE posts SET content = $1, hashtags = $2, edited = 1 WHERE id = $3",
            [content, hashtags, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Post update error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete post
app.delete('/api/posts/:id', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    const { id } = req.params;
    
    try {
        const postResult = await pool.query(
            "SELECT * FROM posts WHERE id = $1",
            [id]
        );
        if (postResult.rows.length === 0) {
            return res.status(404).json({ error: 'Post not found' });
        }
        
        const post = postResult.rows[0];
        if (post.author !== session.username && !session.isAdmin) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        
        await pool.query("DELETE FROM posts WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Post delete error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Comments
app.get('/api/comments/:postId', async (req, res) => {
    const { postId } = req.params;
    
    try {
        const result = await pool.query(
            "SELECT * FROM comments WHERE postId = $1 ORDER BY time ASC",
            [postId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Comments fetch error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/comments', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    let { postId, author, content } = req.body;
    content = sanitize(content || '');
    
    if (!content || content.length > 5000) {
        return res.status(400).json({ error: 'Invalid comment' });
    }
    
    try {
        await pool.query(
            "INSERT INTO comments (postId, author, content, time) VALUES ($1, $2, $3, $4)",
            [postId, session.username, content, Date.now()]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Comment creation error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/comments/:id', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    const { id } = req.params;
    let { content, edited } = req.body;
    content = sanitize(content || '');
    
    try {
        const commentResult = await pool.query(
            "SELECT * FROM comments WHERE id = $1",
            [id]
        );
        if (commentResult.rows.length === 0) {
            return res.status(404).json({ error: 'Comment not found' });
        }
        
        const comment = commentResult.rows[0];
        if (comment.author !== session.username && !session.isAdmin) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        
        await pool.query(
            "UPDATE comments SET content = $1, edited = $2 WHERE id = $3",
            [content, edited ? 1 : 0, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Comment update error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/comments/:id', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    const { id } = req.params;
    
    try {
        const commentResult = await pool.query(
            "SELECT * FROM comments WHERE id = $1",
            [id]
        );
        if (commentResult.rows.length === 0) {
            return res.status(404).json({ error: 'Comment not found' });
        }
        
        const comment = commentResult.rows[0];
        if (comment.author !== session.username && !session.isAdmin) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        
        await pool.query("DELETE FROM comments WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Comment delete error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Pending photos
app.get('/api/pendingPhotos', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM pendingPhotos");
        res.json(result.rows);
    } catch (err) {
        console.error('Pending photos fetch error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/pendingPhotos', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    let { id, author, data } = req.body;
    
    try {
        await pool.query(
            "INSERT INTO pendingPhotos (id, author, data) VALUES ($1, $2, $3)",
            [id, session.username, data]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Pending photo creation error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/pendingPhotos/:id', async (req, res) => {
    const session = await authenticate(req);
    if (!session || !session.isAdmin) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    
    const { id } = req.params;
    
    try {
        await pool.query("DELETE FROM pendingPhotos WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Pending photo delete error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Notifications
app.get('/api/notifications/:username', async (req, res) => {
    const { username } = req.params;
    
    try {
        const result = await pool.query(
            "SELECT * FROM notifications WHERE targetUser = $1 ORDER BY time DESC",
            [username]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Notifications fetch error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/notifications', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    let { targetUser, fromUser, type } = req.body;
    
    try {
        await pool.query(
            "INSERT INTO notifications (targetUser, fromUser, type, time) VALUES ($1, $2, $3, $4)",
            [targetUser, session.username, type, Date.now()]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Notification creation error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/notifications/:id/read', async (req, res) => {
    const { id } = req.params;
    
    try {
        await pool.query(
            "UPDATE notifications SET read = 1 WHERE id = $1",
            [id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Notification read error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Private messages
app.get('/api/privateMessages', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM privateMessages ORDER BY time ASC"
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Private messages fetch error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/privateMessages', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    let { toUser, message, postQuote } = req.body;
    message = sanitize(message || '');
    
    if (!message || message.length > 5000) {
        return res.status(400).json({ error: 'Invalid message' });
    }
    
    try {
        await pool.query(
            "INSERT INTO privateMessages (fromUser, toUser, message, time, postQuote) VALUES ($1, $2, $3, $4, $5)",
            [session.username, toUser, message, Date.now(), postQuote || null]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Private message creation error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Blacklists
app.get('/api/blacklists', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM blacklists");
        const blacklists = {};
        result.rows.forEach(row => {
            blacklists[row.username] = row.blocked || [];
        });
        res.json(blacklists);
    } catch (err) {
        console.error('Blacklists fetch error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/blacklists', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    let { username, blacklist } = req.body;
    
    try {
        await pool.query(
            "INSERT INTO blacklists (username, blocked) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET blocked = $2",
            [username, blacklist]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Blacklist update error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Users update (admin)
app.put('/api/users/:username', async (req, res) => {
    const session = await authenticate(req);
    if (!session || !session.isAdmin) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    
    const { username } = req.params;
    let { description, isAdmin, banned, friends, float_text } = req.body;
    
    try {
        if (description !== undefined) {
            description = sanitize(description || '');
            await pool.query(
                "UPDATE users SET description = $1 WHERE username = $2",
                [description, username]
            );
        }
        
        if (float_text !== undefined) {
            float_text = sanitize(float_text || ':>').slice(0, 15);
            await pool.query(
                "UPDATE users SET float_text = $1 WHERE username = $2",
                [float_text, username]
            );
        }
        
        if (isAdmin !== undefined) {
            await pool.query(
                "UPDATE users SET isAdmin = $1 WHERE username = $2",
                [isAdmin ? 1 : 0, username]
            );
        }
        
        if (banned !== undefined) {
            await pool.query(
                "UPDATE users SET banned = $1 WHERE username = $2",
                [banned ? 1 : 0, username]
            );
        }
        
        if (friends !== undefined) {
            await pool.query("DELETE FROM friends WHERE user_id = $1", [username]);
            for (const friend of friends) {
                await pool.query(
                    "INSERT INTO friends (user_id, friend_id) VALUES ($1, $2)",
                    [username, friend]
                );
            }
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error('User update error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete user (admin)
app.delete('/api/users/:username', async (req, res) => {
    const session = await authenticate(req);
    if (!session || !session.isAdmin) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    
    const { username } = req.params;
    
    try {
        await pool.query("DELETE FROM users WHERE username = $1", [username]);
        res.json({ success: true });
    } catch (err) {
        console.error('User delete error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===== SAVED POSTS (ЗАКЛАДКИ) =====
app.get('/api/saved', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const result = await pool.query(
            "SELECT post_id FROM saved_posts WHERE username = $1",
            [session.username]
        );
        res.json(result.rows.map(r => r.post_id));
    } catch (err) {
        console.error('Saved fetch error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/saved', async (req, res) => {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    const { postId, action } = req.body;
    
    try {
        if (action === 'add') {
            await pool.query(
                "INSERT INTO saved_posts (username, post_id, saved_at) VALUES ($1, $2, $3) ON CONFLICT (username, post_id) DO NOTHING",
                [session.username, postId, Date.now()]
            );
        } else if (action === 'remove') {
            await pool.query(
                "DELETE FROM saved_posts WHERE username = $1 AND post_id = $2",
                [session.username, postId]
            );
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Saved update error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===== HTTPS SERVER =====
const certDir = __dirname;
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');

function ensureCertificates() {
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        console.log('🔐 Generating self-signed certificate...');
        const { execSync } = require('child_process');
        try {
            execSync(`openssl req -x509 -newkey rsa:4096 -keyout ${keyPath} -out ${certPath} -days 365 -nodes -subj "/CN=localhost"`, {
                stdio: 'inherit'
            });
            console.log('✅ Certificate generated');
        } catch (e) {
            console.error('❌ Failed to generate certificate. Please install openssl:');
            console.error('   brew install openssl');
            process.exit(1);
        }
    }
}

ensureCertificates();

const httpsOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
};

// Запускаем HTTPS сервер
https.createServer(httpsOptions, app).listen(PORT, () => {
    console.log(`🌫️ Lamp in Fog running at https://localhost:${PORT}`);
    console.log(`⚠️  Accept the security warning in your browser`);
});

// ===== PING SERVICE =====
const myUrl = process.env.RENDER_EXTERNAL_URL || `https://localhost:${PORT}`;
setInterval(() => {
    const protocol = myUrl.startsWith('https') ? https : require('http');
    protocol.get(myUrl, (res) => {
        console.log(`🤍 ping: ${myUrl} answered ${res.statusCode}`);
    }).on('error', (err) => {
        console.log(`💔 ping error: ${err.message}`);
    });
}, 10 * 60 * 1000);
