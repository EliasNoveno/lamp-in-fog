const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const db = new sqlite3.Database('database.sqlite');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        description TEXT,
        banned INTEGER DEFAULT 0,
        isAdmin INTEGER DEFAULT 0,
        friends TEXT DEFAULT '[]'
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        author TEXT NOT NULL,
        content TEXT,
        time INTEGER NOT NULL,
        isPoem INTEGER DEFAULT 0,
        photo TEXT,
        pendingApproval INTEGER DEFAULT 0,
        pendingId TEXT,
        fileName TEXT,
        fileData TEXT,
        fileType TEXT,
        edited INTEGER DEFAULT 0,
        hashtags TEXT DEFAULT '[]'
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS pendingPhotos (
        id TEXT PRIMARY KEY,
        author TEXT NOT NULL,
        data TEXT NOT NULL
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        targetUser TEXT NOT NULL,
        fromUser TEXT NOT NULL,
        type TEXT NOT NULL,
        read INTEGER DEFAULT 0,
        time INTEGER NOT NULL
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        postId INTEGER NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        time INTEGER NOT NULL,
        edited INTEGER DEFAULT 0
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS privateMessages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fromUser TEXT NOT NULL,
        toUser TEXT NOT NULL,
        message TEXT NOT NULL,
        time INTEGER NOT NULL,
        read INTEGER DEFAULT 0
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS blacklists (
        username TEXT PRIMARY KEY,
        blocked TEXT DEFAULT '[]'
    )`);
    
    db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
        if (row && row.count === 0) {
            const hashedPassword = bcrypt.hashSync('hell_yeah', 10);
            db.run(`INSERT INTO users (username, password, description, isAdmin) VALUES (?, ?, ?, ?)`,
                ['Edd_Leon_CAt', hashedPassword, 'the primordial admin', 1]);
            console.log('✅ primordial admin created');
        }
    });
});

// ========== API РОУТЫ ==========

app.get('/api/users', (req, res) => {
    db.all("SELECT username, description, isAdmin, banned, friends FROM users", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const users = {};
        rows.forEach(u => {
            users[u.username] = {
                description: u.description || '',
                isAdmin: u.isAdmin === 1,
                banned: u.banned === 1,
                friends: JSON.parse(u.friends || '[]')
            };
        });
        res.json(users);
    });
});

app.get('/api/users/:username', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.params.username], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'user not found' });
        res.json({
            username: user.username,
            description: user.description || '',
            isAdmin: user.isAdmin === 1,
            banned: user.banned === 1,
            friends: JSON.parse(user.friends || '[]')
        });
    });
});

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, existing) => {
        if (existing) return res.status(400).json({ error: 'username taken' });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (username, password, description, isAdmin, friends) VALUES (?, ?, ?, ?, ?)`,
            [username, hashedPassword, '', 0, '[]'], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'invalid credentials' });
        if (user.banned === 1) return res.status(403).json({ error: 'account banned' });
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'invalid credentials' });
        
        res.json({ username: user.username, isAdmin: user.isAdmin === 1 });
    });
});

app.post('/api/changePassword', async (req, res) => {
    const { username, oldPassword, newPassword } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'user not found' });
        const valid = await bcrypt.compare(oldPassword, user.password);
        if (!valid) return res.status(401).json({ error: 'wrong password' });
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        db.run("UPDATE users SET password = ? WHERE username = ?", [hashedPassword, username], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

app.get('/api/posts', (req, res) => {
    db.all("SELECT * FROM posts ORDER BY time DESC", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const posts = rows.map(p => ({
            ...p,
            hashtags: p.hashtags ? JSON.parse(p.hashtags) : []
        }));
        res.json(posts);
    });
});

app.post('/api/posts', (req, res) => {
    const { author, content, time, isPoem, photo, pendingApproval, pendingId, fileName, fileData, fileType, edited, hashtags } = req.body;
    db.run(`INSERT INTO posts (author, content, time, isPoem, photo, pendingApproval, pendingId, fileName, fileData, fileType, edited, hashtags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [author, content || '', time, isPoem ? 1 : 0, photo, pendingApproval ? 1 : 0, pendingId, fileName, fileData, fileType, edited ? 1 : 0, JSON.stringify(hashtags || [])],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        });
});

app.put('/api/posts/:id', (req, res) => {
    const { content, hashtags } = req.body;
    db.run(`UPDATE posts SET content = ?, hashtags = ?, edited = 1 WHERE id = ?`,
        [content, JSON.stringify(hashtags || []), req.params.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

app.delete('/api/posts/:id', (req, res) => {
    db.run("DELETE FROM posts WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run("DELETE FROM comments WHERE postId = ?", [req.params.id], () => {});
        res.json({ success: true });
    });
});

app.get('/api/pendingPhotos', (req, res) => {
    db.all("SELECT * FROM pendingPhotos", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/pendingPhotos', (req, res) => {
    const { id, author, data } = req.body;
    db.run(`INSERT INTO pendingPhotos (id, author, data) VALUES (?, ?, ?)`, [id, author, data], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.delete('/api/pendingPhotos/:id', (req, res) => {
    db.run("DELETE FROM pendingPhotos WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/api/notifications/:username', (req, res) => {
    db.all("SELECT * FROM notifications WHERE targetUser = ? ORDER BY time DESC", [req.params.username], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/notifications', (req, res) => {
    const { targetUser, fromUser, type } = req.body;
    db.run(`INSERT INTO notifications (targetUser, fromUser, type, time, read) VALUES (?, ?, ?, ?, 0)`,
        [targetUser, fromUser, type, Date.now()], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

app.put('/api/notifications/:id/read', (req, res) => {
    db.run("UPDATE notifications SET read = 1 WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/api/comments/:postId', (req, res) => {
    db.all("SELECT * FROM comments WHERE postId = ? ORDER BY time ASC", [req.params.postId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/comments', (req, res) => {
    const { postId, author, content } = req.body;
    db.run(`INSERT INTO comments (postId, author, content, time, edited) VALUES (?, ?, ?, ?, 0)`,
        [postId, author, content, Date.now()], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        });
});

app.put('/api/comments/:id', (req, res) => {
    const { content, edited } = req.body;
    db.run("UPDATE comments SET content = ?, edited = ? WHERE id = ?", [content, edited || 1, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.delete('/api/comments/:id', (req, res) => {
    db.run("DELETE FROM comments WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/api/privateMessages', (req, res) => {
    db.all("SELECT * FROM privateMessages ORDER BY time ASC", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const messages = {};
        rows.forEach(msg => {
            if (!messages[msg.toUser]) messages[msg.toUser] = [];
            if (!messages[msg.fromUser]) messages[msg.fromUser] = [];
            messages[msg.toUser].push(msg);
            messages[msg.fromUser].push(msg);
        });
        res.json(messages);
    });
});

app.post('/api/privateMessages', (req, res) => {
    const { from, to, message, time } = req.body;
    db.run(`INSERT INTO privateMessages (fromUser, toUser, message, time, read) VALUES (?, ?, ?, ?, 0)`,
        [from, to, message, time], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

app.get('/api/blacklists', (req, res) => {
    db.all("SELECT * FROM blacklists", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const blacklists = {};
        rows.forEach(row => {
            blacklists[row.username] = JSON.parse(row.blocked);
        });
        res.json(blacklists);
    });
});

app.post('/api/blacklists', (req, res) => {
    const { username, blacklist } = req.body;
    db.run(`INSERT OR REPLACE INTO blacklists (username, blocked) VALUES (?, ?)`, [username, JSON.stringify(blacklist)], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.put('/api/users/:username', (req, res) => {
    const { description, isAdmin, banned, friends } = req.body;
    const updates = [];
    const values = [];
    if (description !== undefined) { updates.push('description = ?'); values.push(description); }
    if (isAdmin !== undefined) { updates.push('isAdmin = ?'); values.push(isAdmin ? 1 : 0); }
    if (banned !== undefined) { updates.push('banned = ?'); values.push(banned ? 1 : 0); }
    if (friends !== undefined) { updates.push('friends = ?'); values.push(JSON.stringify(friends)); }
    if (updates.length === 0) return res.json({ success: true });
    values.push(req.params.username);
    db.run(`UPDATE users SET ${updates.join(', ')} WHERE username = ?`, values, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.delete('/api/users/:username', (req, res) => {
    const username = req.params.username;
    db.run("DELETE FROM posts WHERE author = ?", [username], () => {});
    db.run("DELETE FROM comments WHERE author = ?", [username], () => {});
    db.run("DELETE FROM notifications WHERE targetUser = ? OR fromUser = ?", [username, username], () => {});
    db.run("DELETE FROM pendingPhotos WHERE author = ?", [username], () => {});
    db.run("DELETE FROM privateMessages WHERE fromUser = ? OR toUser = ?", [username, username], () => {});
    db.run("DELETE FROM blacklists WHERE username = ?", [username], () => {});
    db.run("DELETE FROM users WHERE username = ?", [username], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
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