const User = require("../models/User");
const { sanitize, validateUsername, validatePassword } = require("../utils/sanitize");

exports.register = async (req, res) => {
    let { username, password } = req.body;
    username = sanitize(username);
    password = sanitize(password);
    
    if (!validateUsername(username)) {
        return res.status(400).json({ error: "Invalid username" });
    }
    
    if (!validatePassword(password)) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    
    try {
        const existing = await User.findByUsername(username);
        if (existing) {
            return res.status(400).json({ error: "Username already taken" });
        }
        
        const user = await User.create(username, password);
        const token = await User.createSession(user.user_id);
        
        res.json({ 
            username: user.username,
            isAdmin: user.is_admin === 1,
            token
        });
    } catch (err) {
        console.error("Registration error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

exports.login = async (req, res) => {
    let { username, password } = req.body;
    username = sanitize(username);
    password = sanitize(password);
    
    if (!validateUsername(username) || !validatePassword(password)) {
        return res.status(401).json({ error: "Invalid credentials" });
    }
    
    try {
        const user = await User.validatePassword(username, password);
        if (!user) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return res.status(401).json({ error: "Invalid credentials" });
        }
        
        if (user.banned === 1) {
            return res.status(403).json({ error: "Account banned" });
        }
        
        const token = await User.createSession(user.user_id);
        
        res.json({ 
            username: user.username,
            isAdmin: user.is_admin === 1,
            token
        });
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

exports.logout = async (req, res) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (token) {
        try {
            await User.deleteSession(token);
        } catch (err) {
            console.error("Logout error:", err);
        }
    }
    res.json({ success: true });
};

exports.changePassword = async (req, res) => {
    let { oldPassword, newPassword } = req.body;
    oldPassword = sanitize(oldPassword);
    newPassword = sanitize(newPassword);
    
    if (!validatePassword(oldPassword) || !validatePassword(newPassword)) {
        return res.status(400).json({ error: "Invalid password" });
    }
    
    try {
        const user = await User.validatePassword(req.user.username, oldPassword);
        if (!user) {
            return res.status(401).json({ error: "Wrong password" });
        }
        
        await User.changePassword(req.user.id, newPassword);
        await User.deleteAllSessions(req.user.id);
        
        res.json({ success: true });
    } catch (err) {
        console.error("Change password error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
};
