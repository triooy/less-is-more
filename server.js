const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');
const csv = require('csv-parser');
const { v4: uuidv4 } = require('uuid'); // For generating unique IDs

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// --- Game Data ---
let wordsByCategory = {};
const games = {}; // Stores active games { gameId: gameData }

// --- Utility Functions ---
function loadWords() {
    try {
        const results = [];
        const stream = fs.createReadStream(path.join(__dirname, 'words.csv'));
        stream.on('error', (error) => { // Add error handler for file stream
            console.error('Error reading words.csv stream:', error);
            // Handle this critical error - maybe set wordsByCategory to empty or default
            wordsByCategory = {};
        });
        stream.pipe(csv())
            .on('data', (data) => results.push(data))
            .on('end', () => {
                wordsByCategory = results.reduce((acc, row) => {
                    const category = row.Category;
                    const word = row.Word;
                    if (!acc[category]) {
                        acc[category] = [];
                    }
                    acc[category].push(word);
                    return acc;
                }, {});
                console.log('Words loaded successfully by category:', Object.keys(wordsByCategory));
            })
            .on('error', (error) => { // Add error handler for csv parser
                console.error('Error parsing words.csv:', error);
                wordsByCategory = {}; // Fallback
            });
    } catch (error) {
        console.error('Critical error during loadWords setup:', error);
        wordsByCategory = {}; // Fallback
    }
}

function generateGameId() {
    // Simple 4-digit ID for easy sharing
    let id;
    do {
        id = Math.floor(1000 + Math.random() * 9000).toString();
    } while (games[id]); // Ensure uniqueness
    return id;
}

function broadcast(gameId, message, senderWs = null) {
    const game = games[gameId];
    if (!game) return;

    const messageString = JSON.stringify(message);
    console.log(`Broadcasting to game ${gameId}:`, messageString);

    game.players.forEach(player => {
        // Send to everyone including sender, or exclude sender if senderWs is provided
        if (player.ws && player.ws.readyState === WebSocket.OPEN) {
             if (!senderWs || player.ws !== senderWs) {
                 player.ws.send(messageString);
             }
        }
    });
     // Also send to sender if not excluded (useful for confirmation messages)
     if (senderWs && senderWs.readyState === WebSocket.OPEN && message.type !== 'updateLobby') { // Avoid double lobby updates for sender
         // senderWs.send(messageString); // Decide if sender needs the broadcast too
     }
}

function sendToPlayer(ws, type, payload) {
     if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, payload }));
    }
}

function getGameState(gameId, perspectivePlayerId = null) {
    const game = games[gameId];
    if (!game) return null;

    // Base state visible to everyone
    const baseState = {
        gameId: game.id,
        players: game.players.map(p => ({
            id: p.id,
            nickname: p.nickname,
            isHost: p.isHost,
            hasSubmittedClue: p.hasSubmittedClue, // Useful for lobby/waiting display
            // Don't include ws object or sensitive info like full clue here
        })),
        scores: game.scores,
        phase: game.phase,
        category: game.currentCategory,
        currentTurnPlayerId: game.currentTurnPlayerId,
        currentTurnPlayerNickname: game.players.find(p => p.id === game.currentTurnPlayerId)?.nickname,
        message: game.message,
        // Guessing phase specific
        currentClue: null, // Only send if guessing phase and relevant
        currentClueGiverNickname: null,
    };

     // Add phase-specific details
     if (game.phase === 'guessing' && game.currentClueIndex < game.orderedClues.length) {
        const currentClueInfo = game.orderedClues[game.currentClueIndex];
        const clueGiver = game.players.find(p => p.id === currentClueInfo.playerId);
        baseState.currentClue = currentClueInfo.clue;
        baseState.currentClueGiverNickname = clueGiver?.nickname;
     }


    // Add perspective-specific details if perspectivePlayerId is provided
    if (perspectivePlayerId) {
        console.log(`[getGameState for ${game.id}] Perspective Player ID: ${perspectivePlayerId}`);
        const player = game.players.find(p => p.id === perspectivePlayerId);
        if (player) {
            console.log(`[getGameState for ${game.id}] Found player for perspective: ${player.nickname}, Role: ${player.role}`);
            baseState.playerId = player.id; // Confirm player's own ID
            baseState.role = player.role;
            // Show the word only to clue givers during clue giving phase
            if (game.phase === 'clueGiving' && player.role === 'Clue Giver') {
                baseState.word = game.currentWord;
            }
             // Include submitted clue for the player themselves
             if (player.clue) {
                 baseState.clue = player.clue;
             }
        }
    }


    return baseState;
}

function countLetters(text) {
    return (text.match(/[a-zA-Z]/g) || []).length;
}

function startGameLogic(gameId) {
    const game = games[gameId];
    if (!game || game.players.length < 2) { // Need at least 2 players
        sendToPlayer(game.players.find(p => p.isHost)?.ws, 'error', { message: 'Need at least 2 players to start.' });
        return;
    }

    game.phase = 'clueGiving';
    game.round++;
    game.message = `Round ${game.round} starting!`;
    game.currentClueIndex = -1; // Reset clue index
    game.orderedClues = []; // Reset clues

    // Reset player states for the round
    game.players.forEach(p => {
        p.role = '';
        p.clue = '';
        p.clueLength = -1;
        p.hasSubmittedClue = false;
    });

    // 1. Select Guesser (e.g., rotate based on join order or previous guesser)
    // Simple rotation for now:
    const guesserIndex = (game.round - 1) % game.players.length;
    game.players.forEach((p, index) => { // Ensure roles are reset before assigning
        p.role = '';
    });
    const guesser = game.players[guesserIndex];
    guesser.role = 'Guesser';
    game.currentTurnPlayerId = guesser.id; // Guesser is the 'turn' player initially
    console.log(`[startGameLogic for ${game.id}] Guesser selected: ${guesser.nickname} (ID: ${guesser.id})`);

    // Assign 'Clue Giver' role to others
    game.players.forEach(p => {
        if (p.id !== guesser.id) {
            p.role = 'Clue Giver';
            console.log(`[startGameLogic for ${game.id}] Clue Giver: ${p.nickname} (ID: ${p.id})`);
        }
    });

    // 2. Select Category and Word
    const categories = Object.keys(wordsByCategory);
    if (categories.length === 0) {
         game.message = "Error: No word categories loaded!";
         // Handle this error - maybe end game
         broadcast(gameId, { type: 'error', payload: { message: game.message } });
         return;
    }
    game.currentCategory = categories[Math.floor(Math.random() * categories.length)];
    const wordsInCateogry = wordsByCategory[game.currentCategory];
    game.currentWord = wordsInCateogry[Math.floor(Math.random() * wordsInCateogry.length)];

    console.log(`[Game ${gameId}] Starting Round ${game.round}. Category: ${game.currentCategory}, Word: ${game.currentWord}, Guesser: ${guesser.nickname}`);

    // 3. Notify players of game start and their roles/word
    game.players.forEach(player => {
        sendToPlayer(player.ws, 'gameStarted', { gameState: getGameState(gameId, player.id) });
    });
}

function processClues(gameId) {
     const game = games[gameId];
     if (!game || game.phase !== 'clueGiving') return;

     const clueGivers = game.players.filter(p => p.role === 'Clue Giver');
     const allSubmitted = clueGivers.every(p => p.hasSubmittedClue);

     if (allSubmitted) {
         console.log(`[Game ${gameId}] All clues submitted.`);
         game.phase = 'guessing';
         game.message = 'All clues are in! Time to guess.';

         // Order clues by length (ascending), then by join order (ascending)
         game.orderedClues = clueGivers
             .map(p => ({ playerId: p.id, clue: p.clue, length: p.clueLength, joinOrder: p.joinOrder }))
             .sort((a, b) => {
                 if (a.length !== b.length) {
                     return a.length - b.length; // Sort by length first
                 }
                 return a.joinOrder - b.joinOrder; // Then by join order for ties
             });

         game.currentClueIndex = 0; // Start with the first clue (lowest length)

         // Update turn player ID to the guesser
         const guesser = game.players.find(p => p.role === 'Guesser');
         if (guesser) {
             game.currentTurnPlayerId = guesser.id;
             game.message += ` ${guesser.nickname}, your turn to guess!`;
         } else {
             console.error(`[Game ${gameId}] No guesser found when processing clues!`);
             // Handle error
         }


         // Broadcast updated game state to all players
         game.players.forEach(player => {
             sendToPlayer(player.ws, 'updateGame', { gameState: getGameState(gameId, player.id) });
         });
     }
}

function processGuess(gameId, guesserId, guess) {
    const game = games[gameId];
    if (!game || game.phase !== 'guessing') return;

    const guesser = game.players.find(p => p.id === guesserId);
    if (!guesser || guesser.role !== 'Guesser') {
        console.warn(`[Game ${gameId}] Invalid guess attempt by non-guesser or unknown player ${guesserId}`);
        return; // Ignore invalid guess attempts
    }

    const currentClueInfo = game.orderedClues[game.currentClueIndex];
    const clueGiver = game.players.find(p => p.id === currentClueInfo.playerId);

    const isCorrect = guess.trim().toLowerCase() === game.currentWord.toLowerCase();

    if (isCorrect) {
        console.log(`[Game ${gameId}] Guess correct!`);
        game.phase = 'roundOver';
        const points = game.players.length; // Points based on total players in game
        game.scores[guesser.nickname] = (game.scores[guesser.nickname] || 0) + points;
        if (clueGiver) {
            game.scores[clueGiver.nickname] = (game.scores[clueGiver.nickname] || 0) + points;
        }
        game.message = `${guesser.nickname} guessed correctly! The word was "${game.currentWord}". ${guesser.nickname} and ${clueGiver?.nickname || 'N/A'} get ${points} points.`;

        // TODO: Check for game over condition (e.g., score limit, number of rounds)

        // For now, just prepare for next round after a delay
        setTimeout(() => startGameLogic(gameId), 5000); // Start next round after 5s

    } else {
        console.log(`[Game ${gameId}] Guess incorrect.`);
        game.currentClueIndex++; // Move to the next clue

        if (game.currentClueIndex < game.orderedClues.length) {
            // More clues left
            const nextClueInfo = game.orderedClues[game.currentClueIndex];
            const nextClueGiver = game.players.find(p => p.id === nextClueInfo.playerId);
            game.message = `Incorrect guess. Next clue from ${nextClueGiver?.nickname || 'N/A'}.`;
            // Guesser's turn continues
        } else {
            // No more clues left, guesser failed
            game.phase = 'roundOver';
            game.message = `${guesser.nickname} couldn't guess the word "${game.currentWord}".`;
            // Award 1 point to all other players (clue givers)
            game.players.forEach(p => {
                if (p.role === 'Clue Giver') {
                    game.scores[p.nickname] = (game.scores[p.nickname] || 0) + 1;
                    game.message += ` ${p.nickname} gets 1 point.`
                }
            });

             // TODO: Check for game over condition

             // Prepare for next round
             setTimeout(() => startGameLogic(gameId), 5000);
        }
    }

    // Broadcast updated game state
    game.players.forEach(player => {
        sendToPlayer(player.ws, 'updateGame', { gameState: getGameState(gameId, player.id) });
    });
}


// --- WebSocket Server Logic ---

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (ws) => {
    const playerId = uuidv4(); // Assign unique ID to connection
    ws.playerId = playerId; // Attach ID to WebSocket object
    console.log(`Client connected: ${playerId}`);
    sendToPlayer(ws, 'assignPlayerId', { playerId }); // Send the ID back to the client

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
            console.log(`Received message from ${playerId}:`, data);
        } catch (e) {
            console.error(`Failed to parse message or invalid message format from ${playerId}:`, message);
            sendToPlayer(ws, 'error', { message: 'Invalid message format.' });
            return;
        }

        const { type, payload } = data;
        const gameId = payload?.gameId; // Get gameId if present
        const game = games[gameId];
        const player = game ? game.players.find(p => p.id === playerId) : null;


        switch (type) {
            case 'createGame':
                const newGameId = generateGameId();
                const hostNickname = payload.nickname || 'Host';
                const hostPlayer = {
                    id: playerId,
                    nickname: hostNickname,
                    ws: ws,
                    isHost: true,
                    joinOrder: 0, // Host is always first
                    score: 0,
                    // Round specific
                    role: '',
                    clue: '',
                    clueLength: -1,
                    hasSubmittedClue: false,
                };
                games[newGameId] = {
                    id: newGameId,
                    players: [hostPlayer],
                    phase: 'lobby', // 'lobby', 'clueGiving', 'guessing', 'roundOver', 'gameOver'
                    round: 0,
                    currentCategory: '',
                    currentWord: '',
                    currentTurnPlayerId: null,
                    orderedClues: [],
                    currentClueIndex: -1,
                    scores: { [hostNickname]: 0 },
                    message: '',
                };
                ws.gameId = newGameId; // Associate gameId with this player's ws connection
                console.log(`Game created: ${newGameId} by ${hostNickname} (${playerId})`);
                sendToPlayer(ws, 'gameCreated', {
                    gameId: newGameId,
                    players: games[newGameId].players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost }))
                 });
                break;

            case 'joinGame':
                const nickname = payload.nickname || 'Player';
                if (game) {
                    // Prevent joining if game already started? Or allow spectators? For now, only lobby join.
                    if (game.phase !== 'lobby') {
                         sendToPlayer(ws, 'error', { message: 'Game has already started.' });
                         return;
                    }
                    // Prevent duplicate nicknames?
                    if (game.players.some(p => p.nickname === nickname)) {
                         sendToPlayer(ws, 'error', { message: 'Nickname already taken in this game.' });
                         return;
                    }

                    const newPlayer = {
                        id: playerId,
                        nickname: nickname,
                        ws: ws,
                        isHost: false,
                        joinOrder: game.players.length, // Assign join order
                        score: 0,
                        role: '',
                        clue: '',
                        clueLength: -1,
                        hasSubmittedClue: false,
                    };
                    game.players.push(newPlayer);
                    game.scores[nickname] = 0; // Initialize score
                    ws.gameId = gameId; // Associate gameId with this player's ws connection
                    console.log(`${nickname} (${playerId}) joined game ${gameId}`);

                    // Notify the joining player
                    sendToPlayer(ws, 'gameJoined', {
                        gameId: gameId,
                        isHost: false, // Player joining is not the host
                        players: game.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost }))
                    });

                    // Notify all other players in the lobby
                    broadcast(gameId, {
                        type: 'updateLobby',
                        payload: {
                             players: game.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost })),
                             message: `${nickname} joined the lobby.`
                        }
                    }, ws); // Exclude sender from this broadcast

                } else {
                    sendToPlayer(ws, 'error', { message: 'Game not found.' });
                }
                break;

             case 'startGame':
                 if (game && player && player.isHost) {
                     console.log(`Host ${player.nickname} starting game ${gameId}`);
                     startGameLogic(gameId);
                 } else if (!game) {
                     sendToPlayer(ws, 'error', { message: 'Game not found.' });
                 } else if (!player.isHost) {
                     sendToPlayer(ws, 'error', { message: 'Only the host can start the game.' });
                 }
                 break;

             case 'submitClue':
                 if (game && player && player.role === 'Clue Giver' && game.phase === 'clueGiving') {
                     const clueText = payload.clue || '';
                     // Validate clue (allow English letters, German umlauts, eszett, and spaces)
                     if (/[^a-zA-Z\säöüÄÖÜß]/.test(clueText) || !clueText) {
                         sendToPlayer(ws, 'error', { message: 'Invalid clue. Only letters, German characters (äöüß), and spaces allowed.' });
                         return;
                     }
                     player.clue = clueText;
                     player.clueLength = countLetters(clueText);
                     player.hasSubmittedClue = true;
                     console.log(`[Game ${gameId}] Clue submitted by ${player.nickname}: "${player.clue}" (Length: ${player.clueLength})`);

                     // Confirm submission to player
                     sendToPlayer(ws, 'updateGame', { gameState: getGameState(gameId, playerId) }); // Send updated state back

                     // Check if all clues are submitted
                     processClues(gameId);

                 } else {
                      sendToPlayer(ws, 'error', { message: 'Cannot submit clue now.' });
                 }
                 break;

             case 'submitGuess':
                 if (game && player && player.role === 'Guesser' && game.phase === 'guessing') {
                     const guessText = payload.guess || '';
                     if (!guessText) {
                         sendToPlayer(ws, 'error', { message: 'Guess cannot be empty.' });
                         return;
                     }
                     console.log(`[Game ${gameId}] Guess submitted by ${player.nickname}: "${guessText}"`);
                     processGuess(gameId, playerId, guessText);
                 } else {
                     sendToPlayer(ws, 'error', { message: 'Cannot submit guess now.' });
                 }
                 break;

            default:
                console.log(`Unknown message type received from ${playerId}: ${type}`);
                sendToPlayer(ws, 'error', { message: `Unknown message type: ${type}` });
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected: ${playerId}`);
        const gameId = ws.gameId;
        if (gameId && games[gameId]) {
            const game = games[gameId];
            const playerIndex = game.players.findIndex(p => p.id === playerId);
            if (playerIndex !== -1) {
                const disconnectedPlayer = game.players[playerIndex];
                console.log(`${disconnectedPlayer.nickname} left game ${gameId}`);
                game.players.splice(playerIndex, 1);

                // If lobby, just update list
                if (game.phase === 'lobby') {
                     // If host disconnected, assign new host or end game?
                     if (disconnectedPlayer.isHost && game.players.length > 0) {
                         game.players[0].isHost = true; // Assign host to next player
                         console.log(`New host assigned in game ${gameId}: ${game.players[0].nickname}`);
                         // Notify new host?
                         sendToPlayer(game.players[0].ws, 'updateLobby', {
                             players: game.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost })),
                             message: 'You are now the host.'
                         });
                     }
                     // Broadcast update
                     broadcast(gameId, {
                         type: 'updateLobby',
                         payload: {
                             players: game.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost })),
                             message: `${disconnectedPlayer.nickname} left the lobby.`
                         }
                     });
                } else {
                     // Handle disconnection during active game (e.g., mark player as inactive, end round/game if critical role left?)
                     // Simple approach: just remove and notify others
                     broadcast(gameId, {
                         type: 'updateGame',
                         payload: { gameState: getGameState(gameId) } // Send generic state update
                     });
                     // Add specific message about player leaving?
                     game.message = `${disconnectedPlayer.nickname} disconnected.`;
                      broadcast(gameId, { type: 'updateGame', payload: { gameState: getGameState(gameId) } });

                     // TODO: More robust handling needed for mid-game disconnects (e.g., if guesser leaves)
                }


                // If no players left, delete the game
                if (game.players.length === 0) {
                    console.log(`Game ${gameId} is empty, deleting.`);
                    delete games[gameId];
                }
            }
        }
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for ${playerId}:`, error);
        // Handle error, maybe try to clean up player/game state if possible
         const gameId = ws.gameId;
         // Attempt cleanup similar to 'close' event
         // ... (add similar cleanup logic as in ws.on('close'))
    });

    // Send a simple welcome message (optional)
    // sendToPlayer(ws, 'welcome', { message: 'Welcome to Less is More!' });
});

// --- Server Start ---
try {
    loadWords(); // Load words when server starts
} catch (error) {
    console.error("Error executing loadWords:", error);
}


server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

server.on('error', (error) => { // Add error handler for the server itself
    if (error.code === 'EADDRINUSE') {
        console.error(`Error: Port ${PORT} is already in use.`);
    } else {
        console.error('Server error:', error);
    }
    process.exit(1); // Exit if server fails to start
});
