const { query } = require("../config/database");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

class User {
    static async findByUsername(username) {
        const result = await query(
            "SELECT user_id, username, password, description, banned, is_admin, float_text, created_at FROM users WHERE username = $1",
            [username]
        );
        return result.rows[0];
    }

    static async findById(userId) {
        const result = await query(
            `SELECT user_id, username, description, banned, is_admin, float_text, created_at 
             FROM users WHERE user_id = $1`,
            [userId]
        );
        return result.rows[0];
    }

    static async create(username, password) {
        const hashedPassword = await bcrypt.hash(password, 12);
        const result = await query(
            "INSERT INTO users (username, password) VALUES ($1, $2) RETURNING user_id, username, is_admin",
            [username, hashedPassword]
        );
        return result.rows[0];
    }

    static async validatePassword(username, password) {
        const user = await this.findByUsername(username);
        if (!user) return null;
        const isValid = await bcrypt.compare(password, user.password);
        return isValid ? user : null;
    }

    static async updateDescription(userId, description) {
        await query(
            "UPDATE users SET description = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2",
            [description, userId]
        );
    }

    static async updateFloatText(userId, floatText) {
        await query(
            "UPDATE users SET float_text = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2",
            [floatText, userId]
        );
    }

    static async changePassword(userId, newPassword) {
        const hashedPassword = await bcrypt.hash(newPassword, 12);
        await query(
            "UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2",
            [hashedPassword, userId]
        );
    }

    static async getFriends(userId) {
        const result = await query(
            "SELECT u.user_id, u.username, u.description, u.is_admin FROM friends f JOIN users u ON f.friend_id = u.user_id WHERE f.user_id = $1",
            [userId]
        );
        return result.rows;
    }

    static async addFriend(userId, friendId) {
        await query(
            "INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [userId, friendId]
        );
    }

    static async removeFriend(userId, friendId) {
        await query(
            "DELETE FROM friends WHERE user_id = $1 AND friend_id = $2",
            [userId, friendId]
        );
    }

    static async createSession(userId) {
        const token = crypto.randomBytes(64).toString("hex");
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const result = await query(
            "INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3) RETURNING token",
            [userId, token, expiresAt]
        );
        return result.rows[0].token;
    }

    static async validateSession(token) {
        const result = await query(
            `SELECT s.user_id, u.username, u.is_admin 
             FROM sessions s 
             JOIN users u ON s.user_id = u.user_id 
             WHERE s.token = $1 AND s.expires_at > NOW()`,
            [token]
        );
        return result.rows[0];
    }

    static async deleteSession(token) {
        await query("DELETE FROM sessions WHERE token = $1", [token]);
    }

    static async deleteAllSessions(userId) {
        await query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    }
}

module.exports = User;
