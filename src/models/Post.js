const { query } = require("../config/database");

class Post {
    static async findAll({ 
        limit = 20, 
        cursor = null, 
        authorId = null, 
        hashtag = null,
        includePending = false 
    } = {}) {
        let conditions = [];
        let params = [];
        let paramIndex = 1;

        if (authorId) {
            conditions.push(`author_id = $${paramIndex}`);
            params.push(authorId);
            paramIndex++;
        }

        if (!includePending) {
            conditions.push(`pending_approval = 0`);
        }

        if (hashtag) {
            conditions.push(`$${paramIndex} = ANY(hashtags)`);
            params.push(hashtag.toLowerCase());
            paramIndex++;
        }

        if (cursor) {
            conditions.push(`time < $${paramIndex}`);
            params.push(cursor);
            paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const orderBy = "ORDER BY time DESC";
        const limitClause = `LIMIT $${paramIndex}`;
        params.push(limit + 1);

        const sql = `
            SELECT 
                p.post_id as id,
                p.author_id,
                u.username as author,
                p.content,
                p.time,
                p.is_poem,
                p.photo,
                p.pending_approval,
                p.file_name,
                p.file_data,
                p.file_type,
                p.edited,
                p.hashtags
            FROM posts p
            JOIN users u ON p.author_id = u.user_id
            ${whereClause}
            ${orderBy}
            ${limitClause}
        `;

        const result = await query(sql, params);
        const rows = result.rows;
        const hasNext = rows.length > limit;
        const items = hasNext ? rows.slice(0, -1) : rows;
        const nextCursor = hasNext && items.length > 0 ? items[items.length - 1].time : null;

        return {
            items,
            nextCursor,
            hasNext
        };
    }

    static async findById(postId) {
        const result = await query(
            `SELECT 
                p.post_id as id,
                p.author_id,
                u.username as author,
                p.content,
                p.time,
                p.is_poem,
                p.photo,
                p.pending_approval,
                p.file_name,
                p.file_data,
                p.file_type,
                p.edited,
                p.hashtags
            FROM posts p
            JOIN users u ON p.author_id = u.user_id
            WHERE p.post_id = $1`,
            [postId]
        );
        return result.rows[0];
    }

    static async create(data) {
        const {
            authorId,
            content,
            time,
            isPoem = 0,
            photo = null,
            pendingApproval = 0,
            pendingId = null,
            fileName = null,
            fileData = null,
            fileType = null,
            hashtags = []
        } = data;

        const result = await query(
            `INSERT INTO posts 
             (author_id, content, time, is_poem, photo, pending_approval, pending_id, file_name, file_data, file_type, hashtags)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING post_id as id`,
            [authorId, content, time || Date.now(), isPoem, photo, pendingApproval, pendingId, fileName, fileData, fileType, hashtags]
        );
        return result.rows[0];
    }

    static async update(postId, { content, hashtags }) {
        await query(
            "UPDATE posts SET content = $1, hashtags = $2, edited = 1 WHERE post_id = $3",
            [content, hashtags, postId]
        );
    }

    static async delete(postId) {
        await query("DELETE FROM posts WHERE post_id = $1", [postId]);
    }
}

module.exports = Post;
