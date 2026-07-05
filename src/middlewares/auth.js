const User = require("../models/User");

const auth = async (req, res, next) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) {
        return res.status(401).json({ error: "Authentication required" });
    }

    try {
        const session = await User.validateSession(token);
        if (!session) {
            return res.status(401).json({ error: "Invalid or expired token" });
        }

        req.user = {
            id: session.user_id,
            username: session.username,
            isAdmin: session.is_admin === 1
        };
        next();
    } catch (error) {
        console.error("Auth error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

const admin = (req, res, next) => {
    if (!req.user || !req.user.isAdmin) {
        return res.status(403).json({ error: "Admin access required" });
    }
    next();
};

module.exports = { auth, admin };
