const Post = require("../models/Post");
const { sanitize } = require("../utils/sanitize");

const MAX_CONTENT_LENGTH = 10000;
const MAX_HASHTAGS = 30;

exports.getPosts = async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);
        const cursor = req.query.cursor ? parseInt(req.query.cursor) : null;
        const authorId = req.query.author ? parseInt(req.query.author) : null;
        const hashtag = req.query.hashtag ? sanitize(req.query.hashtag).toLowerCase() : null;
        const includePending = req.user?.isAdmin || false;

        const result = await Post.findAll({
            limit,
            cursor,
            authorId,
            hashtag,
            includePending
        });

        res.json({
            items: result.items,
            nextCursor: result.nextCursor,
            hasNext: result.hasNext
        });
    } catch (error) {
        console.error("Get posts error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

exports.createPost = async (req, res) => {
    try {
        let { content, time, isPoem, photo, pendingApproval, pendingId, fileName, fileData, fileType, hashtags } = req.body;
        
        content = sanitize(content || "");
        if (content.length > MAX_CONTENT_LENGTH) {
            return res.status(400).json({ error: `Content too long (max ${MAX_CONTENT_LENGTH} characters)` });
        }

        if (hashtags) {
            if (!Array.isArray(hashtags)) hashtags = [];
            hashtags = hashtags.slice(0, MAX_HASHTAGS)
                .map(h => sanitize(h).toLowerCase())
                .filter(h => /^[a-z0-9_]+$/.test(h));
        } else {
            hashtags = [];
        }

        const postData = {
            authorId: req.user.id,
            content,
            time: time || Date.now(),
            isPoem: isPoem ? 1 : 0,
            photo,
            pendingApproval: pendingApproval ? 1 : 0,
            pendingId,
            fileName,
            fileData,
            fileType,
            hashtags
        };

        const post = await Post.create(postData);
        res.status(201).json(post);
    } catch (error) {
        console.error("Create post error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

exports.updatePost = async (req, res) => {
    try {
        const postId = parseInt(req.params.id);
        const post = await Post.findById(postId);
        
        if (!post) {
            return res.status(404).json({ error: "Post not found" });
        }

        if (post.author_id !== req.user.id && !req.user.isAdmin) {
            return res.status(403).json({ error: "Forbidden" });
        }

        let { content, hashtags } = req.body;
        content = sanitize(content || "");

        if (hashtags) {
            if (!Array.isArray(hashtags)) hashtags = [];
            hashtags = hashtags.slice(0, MAX_HASHTAGS)
                .map(h => sanitize(h).toLowerCase())
                .filter(h => /^[a-z0-9_]+$/.test(h));
        } else {
            hashtags = [];
        }

        await Post.update(postId, { content, hashtags });
        res.json({ success: true });
    } catch (error) {
        console.error("Update post error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

exports.deletePost = async (req, res) => {
    try {
        const postId = parseInt(req.params.id);
        const post = await Post.findById(postId);
        
        if (!post) {
            return res.status(404).json({ error: "Post not found" });
        }

        if (post.author_id !== req.user.id && !req.user.isAdmin) {
            return res.status(403).json({ error: "Forbidden" });
        }

        await Post.delete(postId);
        res.json({ success: true });
    } catch (error) {
        console.error("Delete post error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};
