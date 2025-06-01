const express = require('express');
const path = require('path');
const https = require('https');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';

// SSL certificate options
const options = {
    key: fs.readFileSync(path.join(__dirname, 'ssl', 'private.key')),
    cert: fs.readFileSync(path.join(__dirname, 'ssl', 'certificate.crt'))
};

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Create HTTPS server
const server = https.createServer(options, app);

server.listen(PORT, HOST, () => {
    console.log(`Client server running on https://${HOST}:${PORT}`);
}); 