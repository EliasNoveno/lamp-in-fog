const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// Пул подключений к PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
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
            friends TEXT[] DEFAULT '{}'
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
    
    // Создаём админа при первом запуске
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

// ========== API РОУТЫ ==========

app.get('/api/users', async (req, res) => {
    try {
        const result = await pool.query("SELECT username, description, isAdmin, banned, friends FROM users");
        const users = {};
        result.rows.forEach(u => {
            users[u.username] = {
                description: u.description || '',
                isAdmin: u.isadmin === 1,
                banned: u.banned === 1,
                friends: u.friends || []
            };
        });
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/users/:username', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM users WHERE username = $1", [req.params.username]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'user not found' });
        const user = result.rows[0];
        res.json({
            username: user.username,
            description: user.description || '',
            isAdmin: user.isadmin === 1,
            banned: user.banned === 1,
            friends: user.friends || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    
    try {
        const existing = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'username taken' });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(
            "INSERT INTO users (username, password, description, isAdmin, friends) VALUES ($1, $2, $3, $4, $5)",
            [username, hashedPassword, '', 0, []]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'invalid credentials' });
        const user = result.rows[0];
        if (user.banned === 1) return res.status(403).json({ error: 'account banned' });
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'invalid credentials' });
        
        res.json({ username: user.username, isAdmin: user.isadmin === 1 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/changePassword', async (req, res) => {
    const { username, oldPassword, newPassword } = req.body;
    try {
        const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'user not found' });
        const user = result.rows[0];
        
        const valid = await bcrypt.compare(oldPassword, user.password);
        if (!valid) return res.status(401).json({ error: 'wrong password' });
        
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query("UPDATE users SET password = $1 WHERE username = $2", [hashedPassword, username]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/posts', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM posts ORDER BY time DESC");
        const posts = result.rows.map(p => ({
            ...p,
            hashtags: p.hashtags || []
        }));
        res.json(posts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/posts', async (req, res) => {
    const { author, content, time, isPoem, photo, pendingApproval, pendingId, fileName, fileData, fileType, edited, hashtags } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO posts (author, content, time, isPoem, photo, pendingApproval, pendingId, fileName, fileData, fileType, edited, hashtags)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
            [author, content || '', time, isPoem ? 1 : 0, photo, pendingApproval ? 1 : 0, pendingId, fileName, fileData, fileType, edited ? 1 : 0, hashtags || []]
        );
        res.json({ id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/posts/:id', async (req, res) => {
    const { content, hashtags } = req.body;
    try {
        await pool.query(
            "UPDATE posts SET content = $1, hashtags = $2, edited = 1 WHERE id = $3",
            [content, hashtags || [], req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/posts/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM posts WHERE id = $1", [req.params.id]);
        await pool.query("DELETE FROM comments WHERE postId = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/pendingPhotos', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM pendingPhotos");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/pendingPhotos', async (req, res) => {
    const { id, author, data } = req.body;
    try {
        await pool.query(
            "INSERT INTO pendingPhotos (id, author, data) VALUES ($1, $2, $3)",
            [id, author, data]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/pendingPhotos/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM pendingPhotos WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/notifications/:username', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM notifications WHERE targetUser = $1 ORDER BY time DESC",
            [req.params.username]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/notifications', async (req, res) => {
    const { targetUser, fromUser, type } = req.body;
    try {
        await pool.query(
            "INSERT INTO notifications (targetUser, fromUser, type, time, read) VALUES ($1, $2, $3, $4, 0)",
            [targetUser, fromUser, type, Date.now()]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/notifications/:id/read', async (req, res) => {
    try {
        await pool.query("UPDATE notifications SET read = 1 WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/comments/:postId', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM comments WHERE postId = $1 ORDER BY time ASC",
            [req.params.postId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/comments', async (req, res) => {
    const { postId, author, content } = req.body;
    try {
        const result = await pool.query(
            "INSERT INTO comments (postId, author, content, time, edited) VALUES ($1, $2, $3, $4, 0) RETURNING id",
            [postId, author, content, Date.now()]
        );
        res.json({ id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/comments/:id', async (req, res) => {
    const { content, edited } = req.body;
    try {
        await pool.query(
            "UPDATE comments SET content = $1, edited = $2 WHERE id = $3",
            [content, edited || 1, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/comments/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM comments WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/privateMessages', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM privateMessages ORDER BY time ASC");
        const messages = {};
        result.rows.forEach(msg => {
            if (!messages[msg.toUser]) messages[msg.toUser] = [];
            if (!messages[msg.fromUser]) messages[msg.fromUser] = [];
            messages[msg.toUser].push(msg);
            messages[msg.fromUser].push(msg);
        });
        res.json(messages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/privateMessages', async (req, res) => {
    const { from, to, message, time } = req.body;
    try {
        await pool.query(
            "INSERT INTO privateMessages (fromUser, toUser, message, time, read) VALUES ($1, $2, $3, $4, 0)",
            [from, to, message, time]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/blacklists', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM blacklists");
        const blacklists = {};
        result.rows.forEach(row => {
            blacklists[row.username] = row.blocked || [];
        });
        res.json(blacklists);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/blacklists', async (req, res) => {
    const { username, blacklist } = req.body;
    try {
        await pool.query(
            "INSERT INTO blacklists (username, blocked) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET blocked = $2",
            [username, blacklist || []]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/:username', async (req, res) => {
    const { description, isAdmin, banned, friends } = req.body;
    const updates = [];
    const values = [];
    let paramIndex = 1;
    
    if (description !== undefined) { updates.push(`description = $${paramIndex}`); values.push(description); paramIndex++; }
    if (isAdmin !== undefined) { updates.push(`isAdmin = $${paramIndex}`); values.push(isAdmin ? 1 : 0); paramIndex++; }
    if (banned !== undefined) { updates.push(`banned = $${paramIndex}`); values.push(banned ? 1 : 0); paramIndex++; }
    if (friends !== undefined) { updates.push(`friends = $${paramIndex}`); values.push(friends); paramIndex++; }
    
    if (updates.length === 0) return res.json({ success: true });
    
    values.push(req.params.username);
    try {
        await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE username = $${paramIndex}`, values);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/users/:username', async (req, res) => {
    const username = req.params.username;
    try {
        await pool.query("DELETE FROM posts WHERE author = $1", [username]);
        await pool.query("DELETE FROM comments WHERE author = $1", [username]);
        await pool.query("DELETE FROM notifications WHERE targetUser = $1 OR fromUser = $1", [username]);
        await pool.query("DELETE FROM pendingPhotos WHERE author = $1", [username]);
        await pool.query("DELETE FROM privateMessages WHERE fromUser = $1 OR toUser = $1", [username]);
        await pool.query("DELETE FROM blacklists WHERE username = $1", [username]);
        await pool.query("DELETE FROM users WHERE username = $1", [username]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== ГЛАВНЫЙ МАРШРУТ ==========
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

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
