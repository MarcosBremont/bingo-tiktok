const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// Estado de las salas en memoria
const rooms = {};

// Helper para generar 5 números únicos en un rango
function getUniqueNumbers(min, max, count) {
    const nums = new Set();
    while (nums.size < count) {
        nums.add(Math.floor(Math.random() * (max - min + 1)) + min);
    }
    return Array.from(nums);
}

// Generador de cartón 5x5 estilo Bingo 75
function generateBingoCard() {
    const b = getUniqueNumbers(1, 15, 5);
    const i = getUniqueNumbers(16, 30, 5);
    const n = getUniqueNumbers(31, 45, 4); // 4 porque el centro es LIBRE
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

io.on('connection', (socket) => {

    // 1. El anfitrión crea la sala
    socket.on('createRoom', () => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomId] = {
            hostId: socket.id,
            drawnNumbers: [],
            players: {}
        };
        socket.join(roomId);
        socket.emit('roomCreated', { roomId });
    });

    // 2. Un jugador se une a la sala
    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('errorMsg', 'La sala no existe o ha expirado.');
            return;
        }

        const card = generateBingoCard();
        room.players[socket.id] = { username, card };
        
        socket.join(roomId);
        socket.emit('joinedSuccess', { roomId, card, history: room.drawnNumbers });
        
        // Notificar al anfitrión
        io.to(room.hostId).emit('playerJoined', { 
            id: socket.id, 
            username, 
            totalPlayers: Object.keys(room.players).length 
        });
    });

    // 3. El anfitrión saca una balota
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

        // Transmitir a todos los usuarios conectados en esta sala
        io.to(roomId).emit('newBall', { 
            ball: num, 
            history: room.drawnNumbers 
        });
    });

    // 4. Un jugador presiona ¡BINGO!
    socket.on('claimBingo', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) return;

        // Notificar al anfitrión en pantalla gigante
        io.to(room.hostId).emit('bingoClaimed', { username });
    });

    // Desconexión
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            if (rooms[roomId].players[socket.id]) {
                delete rooms[roomId].players[socket.id];
                io.to(rooms[roomId].hostId).emit('playerLeft', { 
                    totalPlayers: Object.keys(rooms[roomId].players).length 
                });
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(` Servidor ejecutándose en http://localhost:${PORT}`));