// ===== SAVED POSTS =====
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
