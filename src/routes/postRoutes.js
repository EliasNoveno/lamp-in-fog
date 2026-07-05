const express = require('express');
const router = express.Router();
const { auth } = require('../middlewares/auth');
const rateLimiter = require('../middlewares/rateLimiter');
const postController = require('../controllers/postController');

router.get('/', auth, postController.getPosts);
router.post('/', auth, rateLimiter.upload, postController.createPost);
router.put('/:id', auth, postController.updatePost);
router.delete('/:id', auth, postController.deletePost);

module.exports = router;
