const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function getUniqueNumbers(min, max, count) {
    const nums = new Set();
    while (nums.size < count) {
        nums.add(Math.floor(Math.random() * (max - min + 1)) + min);
    }
    return Array.from(nums);
}

function generateBingoCard() {
    const b = getUniqueNumbers(1, 15, 5);
    const i = getUniqueNumbers(16, 30, 5);
    const n = getUniqueNumbers(31, 45, 4);
    const g = getUniqueNumbers(46, 60, 5);
    const o = getUniqueNumbers(61, 75, 5);

    const card = [];
    for (let r = 0; r < 5; r++) {
        card.push([
            b[r],
            i[r],
            r === 2 ? "LIBRE" : (r > 2 ? n[r - 1] : n[r]),
            g[r],
            o[r]
        ]);
    }
    return card;
}

function getPlayerList(roomId) {
    if (!rooms[roomId]) return [];
    return Object.values(rooms[roomId].players).map(p => p.username);
}

io.on('connection', (socket) => {

    socket.on('createRoom', ({ hostPlay = false, cardCount = 1 }) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        
        let hostCards = [];
        if (hostPlay) {
            const count = Math.min(Math.max(parseInt(cardCount) || 1, 1), 3);
            for (let i = 0; i < count; i++) hostCards.push(generateBingoCard());
        }

        rooms[roomId] = {
            hostId: socket.id,
            drawnNumbers: [],
            players: {}
        };

        socket.join(roomId);
        socket.emit('roomCreated', { roomId, cards: hostCards });
    });

    socket.on('joinRoom', ({ roomId, username, cardCount }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('errorMsg', 'La sala no existe o ha expirado.');
            return;
        }

        const count = Math.min(Math.max(parseInt(cardCount) || 1, 1), 3);
        const cards = [];
        for (let i = 0; i < count; i++) cards.push(generateBingoCard());

        room.players[socket.id] = { username, cards };
        
        socket.join(roomId);
        socket.emit('joinedSuccess', { roomId, cards, history: room.drawnNumbers });
        
        // Notificar al anfitrión con la lista de usuarios
        io.to(room.hostId).emit('updatePlayersList', { 
            players: getPlayerList(roomId)
        });
    });

    socket.on('drawBall', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return;

        if (room.drawnNumbers.length >= 75) {
            socket.emit('errorMsg', 'Ya salieron las 75 balotas.');
            return;
        }

        let num;
        do {
            num = Math.floor(Math.random() * 75) + 1;
        } while (room.drawnNumbers.includes(num));

        room.drawnNumbers.push(num);

        io.to(roomId).emit('newBall', { 
            ball: num, 
            history: room.drawnNumbers 
        });
    });

    socket.on('claimBingo', ({ roomId, username, cardIndex }) => {
        const room = rooms[roomId];
        if (!room) return;

        io.to(room.hostId).emit('bingoClaimed', { username, cardIndex });
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            if (rooms[roomId] && rooms[roomId].players[socket.id]) {
                delete rooms[roomId].players[socket.id];
                io.to(rooms[roomId].hostId).emit('updatePlayersList', { 
                    players: getPlayerList(roomId)
                });
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));