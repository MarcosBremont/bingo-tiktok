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

function generateRoomCode(length = 6) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function getBingoLetter(num) {
    if (num >= 1 && num <= 15) return 'B';
    if (num >= 16 && num <= 30) return 'I';
    if (num >= 31 && num <= 45) return 'N';
    if (num >= 46 && num <= 60) return 'G';
    if (num >= 61 && num <= 75) return 'O';
    return '';
}

let gameState = {
    roomCode: generateRoomCode(),
    drawnNumbers: [],
    drawnHistory: [],
    lastDrawnBall: null,
    players: {},
    winModes: ['line', 'diagonal', 'corners', 'full'],
    tikTokUsername: '',
    isConnectedTikTok: false
};

let tiktokLiveConnection = null;

io.on('connection', (socket) => {
    socket.emit('gameStateUpdate', gameState);

    socket.on('authHost', (password, callback) => {
        if (password === HOST_PASSWORD) {
            callback({ success: true, roomCode: gameState.roomCode });
        } else {
            callback({ success: false, message: 'Contraseña incorrecta' });
        }
    });

    socket.on('regenerateRoomCode', ({ password }, callback) => {
        if (password !== HOST_PASSWORD) return;
        gameState.roomCode = generateRoomCode();
        gameState.players = {};
        io.emit('gameStateUpdate', gameState);
        if (callback) callback({ success: true, roomCode: gameState.roomCode });
    });

    socket.on('updateWinModes', ({ password, modes }) => {
        if (password !== HOST_PASSWORD) return;
        if (Array.isArray(modes)) {
            gameState.winModes = modes;
            io.emit('winModesUpdated', gameState.winModes);
        }
    });

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
            const ballData = {
                number: num,
                letter: getBingoLetter(num),
                formatted: `${getBingoLetter(num)}${num}`
            };

            gameState.drawnNumbers.push(num);
            gameState.drawnHistory.push(ballData);
            gameState.lastDrawnBall = ballData;

            io.emit('numberDrawn', {
                ball: ballData,
                drawnNumbers: gameState.drawnNumbers,
                drawnHistory: gameState.drawnHistory
            });
        }
    });

    socket.on('resetGame', ({ password }) => {
        if (password !== HOST_PASSWORD) return;
        gameState.drawnNumbers = [];
        gameState.drawnHistory = [];
        gameState.lastDrawnBall = null;
        gameState.roomCode = generateRoomCode();
        gameState.players = {};
        io.emit('gameReset');
        io.emit('gameStateUpdate', gameState);
    });

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
                patterns: validation.matchedPatterns,
                winningBalls: validation.winningBalls
            });
        } else {
            socket.emit('bingoRejected', {
                reason: 'Tu cartón aún no cumple con los modos activos según las balotas que han salido.'
            });
        }
    });

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
                                patterns: val.matchedPatterns,
                                winningBalls: val.winningBalls
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
    const winningBallsSet = new Set();

    if (activeModes.includes('line')) {
        // Horizontales
        for (let r = 0; r < 5; r++) {
            if (grid[r].every(Boolean)) {
                matchedPatterns.push('Línea Horizontal');
                card[r].forEach(val => { if (val !== 'FREE') winningBallsSet.add(val); });
            }
        }
        // Verticales
        for (let c = 0; c < 5; c++) {
            if (grid.every(row => row[c])) {
                matchedPatterns.push('Línea Vertical');
                for (let r = 0; r < 5; r++) {
                    if (card[r][c] !== 'FREE') winningBallsSet.add(card[r][c]);
                }
            }
        }
    }

    if (activeModes.includes('diagonal')) {
        const diag1 = [0, 1, 2, 3, 4].every(i => grid[i][i]);
        const diag2 = [0, 1, 2, 3, 4].every(i => grid[i][4 - i]);
        
        if (diag1) {
            matchedPatterns.push('Diagonal ↘');
            [0, 1, 2, 3, 4].forEach(i => { if (card[i][i] !== 'FREE') winningBallsSet.add(card[i][i]); });
        }
        if (diag2) {
            matchedPatterns.push('Diagonal ↙');
            [0, 1, 2, 3, 4].forEach(i => { if (card[i][4 - i] !== 'FREE') winningBallsSet.add(card[i][4 - i]); });
        }
    }

    if (activeModes.includes('corners')) {
        if (grid[0][0] && grid[0][4] && grid[4][0] && grid[4][4]) {
            matchedPatterns.push('4 Esquinas');
            [card[0][0], card[0][4], card[4][0], card[4][4]].forEach(val => {
                if (val !== 'FREE') winningBallsSet.add(val);
            });
        }
    }

    if (activeModes.includes('full')) {
        if (grid.every(row => row.every(Boolean))) {
            matchedPatterns.push('Cartón Lleno');
            card.forEach(row => row.forEach(val => { if (val !== 'FREE') winningBallsSet.add(val); }));
        }
    }

    const formattedWinningBalls = Array.from(winningBallsSet).map(num => `${getBingoLetter(num)}${num}`);

    return {
        isWinner: matchedPatterns.length > 0,
        matchedPatterns: matchedPatterns,
        winningBalls: formattedWinningBalls
    };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));