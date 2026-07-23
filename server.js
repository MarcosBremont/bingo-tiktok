const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static('public'));

// Estado del juego en memoria
let gameState = {
    drawnNumbers: [],
    players: {}, // socketId -> { id, username, cards: [] }
    winModes: ['line', 'diagonal', 'corners', 'full'], // Modos activos por defecto
    tikTokUsername: '',
    isConnectedTikTok: false
};

let tiktokLiveConnection = null;

io.on('connection', (socket) => {
    console.log(`Cliente conectado: ${socket.id}`);

    // Enviar estado inicial al conectar
    socket.emit('gameStateUpdate', gameState);

    // Configurar Modos de Victoria (Host)
    socket.on('updateWinModes', (modes) => {
        if (Array.isArray(modes)) {
            gameState.winModes = modes;
            io.emit('winModesUpdated', gameState.winModes);
            console.log('Modos de victoria actualizados:', gameState.winModes);
        }
    });

    // Iniciar / Reiniciar Juego (Host)
    socket.on('resetGame', () => {
        gameState.drawnNumbers = [];
        io.emit('gameReset');
        io.emit('gameStateUpdate', gameState);
        console.log('Juego reiniciado');
    });

    // Cantar número (Host)
    socket.on('drawNumber', (number) => {
        const num = parseInt(number);
        if (!isNaN(num) && num >= 1 && num <= 75 && !gameState.drawnNumbers.includes(num)) {
            gameState.drawnNumbers.push(num);
            io.emit('numberDrawn', { number: num, drawnNumbers: gameState.drawnNumbers });
        }
    });

    // Unirse como jugador
    socket.on('joinGame', ({ username, cardsCount }) => {
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

        socket.emit('yourCards', cards);
        io.emit('playersUpdated', Object.values(gameState.players));
    });

    // Cantar Bingo (Validación estricta con Modos Combinados)
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
            console.log(`¡BINGO VÁLIDO! ${player.username} ganó con patrones: ${validation.matchedPatterns.join(', ')}`);
        } else {
            socket.emit('bingoRejected', { reason: 'Tu cartón aún no cumple con ninguno de los modos de victoria activos.' });
        }
    });

    // Conectar a TikTok Live
    socket.on('connectTikTok', (uniqueId) => {
        if (!uniqueId) return;

        if (tiktokLiveConnection) {
            try { tiktokLiveConnection.disconnect(); } catch (e) {}
        }

        tiktokLiveConnection = new WebcastPushConnection(uniqueId);

        tiktokLiveConnection.connect().then(state => {
            gameState.tikTokUsername = uniqueId;
            gameState.isConnectedTikTok = true;
            io.emit('tikTokStatus', { connected: true, username: uniqueId });
            console.log(`Conectado a TikTok Live: ${uniqueId}`);
        }).catch(err => {
            gameState.isConnectedTikTok = false;
            socket.emit('tikTokStatus', { connected: false, error: err.toString() });
            console.error('Error al conectar con TikTok:', err);
        });

        // Escuchar comentarios de TikTok para unirse automáticamente o cantar bingo
        tiktokLiveConnection.on('chat', data => {
            io.emit('tikTokChat', { nickname: data.nickname, comment: data.comment });
            
            const comment = data.comment.trim().toLowerCase();
            if (comment === '!bingo') {
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
        console.log(`Cliente desconectado: ${socket.id}`);
    });
});

// --- FUNCIONES AUXILIARES DE BINGO ---

function generateBingoCard() {
    const ranges = [
        [1, 15],   // B
        [16, 30],  // I
        [31, 45],  // N
        [46, 60],  // G
        [61, 75]   // O
    ];

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

    card[2][2] = 'FREE'; // Casilla central libre
    return card;
}

function checkBingoWinner(card, drawnNumbers, activeModes) {
    const grid = card.map(row =>
        row.map(cell => cell === 'FREE' || drawnNumbers.includes(cell))
    );

    const matchedPatterns = [];

    // 1. Línea Horizontal / Vertical
    if (activeModes.includes('line')) {
        let hasLine = false;
        for (let r = 0; r < 5; r++) {
            if (grid[r].every(val => val)) { hasLine = true; break; }
        }
        if (!hasLine) {
            for (let c = 0; c < 5; c++) {
                if (grid.every(row => row[c])) { hasLine = true; break; }
            }
        }
        if (hasLine) matchedPatterns.push('Línea (Horizontal/Vertical)');
    }

    // 2. Diagonales
    if (activeModes.includes('diagonal')) {
        const diag1 = [0, 1, 2, 3, 4].every(i => grid[i][i]);
        const diag2 = [0, 1, 2, 3, 4].every(i => grid[i][4 - i]);
        if (diag1 || diag2) {
            matchedPatterns.push('Diagonal');
        }
    }

    // 3. 4 Esquinas
    if (activeModes.includes('corners')) {
        const corners = grid[0][0] && grid[0][4] && grid[4][0] && grid[4][4];
        if (corners) matchedPatterns.push('4 Esquinas');
    }

    // 4. Cartón Lleno (Blackout)
    if (activeModes.includes('full')) {
        const full = grid.every(row => row.every(val => val));
        if (full) matchedPatterns.push('Cartón Lleno (Blackout)');
    }

    return {
        isWinner: matchedPatterns.length > 0,
        matchedPatterns: matchedPatterns
    };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor de Bingo TikTok corriendo en el puerto ${PORT}`);
});