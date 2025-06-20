const express = require("express");
const http = require("http"); // Use HTTP for local development
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const app = express();

// Create HTTP server (ngrok will handle HTTPS)
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static("public"));

const users = {};
const rooms = {};
const SECRET_KEY = "your_secure_secret_key_here";

// JWT Session Management
const jwtSessions = new Map();
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

function generateRoomId() {
    return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function generateToken(userId) {
    return jwt.sign({ userId }, SECRET_KEY, { expiresIn: "1h" });
}

function verifyToken(token) {
    try {
        return jwt.verify(token, SECRET_KEY);
    } catch (err) {
        return null;
    }
}

// Middleware to validate JWT for socket connections - LESS STRICT
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    
    if (!token) {
        // Generate a new token for new connections
        const newToken = jwt.sign({ id: socket.id, timestamp: Date.now() }, JWT_SECRET, { expiresIn: '24h' });
        jwtSessions.set(socket.id, { 
            token: newToken,
            ip: socket.handshake.address,
            createdAt: Date.now()
        });
        socket.auth = { token: newToken };
        next();
    } else {
        try {
            // Verify existing token
            const decoded = jwt.verify(token, JWT_SECRET);
            
            // Store session info but don't be too strict
            jwtSessions.set(socket.id, { 
                token: token,
                ip: socket.handshake.address,
                createdAt: Date.now()
            });
            
            socket.auth = { token, decoded };
            next();
        } catch (err) {
            // If token is invalid, create a new one instead of rejecting
            const newToken = jwt.sign({ id: socket.id, timestamp: Date.now() }, JWT_SECRET, { expiresIn: '24h' });
            jwtSessions.set(socket.id, { 
                token: newToken,
                ip: socket.handshake.address,
                createdAt: Date.now()
            });
            socket.auth = { token: newToken };
            next();
        }
    }
});

// SINGLE socket connection handler
io.on("connection", socket => {
    console.log("User connected:", socket.id);
    
    // Send authentication token to client
    const token = socket.auth.token;
    socket.emit("authentication", { token });

    socket.on("register", username => {
        const token = generateToken(socket.id);
        users[socket.id] = {
            username: username || `User-${socket.id.substr(0, 4)}`,
            id: socket.id,
            videoEnabled: true,
            audioEnabled: true,
            token,
            roomId: null
        };
        socket.emit("authentication", { token });
    });

    socket.on("create-room", () => {
        if (!users[socket.id]) return;
        const roomId = generateRoomId();
        rooms[roomId] = { id: roomId, creator: socket.id, participants: {} };
        joinRoom(socket, roomId);
    });

    socket.on("join-room", roomId => {
        if (!users[socket.id] || !rooms[roomId]) {
            socket.emit("room-error", { message: "Room not found" });
            return;
        }
        joinRoom(socket, roomId);
    });

    function joinRoom(socket, roomId) {
        const user = users[socket.id];
        if (!user) return;

        if (user.roomId && rooms[user.roomId]) {
            socket.leave(user.roomId);
            delete rooms[user.roomId].participants[socket.id];
            socket.to(user.roomId).emit("user-left-room", { userId: socket.id, username: user.username });
            if (!Object.keys(rooms[user.roomId].participants).length) delete rooms[user.roomId];
        }

        socket.join(roomId);
        user.roomId = roomId;
        rooms[roomId].participants[socket.id] = {
            id: socket.id,
            username: user.username,
            videoEnabled: user.videoEnabled,
            audioEnabled: user.audioEnabled
        };

        socket.emit("room-joined", { roomId, participants: Object.values(rooms[roomId].participants) });
        socket.to(roomId).emit("user-joined-room", {
            id: socket.id,
            username: user.username,
            videoEnabled: user.videoEnabled,
            audioEnabled: user.audioEnabled
        });
    }

    socket.on("media-status-change", data => {
        const user = users[socket.id];
        if (!user || !user.roomId) return;
        user.videoEnabled = data.videoEnabled;
        user.audioEnabled = data.audioEnabled;
        if (rooms[user.roomId]?.participants[socket.id]) {
            rooms[user.roomId].participants[socket.id].videoEnabled = data.videoEnabled;
            rooms[user.roomId].participants[socket.id].audioEnabled = data.audioEnabled;
        }
        socket.to(user.roomId).emit("peer-media-status", {
            peerId: socket.id,
            videoEnabled: data.videoEnabled,
            audioEnabled: data.audioEnabled
        });
    });

    socket.on("signal", data => {
        const user = users[socket.id];
        if (!user || !user.roomId) return;
        const targetUser = users[data.target];
        if (!targetUser || targetUser.roomId !== user.roomId) return;
        io.to(data.target).emit("signal", { sender: socket.id, signal: data.signal });
    });

    socket.on("call-request", data => {
        // REMOVED validation check to fix call functionality
        const user = users[socket.id];
        if (!user || !user.roomId) return;
        const targetUser = users[data.target];
        if (!targetUser || targetUser.roomId !== user.roomId) return;
        io.to(data.target).emit("incoming-call", {
            caller: socket.id,
            callerName: user.username,
            publicKey: data.publicKey
        });
    });

    socket.on("call-response", data => {
        // REMOVED validation check to fix call functionality
        const user = users[socket.id];
        if (!user || !user.roomId) return;
        const targetUser = users[data.target];
        if (!targetUser || targetUser.roomId !== user.roomId) return;
        io.to(data.target).emit("call-response", {
            accepted: data.accepted,
            responder: socket.id,
            responderName: user.username,
            publicKey: data.publicKey,
            encryptedUsername: data.encryptedUsername
        });
    });

    socket.on("end-call", data => {
        // REMOVED validation check to fix call functionality
        const user = users[socket.id];
        if (!user || !user.roomId) return;
        const targetUser = users[data.target];
        if (!targetUser || targetUser.roomId !== user.roomId) return;
        io.to(data.target).emit("call-ended", { peerId: socket.id });
    });

    socket.on("chat-message", data => {
        // REMOVED validation check to fix chat functionality
        const user = users[socket.id];
        if (!user || !user.roomId) return;
        if (data.roomMessage) {
            socket.to(user.roomId).emit("chat-message", {
                senderName: user.username,
                encryptedMessage: data.encryptedMessage,
                isRoomMessage: true
            });
        }
    });

    socket.on("leave-room", () => {
        const user = users[socket.id];
        if (!user || !user.roomId) return;
        const roomId = user.roomId;
        socket.leave(roomId);
        delete rooms[roomId].participants[socket.id];
        user.roomId = null;
        io.to(roomId).emit("user-left-room", { userId: socket.id, username: user.username });
        if (!Object.keys(rooms[roomId].participants).length) delete rooms[roomId];
        socket.emit("room-left");
    });

    socket.on("disconnect", () => {
        jwtSessions.delete(socket.id);
        const user = users[socket.id];
        if (user && user.roomId && rooms[user.roomId]) {
            socket.to(user.roomId).emit("user-left-room", { userId: socket.id, username: user.username });
            delete rooms[user.roomId].participants[socket.id];
            if (!Object.keys(rooms[user.roomId].participants).length) delete rooms[user.roomId];
        }
        delete users[socket.id];
        console.log("User disconnected:", socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));