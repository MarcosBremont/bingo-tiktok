const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Estado global de las salas
const rooms = {};

// Instancia global para TikTok Live
let tiktokLiveConnection = null;

io.on('connection', (socket) => {

    // 1. Crear Sala (Anfitrión)
    socket.on('createRoom', ({ password, hostPlay, cardCount, gamePattern }) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        
        rooms[roomId] = {
            password,
            drawnNumbers: [],
            totalBalls: 75,
            gamePattern: gamePattern || 'FULL',
            winnersHistory: [],
            players: {},
            hostCards: hostPlay ? generateCards(cardCount) : []
        };

        socket.join(roomId);
        socket.emit('roomCreated', { 
            roomId, 
            cards: rooms[roomId].hostCards,
            gamePattern: rooms[roomId].gamePattern
        });
    });

    // 2. Unirse a la Sala (Jugador / Overlay)
    socket.on('joinRoom', ({ roomId, username, cardCount }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMsg', 'La sala no existe.');

        socket.join(roomId);

        // Si no es la captura de OBS, registrarlo como jugador activo
        if (username !== 'Overlay_OBS') {
            const cards = generateCards(cardCount || 1);
            room.players[socket.id] = { username, cards };
            
            socket.emit('joinedSuccess', { 
                roomId, 
                cards, 
                history: room.drawnNumbers,
                gamePattern: room.gamePattern
            });

            io.to(roomId).emit('updatePlayersList', { 
                players: Object.values(room.players).map(p => p.username) 
            });
        }
    });

    // 3. Cambiar Patrón de Juego
    socket.on('changePattern', ({ roomId, pattern }) => {
        if (rooms[roomId]) {
            rooms[roomId].gamePattern = pattern;
            io.to(roomId).emit('patternUpdated', { pattern });
        }
    });

    // 4. Sacar Balota
    socket.on('drawBall', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        if (room.drawnNumbers.length >= room.totalBalls) {
            return socket.emit('errorMsg', 'Ya salieron todas las balotas (75/75).');
        }

        let nextBall;
        do {
            nextBall = Math.floor(Math.random() * 75) + 1;
        } while (room.drawnNumbers.includes(nextBall));

        room.drawnNumbers.push(nextBall);

        io.to(roomId).emit('newBall', { 
            ball: nextBall, 
            history: room.drawnNumbers,
            remaining: room.totalBalls - room.drawnNumbers.length
        });
    });

    // 5. Verificación y Canto de Bingo
    socket.on('claimBingo', ({ roomId, username, cardIndex, markedNumbers }) => {
        const room = rooms[roomId];
        if (!room) return;

        let playerCard;
        if (username.includes('Anfitrión')) {
            playerCard = room.hostCards[cardIndex];
        } else if (room.players[socket.id]) {
            playerCard = room.players[socket.id].cards[cardIndex];
        }

        if (!playerCard) return;

        // Comprobar si hubo números marcados que NO habían salido
        const badNumbers = markedNumbers.filter(n => !room.drawnNumbers.includes(n));
        const isValid = badNumbers.length === 0 && markedNumbers.length > 0;

        if (isValid) {
            const winnerEntry = {
                username,
                pattern: room.gamePattern,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            room.winnersHistory.unshift(winnerEntry);
            io.to(roomId).emit('updateWinners', { history: room.winnersHistory });
        }

        io.to(roomId).emit('bingoClaimed', {
            username,
            cardIndex,
            card: playerCard,
            markedNumbers,
            drawnNumbers: room.drawnNumbers
        });
    });

    // 6. Conexión con TikTok Live
    socket.on('connectTikTok', ({ tiktokUsername, roomId }) => {
        if (tiktokLiveConnection) {
            try { tiktokLiveConnection.disconnect(); } catch (e) {}
        }

        tiktokLiveConnection = new WebcastPushConnection(tiktokUsername);

        tiktokLiveConnection.connect().then(state => {
            socket.emit('tiktokConnected', { status: true });
        }).catch(err => {
            socket.emit('tiktokConnected', { status: false, error: err.message });
        });

        tiktokLiveConnection.on('chat', data => {
            io.to(roomId).emit('tiktokChatMessage', {
                user: data.uniqueId,
                comment: data.comment
            });
        });
    });

    // 7. Reiniciar Partida
    socket.on('resetGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        room.drawnNumbers = [];
        if (room.hostCards.length > 0) {
            room.hostCards = generateCards(room.hostCards.length);
        }

        Object.keys(room.players).forEach(id => {
            const count = room.players[id].cards.length;
            room.players[id].cards = generateCards(count);
            io.to(id).emit('gameResetPlayer', { cards: room.players[id].cards });
        });

        io.to(roomId).emit('gameResetHost', { cards: room.hostCards });
    });
});

// Función Auxiliar: Generar Cartones
function generateCards(count) {
    const cards = [];
    for (let i = 0; i < count; i++) {
        cards.push([
            getCol(1, 15),
            getCol(16, 30),
            getCol(31, 45, true),
            getCol(46, 60),
            getCol(61, 75)
        ]);
    }
    return cards;
}

function getCol(min, max, isMiddle = false) {
    const nums = [];
    while (nums.length < 5) {
        let n = Math.floor(Math.random() * (max - min + 1)) + min;
        if (!nums.includes(n)) nums.push(n);
    }
    if (isMiddle) nums[2] = 'LIBRE';
    return nums;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor de Bingo activo en http://localhost:${PORT}`);
});