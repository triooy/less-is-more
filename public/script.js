// --- DOM Elements ---
const joinCreateScreen = document.getElementById('join-create-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');

const nicknameInput = document.getElementById('nickname-input');
// const createGameBtn = document.getElementById('create-game-btn'); // Moved this declaration
// console.log('createGameBtn element:', createGameBtn);
const gameIdInput = document.getElementById('game-id-input');
const joinGameBtn = document.getElementById('join-game-btn');
const joinError = document.getElementById('join-error');

const lobbyGameId = document.getElementById('lobby-game-id');
const playerList = document.getElementById('player-list');
const startGameBtn = document.getElementById('start-game-btn');
const lobbyMessage = document.getElementById('lobby-message');

const gameCategory = document.getElementById('game-category');
const playerRole = document.getElementById('player-role');
const currentTurn = document.getElementById('current-turn');
const clueInputArea = document.getElementById('clue-input-area');
const secretWordDisplay = document.getElementById('secret-word-display'); // New ID
const secretWord = document.getElementById('secret-word');
const clueInput = document.getElementById('clue-input');
const submitClueBtn = document.getElementById('submit-clue-btn');
const clueLength = document.getElementById('clue-length');
const guessInputArea = document.getElementById('guess-input-area');
const currentClue = document.getElementById('current-clue');
const clueGiverName = document.getElementById('clue-giver-name');
const guessInput = document.getElementById('guess-input');
const submitGuessBtn = document.getElementById('submit-guess-btn');
const waitingArea = document.getElementById('waiting-area');
const waitingMessage = document.getElementById('waiting-message');
const gameInfo = document.getElementById('game-info');
const scoreList = document.getElementById('score-list');
const gameMessage = document.getElementById('game-message');

// --- WebSocket Connection ---
let ws;
let nickname = '';
let gameId = '';
let playerId = ''; // Unique ID assigned by server
let isHost = false;

function connectWebSocket() {
    // Determine WebSocket protocol (ws or wss)
    let protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let host = window.location.host;

    if (!host) {
        console.warn("window.location.host is undefined or empty. Falling back to localhost:3000 for WebSocket.");
        // Fallback for local development if host is not set (e.g. running file directly, though not ideal)
        host = 'localhost:3000';
        // If falling back, assume ws protocol unless page is explicitly https (unlikely for file://)
        if (window.location.protocol === 'https:') {
            protocol = 'wss:';
        } else {
            protocol = 'ws:';
        }
    }

    const wsUrl = `${protocol}//${host}`;
    console.log("Attempting to connect WebSocket to:", wsUrl); // Log the URL
    try {
        ws = new WebSocket(wsUrl);
    } catch (e) {
        console.error("Error constructing WebSocket:", e);
        updateJoinError(`WebSocket construction error: ${e.message}`);
        return;
    }

    ws.onopen = () => {
        console.log('WebSocket connection established');
        // You could potentially send an initial message here if needed
    };

    ws.onmessage = (event) => {
        console.log('Message from server:', event.data);
        try {
            const message = JSON.parse(event.data);
            handleServerMessage(message);
        } catch (error) {
            console.error("Failed to parse message or invalid message format:", event.data, error);
            // Display raw message if not JSON
            // Example: updateGameMessage(event.data);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateJoinError('Connection error. Please try again.');
        // Maybe try to reconnect or inform the user
    };

    ws.onclose = () => {
        console.log('WebSocket connection closed');
        // Handle disconnection, e.g., show message, disable buttons
        showScreen('join-create');
        updateJoinError('Disconnected from server.');
    };
}

// --- UI Screen Management ---
function showScreen(screenName) {
    joinCreateScreen.style.display = 'none';
    lobbyScreen.style.display = 'none';
    gameScreen.style.display = 'none';

    if (screenName === 'join-create') {
        joinCreateScreen.style.display = 'block';
    } else if (screenName === 'lobby') {
        lobbyScreen.style.display = 'block';
    } else if (screenName === 'game') {
        gameScreen.style.display = 'block';
    }
}

// --- Message Handling ---
function sendMessage(type, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const message = JSON.stringify({ type, payload });
        console.log('Sending message:', message);
        ws.send(message);
    } else {
        console.error('WebSocket is not connected.');
        updateJoinError('Not connected to server. Please refresh.');
    }
}

function handleServerMessage(message) {
    console.log("Handling message:", message); // Debugging line
    switch (message.type) {
        case 'welcome': // Example initial message
            console.log(message.payload.message);
            break;
        case 'assignPlayerId':
             playerId = message.payload.playerId;
             console.log("Assigned Player ID:", playerId);
             break;
        case 'gameCreated':
            gameId = message.payload.gameId;
            isHost = true;
            lobbyGameId.textContent = gameId;
            updatePlayerList(message.payload.players);
            showScreen('lobby');
            startGameBtn.style.display = 'block'; // Show start button for host
            lobbyMessage.textContent = 'Game created! Share the ID.';
            break;
        case 'gameJoined':
            gameId = message.payload.gameId;
            isHost = message.payload.isHost; // Server should tell us if we are host now
            lobbyGameId.textContent = gameId;
            updatePlayerList(message.payload.players);
            showScreen('lobby');
            startGameBtn.style.display = isHost ? 'block' : 'none'; // Show start button only if host
            lobbyMessage.textContent = `Joined game ${gameId}. Waiting for host to start...`;
            break;
        case 'updateLobby':
            updatePlayerList(message.payload.players);
            lobbyMessage.textContent = message.payload.message || 'Player joined/left.';
            break;
        case 'gameStarted':
            showScreen('game');
            updateGameState(message.payload.gameState);
            break;
        case 'updateGame':
             updateGameState(message.payload.gameState);
             break;
        case 'error':
            console.error('Server error:', message.payload.message);
            if (joinCreateScreen.style.display !== 'none') {
                updateJoinError(message.payload.message);
            } else if (lobbyScreen.style.display !== 'none') {
                lobbyMessage.textContent = `Error: ${message.payload.message}`;
            } else {
                updateGameMessage(`Error: ${message.payload.message}`);
            }
            break;
        // Add more cases for game-specific messages (clue submitted, guess made, round end, etc.)
        default:
            console.log('Unknown message type:', message.type);
    }
}

// --- UI Update Functions ---
function updateJoinError(message) {
    joinError.textContent = message;
}

function updateLobbyMessage(message) {
    lobbyMessage.textContent = message;
}

function updateGameMessage(message) {
    gameMessage.textContent = message;
}

function updatePlayerList(players) {
    playerList.innerHTML = ''; // Clear existing list
    players.forEach(player => {
        const li = document.createElement('li');
        li.textContent = `${player.nickname}${player.id === playerId ? ' (You)' : ''}${player.isHost ? ' (Host)' : ''}`;
        playerList.appendChild(li);
    });
}

function updateGameState(state) {
    console.log("Updating game state:", state);
    gameCategory.textContent = state.category || 'N/A';
    currentTurn.textContent = state.currentTurnPlayerNickname || 'N/A';
    updateScoreList(state.scores);
    updateGameMessage(state.message || '');

    const currentPlayer = state.players.find(p => p.id === playerId); // Still useful for other info like nickname
    if (!currentPlayer) {
        console.error("Current player data not found in game state players list!");
        // Potentially less critical if state.role is the primary source of truth for role
    }

    const currentClientRole = state.role; // Use state.role directly
    playerRole.textContent = currentClientRole || 'Waiting';

    // Reset areas
    clueInputArea.style.display = 'none';
    guessInputArea.style.display = 'none';
    waitingArea.style.display = 'block'; // Default to waiting

    // Show relevant input area based on role and game phase
    if (state.phase === 'clueGiving') {
        if (currentClientRole === 'Clue Giver') {
            secretWord.textContent = state.word || ''; // Show word to clue givers
            secretWordDisplay.style.display = 'block';
            clueInputArea.style.display = 'block';
            guessInputArea.style.display = 'none';
            waitingArea.style.display = 'none';
            // For clue, we might need to find the player's specific submitted clue from state if it's stored per player
            // Assuming state.clue is the current player's submitted clue if available
            clueInput.value = state.clue || ''; 
            updateClueLength(); // Update length display
            // hasSubmittedClue should also come from the root of the state for the current player
            // For now, let's assume server sends a specific flag if needed, or client tracks it.
            // Let's check if the player object from the list has this info, if not, server needs to send it.
            const thisPlayerFromList = state.players.find(p => p.id === playerId);
            submitClueBtn.disabled = thisPlayerFromList?.hasSubmittedClue || false;
            // waitingMessage.textContent is not needed here as waitingArea is hidden
        } else if (currentClientRole === 'Guesser') {
            secretWordDisplay.style.display = 'none';
            clueInputArea.style.display = 'none';
            guessInputArea.style.display = 'none';
            waitingArea.style.display = 'block';
            waitingMessage.textContent = 'You are the Guesser! Waiting for clues...';
        } else { // Spectator or undefined role
            secretWordDisplay.style.display = 'none';
            clueInputArea.style.display = 'none';
            guessInputArea.style.display = 'none';
            waitingArea.style.display = 'block';
            waitingMessage.textContent = 'Waiting for clues...';
        }
    } else if (state.phase === 'guessing') {
        if (currentClientRole === 'Guesser') {
             if (state.currentClue && state.currentClueGiverNickname) {
                 secretWordDisplay.style.display = 'none';
                 clueInputArea.style.display = 'none';
                 guessInputArea.style.display = 'block';
                 waitingArea.style.display = 'none';
                 currentClue.textContent = state.currentClue;
                 clueGiverName.textContent = state.currentClueGiverNickname;
                 guessInput.value = ''; // Clear previous guess
                 submitGuessBtn.disabled = false;
                 // waitingMessage.textContent is not needed here
             } else {
                 // Waiting for the first clue to be revealed
                 secretWordDisplay.style.display = 'none';
                 clueInputArea.style.display = 'none';
                 guessInputArea.style.display = 'none';
                 waitingArea.style.display = 'block';
                 waitingMessage.textContent = 'Waiting for the first clue...';
             }
        } else { // Clue Givers and Spectators during guessing phase
            secretWordDisplay.style.display = 'none';
            clueInputArea.style.display = 'none';
            guessInputArea.style.display = 'none';
            waitingArea.style.display = 'block';
            waitingMessage.textContent = `Waiting for ${state.currentTurnPlayerNickname || 'Guesser'} to guess.`;
            if (state.currentClue && state.currentClueGiverNickname) {
                 waitingMessage.textContent += ` (Current Clue: "${state.currentClue}" from ${state.currentClueGiverNickname})`;
            }
        }
    } else if (state.phase === 'roundOver' || state.phase === 'gameOver') {
        secretWordDisplay.style.display = 'block'; // Show the word at the end of round/game
        secretWord.textContent = state.word || 'N/A'; // Display the word
        clueInputArea.style.display = 'none';
        guessInputArea.style.display = 'none';
        waitingArea.style.display = 'block';
        waitingMessage.textContent = state.message || (state.phase === 'gameOver' ? 'Game Over!' : 'Round Over!');
    } else { // Lobby or other undefined phases
        secretWordDisplay.style.display = 'none';
        clueInputArea.style.display = 'none';
        guessInputArea.style.display = 'none';
        waitingArea.style.display = 'block';
        waitingMessage.textContent = state.message || 'Waiting...';
    }
}


function updateScoreList(scores) {
    scoreList.innerHTML = ''; // Clear existing scores
    if (scores) {
        for (const [name, score] of Object.entries(scores)) {
            const li = document.createElement('li');
            li.textContent = `${name}: ${score}`;
            scoreList.appendChild(li);
        }
    }
}

function countLetters(text) {
    return (text.match(/[a-zA-Z]/g) || []).length;
}

function updateClueLength() {
    clueLength.textContent = countLetters(clueInput.value);
}


// --- Event Listeners Setup ---
function setupEventListeners() {
    const createGameBtn = document.getElementById('create-game-btn'); // Moved declaration here
    console.log('createGameBtn element inside setupEventListeners:', createGameBtn);
    createGameBtn.addEventListener('click', () => {
        nickname = nicknameInput.value.trim();
        if (!nickname) {
            updateJoinError('Please enter a nickname.');
            return;
        }
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            updateJoinError('Connecting to server... try again shortly.');
            connectWebSocket(); // Attempt to connect if not already
            return; // Wait for connection
        }
        updateJoinError('');
        console.log('Attempting to send createGame message...'); // Add this log
        sendMessage('createGame', { nickname });
    });

    joinGameBtn.addEventListener('click', () => {
        nickname = nicknameInput.value.trim();
        const idToJoin = gameIdInput.value.trim();
        if (!nickname) {
            updateJoinError('Please enter a nickname.');
            return;
        }
        if (!idToJoin) {
            updateJoinError('Please enter a Game ID.');
            return;
        }
         if (!ws || ws.readyState !== WebSocket.OPEN) {
            updateJoinError('Connecting to server... try again shortly.');
            connectWebSocket(); // Attempt to connect if not already
            return; // Wait for connection
        }
        updateJoinError('');
        sendMessage('joinGame', { nickname, gameId: idToJoin });
    });

    startGameBtn.addEventListener('click', () => {
        if (isHost) {
            sendMessage('startGame', { gameId });
        }
    });

    clueInput.addEventListener('input', updateClueLength);

    submitClueBtn.addEventListener('click', () => {
        const clueText = clueInput.value.trim();
        // Basic validation (server should do more robust validation)
        if (!clueText) {
            updateGameMessage("Clue cannot be empty.");
            return;
        }
        if (/[^a-zA-Z\s]/.test(clueText)) {
             updateGameMessage("Clue can only contain letters and spaces.");
             return;
        }

        sendMessage('submitClue', { gameId, playerId, clue: clueText });
        submitClueBtn.disabled = true; // Prevent double submission
        updateGameMessage("Clue submitted. Waiting for others...");
    });

    submitGuessBtn.addEventListener('click', () => {
        const guessText = guessInput.value.trim();
        if (!guessText) {
            updateGameMessage("Guess cannot be empty.");
            return;
        }
        sendMessage('submitGuess', { gameId, playerId, guess: guessText });
        submitGuessBtn.disabled = true; // Prevent double submission
        updateGameMessage("Guess submitted. Waiting for result...");
    });
}

// --- Initial Setup ---
// Wait for the DOM to be fully loaded before setting up listeners and connecting
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed");
    console.log("About to call setupEventListeners..."); // Add this log
    setupEventListeners();
    showScreen('join-create');
    connectWebSocket(); // Connect automatically on page load
});
