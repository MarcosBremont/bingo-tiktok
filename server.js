const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static('public'));

const HOST_PASSWORD = process.env.HOST_PASSWORD || "admin123";

// Función para generar un código de sala aleatorio único
function generateRoomCode(length = 6) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluye caracteres ambiguos
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

let gameState = {
    roomCode: generateRoomCode(),
    drawnNumbers: [],
    lastDrawnNumber: null,
    players: {},
    winModes: ['line', 'diagonal', 'corners', 'full'],
    tikTokUsername: '',
    isConnectedTikTok: false
};

let tiktokLiveConnection = null;

io.on('connection', (socket) => {
    socket.emit('gameStateUpdate', gameState);

    // Validar contraseña del Host
    socket.on('authHost', (password, callback) => {
        if (password === HOST_PASSWORD) {
            callback({ success: true, roomCode: gameState.roomCode });
        } else {
            callback({ success: false, message: 'Contraseña incorrecta' });
        }
    });

    // Cambiar / Regenerar Código de Sala (Host)
    socket.on('regenerateRoomCode', ({ password }, callback) => {
        if (password !== HOST_PASSWORD) return;
        gameState.roomCode = generateRoomCode();
        gameState.players = {}; // Limpia jugadores de la sala anterior
        io.emit('gameStateUpdate', gameState);
        if (callback) callback({ success: true, roomCode: gameState.roomCode });
    });

    // Actualizar Modos de Victoria (Host)
    socket.on('updateWinModes', ({ password, modes }) => {
        if (password !== HOST_PASSWORD) return;
        if (Array.isArray(modes)) {
            gameState.winModes = modes;
            io.emit('winModesUpdated', gameState.winModes);
        }
    });

    // Sacar Balota Aleatoria (Host)
    socket.on('drawRandomNumber', ({ password }) => {
        if (password !== HOST_PASSWORD) return;

        const available = [];
        for (let i = 1; i <= 75; i++) {
            if (!gameState.drawnNumbers.includes(i)) {
                available.push(i);
            }
        }

        if (available.length > 0) {
            const randomIndex = Math.floor(Math.random() * available.length);
            const num = available[randomIndex];
            gameState.drawnNumbers.push(num);
            gameState.lastDrawnNumber = num;

            io.emit('numberDrawn', {
                number: num,
                drawnNumbers: gameState.drawnNumbers
            });
        }
    });

    // Reiniciar Juego y Generar Nueva Sala (Host)
    socket.on('resetGame', ({ password }) => {
        if (password !== HOST_PASSWORD) return;
        gameState.drawnNumbers = [];
        gameState.lastDrawnNumber = null;
        gameState.roomCode = generateRoomCode();
        gameState.players = {};
        io.emit('gameReset');
        io.emit('gameStateUpdate', gameState);
    });

    // Unirse a la Sala (Jugador)
    socket.on('joinGame', ({ roomCode, username, cardsCount }, callback) => {
        const cleanRoomInput = (roomCode || '').trim().toUpperCase();
        if (cleanRoomInput !== gameState.roomCode) {
            return callback({ success: false, message: 'Código de sala inválido o expirado.' });
        }

        const count = Math.min(Math.max(parseInt(cardsCount) || 1, 1), 3);
        const cards = [];
        for (let i = 0; i < count; i++) {
            cards.push(generateBingoCard());
        }

        gameState.players[socket.id] = {
            id: socket.id,
            username: username || `Jugador_${socket.id.substring(0, 4)}`,
            cards: cards
        };

        callback({ success: true, cards: cards });
        io.emit('playersUpdated', Object.values(gameState.players));
    });

    // Reclamar Bingo (Jugador)
    socket.on('claimBingo', ({ cardIndex }) => {
        const player = gameState.players[socket.id];
        if (!player || !player.cards[cardIndex]) return;

        const card = player.cards[cardIndex];
        const validation = checkBingoWinner(card, gameState.drawnNumbers, gameState.winModes);

        if (validation.isWinner) {
            io.emit('bingoWinner', {
                username: player.username,
                socketId: socket.id,
                cardIndex: cardIndex,
                patterns: validation.matchedPatterns
            });
        } else {
            socket.emit('bingoRejected', {
                reason: 'Tu cartón aún no cumple con ninguno de los modos de victoria activos.'
            });
        }
    });

    // Conectar TikTok Live (Host)
    socket.on('connectTikTok', ({ password, uniqueId }) => {
        if (password !== HOST_PASSWORD) return;
        if (!uniqueId) return;

        if (tiktokLiveConnection) {
            try { tiktokLiveConnection.disconnect(); } catch (e) {}
        }

        tiktokLiveConnection = new WebcastPushConnection(uniqueId);

        tiktokLiveConnection.connect().then(() => {
            gameState.tikTokUsername = uniqueId;
            gameState.isConnectedTikTok = true;
            io.emit('tikTokStatus', { connected: true, username: uniqueId });
        }).catch(err => {
            gameState.isConnectedTikTok = false;
            io.emit('tikTokStatus', { connected: false, error: err.toString() });
        });

        tiktokLiveConnection.on('chat', data => {
            io.emit('tikTokChat', { nickname: data.nickname, comment: data.comment });
            
            if (data.comment.trim().toLowerCase() === '!bingo') {
                const playerSocketId = Object.keys(gameState.players).find(
                    id => gameState.players[id].username.toLowerCase() === data.nickname.toLowerCase()
                );
                if (playerSocketId) {
                    const player = gameState.players[playerSocketId];
                    player.cards.forEach((card, index) => {
                        const val = checkBingoWinner(card, gameState.drawnNumbers, gameState.winModes);
                        if (val.isWinner) {
                            io.emit('bingoWinner', {
                                username: player.username,
                                socketId: playerSocketId,
                                cardIndex: index,
                                patterns: val.matchedPatterns
                            });
                        }
                    });
                }
            }
        });
    });

    socket.on('disconnect', () => {
        delete gameState.players[socket.id];
        io.emit('playersUpdated', Object.values(gameState.players));
    });
});

function generateBingoCard() {
    const ranges = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];
    const card = Array(5).fill(null).map(() => Array(5).fill(null));

    for (let col = 0; col < 5; col++) {
        const [min, max] = ranges[col];
        const nums = new Set();
        while (nums.size < 5) {
            nums.add(Math.floor(Math.random() * (max - min + 1)) + min);
        }
        const colArray = Array.from(nums);
        for (let row = 0; row < 5; row++) {
            card[row][col] = colArray[row];
        }
    }
    card[2][2] = 'FREE';
    return card;
}

function checkBingoWinner(card, drawnNumbers, activeModes) {
    const drawnSet = new Set(drawnNumbers.map(Number));

    const grid = card.map(row =>
        row.map(cell => cell === 'FREE' || drawnSet.has(Number(cell)))
    );

    const matchedPatterns = [];

    if (activeModes.includes('line')) {
        let hasLine = false;
        for (let r = 0; r < 5; r++) {
            if (grid[r].every(Boolean)) { hasLine = true; break; }
        }
        if (!hasLine) {
            for (let c = 0; c < 5; c++) {
                if (grid.every(row => row[c])) { hasLine = true; break; }
            }
        }
        if (hasLine) matchedPatterns.push('Línea (Horizontal/Vertical)');
    }

    if (activeModes.includes('diagonal')) {
        const diag1 = [0, 1, 2, 3, 4].every(i => grid[i][i]);
        const diag2 = [0, 1, 2, 3, 4].every(i => grid[i][4 - i]);
        if (diag1 || diag2) matchedPatterns.push('Diagonal');
    }

    if (activeModes.includes('corners')) {
        if (grid[0][0] && grid[0][4] && grid[4][0] && grid[4][4]) {
            matchedPatterns.push('4 Esquinas');
        }
    }

    if (activeModes.includes('full')) {
        if (grid.every(row => row.every(Boolean))) {
            matchedPatterns.push('Cartón Lleno (Blackout)');
        }
    }

    return {
        isWinner: matchedPatterns.length > 0,
        matchedPatterns: matchedPatterns
    };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor de Bingo activo en puerto ${PORT}`));