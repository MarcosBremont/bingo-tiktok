const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const HOST_PASSWORD = process.env.HOST_PASSWORD || "bingo2026";

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

    socket.on('createRoom', ({ password, hostPlay = false, cardCount = 1 }) => {
        if (password !== HOST_PASSWORD) {
            socket.emit('errorMsg', 'Clave de anfitrión incorrecta. Acceso denegado.');
            return;
        }

        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        
        let hostCards = [];
        if (hostPlay) {
            const count = Math.min(Math.max(parseInt(cardCount) || 1, 1), 3);
            for (let i = 0; i < count; i++) hostCards.push(generateBingoCard());
        }

        rooms[roomId] = {
            hostId: socket.id,
            hostPlay,
            hostCardCount: cardCount,
            hostCards: hostCards,
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

        room.players[socket.id] = { username, cards, cardCount: count };
        
        socket.join(roomId);
        socket.emit('joinedSuccess', { roomId, cards, history: room.drawnNumbers });
        
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

    socket.on('claimBingo', ({ roomId, username, cardIndex, markedNumbers }) => {
        const room = rooms[roomId];
        if (!room) return;

        let claimedCard = null;
        if (socket.id === room.hostId) {
            claimedCard = room.hostCards[cardIndex];
        } else if (room.players[socket.id]) {
            claimedCard = room.players[socket.id].cards[cardIndex];
        }

        if (claimedCard) {
            io.to(roomId).emit('bingoClaimed', { 
                username, 
                cardIndex, 
                card: claimedCard,
                markedNumbers: markedNumbers || [],
                drawnNumbers: room.drawnNumbers
            });
        }
    });

    socket.on('resetGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return;

        room.drawnNumbers = [];

        let newHostCards = [];
        if (room.hostPlay) {
            for (let i = 0; i < room.hostCardCount; i++) newHostCards.push(generateBingoCard());
        }
        room.hostCards = newHostCards;

        socket.emit('gameResetHost', { cards: newHostCards });

        for (const socketId in room.players) {
            const player = room.players[socketId];
            const newCards = [];
            for (let i = 0; i < player.cardCount; i++) newCards.push(generateBingoCard());
            player.cards = newCards;

            io.to(socketId).emit('gameResetPlayer', { cards: newCards });
        }
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
server.listen(PORT, () => console.log(`Servidor ejecutándose en puerto ${PORT}`));