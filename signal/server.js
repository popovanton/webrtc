const express = require('express');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();

// SSL certificate options
const options = {
    key: fs.readFileSync(path.join(__dirname, 'ssl', 'private.key')),
    cert: fs.readFileSync(path.join(__dirname, 'ssl', 'certificate.crt')),
    requestCert: false,
    rejectUnauthorized: false
};

const server = https.createServer(options, app);
const io = new Server(server, {
    cors: {
        origin: "https://192.168.0.13:3001",
        methods: ["GET", "POST"],
        credentials: true
    },
    allowEIO3: true,
    transports: ['websocket', 'polling']
});

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Add a route to handle certificate errors
app.get('/', (req, res) => {
    res.send('Signaling server is running');
});

// Store connected users
const connectedUsers = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Handle user registration
    socket.on('register', (username) => {
        connectedUsers.set(socket.id, username);
        io.emit('userList', Array.from(connectedUsers.values()));
        console.log(`User ${username} registered`);
    });

    // Handle signaling
    socket.on('signal', (data) => {
        const targetSocket = Array.from(connectedUsers.entries())
            .find(([_, name]) => name === data.target);
        
        if (targetSocket) {
            io.to(targetSocket[0]).emit('signal', {
                sender: data.sender || connectedUsers.get(socket.id),
                data: data.signal
            });
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        const username = connectedUsers.get(socket.id);
        connectedUsers.delete(socket.id);
        io.emit('userList', Array.from(connectedUsers.values()));
        console.log(`User ${username} disconnected`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on https://localhost:${PORT}`);
}); 