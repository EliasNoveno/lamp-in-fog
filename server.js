require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const rateLimiter = require('./src/middlewares/rateLimiter');

const authRoutes = require('./src/routes/authRoutes');
const userRoutes = require('./src/routes/userRoutes');
const postRoutes = require('./src/routes/postRoutes');
const commentRoutes = require('./src/routes/commentRoutes');
const notificationRoutes = require('./src/routes/notificationRoutes');
const messageRoutes = require('./src/routes/messageRoutes');
const savedRoutes = require('./src/routes/savedRoutes');

const app = express();
const PORT = process.env.PORT || 3004;

// Безопасность
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Глобальный rate limiter (защита от DDoS)
app.use(rateLimiter.global);

// API маршруты
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/saved', savedRoutes);

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// HTTPS сертификаты
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

https.createServer(httpsOptions, app).listen(PORT, () => {
    console.log(`🌫️ Lamp in Fog running at https://localhost:${PORT}`);
    console.log(`⚠️  Accept the security warning in your browser`);
    console.log(`🔒 Rate limiting active: ${200} requests per 15 min (global), ${5} login attempts per 15 min`);
});

module.exports = app;
