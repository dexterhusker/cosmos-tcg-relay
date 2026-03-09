// ── Cosmos TCG Relay Server ──────────────────────────────────────────
// Deploy to Railway or Render. Set PORT via env (auto-set by both platforms).
// Only dependency: ws
//
// Message protocol (client → server):
//   { type: 'create', name: 'PlayerName' }         → host creates room
//   { type: 'join',   name: 'PlayerName', code:'XXXXXX' } → guest joins
//   { type: 'game_action', payload: {...} }         → forwarded to opponent
//   { type: 'ping' }                                → keepalive
//
// Message protocol (server → client):
//   { type: 'room_created', code: 'XXXXXX' }
//   { type: 'connected',    opponentName: 'Name' }
//   { type: 'game_action',  payload: {...} }
//   { type: 'opponent_left' }
//   { type: 'error',        message: '...' }
//   { type: 'pong' }

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss  = new WebSocket.Server({ port: PORT });

// rooms: code → { host: WebSocket, guest: WebSocket|null, hostName, guestName }
const rooms = new Map();

function genCode() {
    // 6-digit numeric code, no ambiguous chars
    let code;
    let attempts = 0;
    do {
        code = String(Math.floor(100000 + Math.random() * 900000));
        attempts++;
        if (attempts > 10000) { code = null; break; }
    } while (rooms.has(code));
    return code;
}

function send(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    }
}

wss.on('connection', ws => {
    ws._roomCode = null;
    ws._role     = null; // 'host' | 'guest'
    ws._alive    = true;

    ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {

            case 'ping':
                ws._alive = true;
                send(ws, { type: 'pong' });
                break;

            case 'create': {
                // Clean up any previous room this socket owned
                if (ws._roomCode) rooms.delete(ws._roomCode);

                const code = genCode();
                if (!code) { send(ws, { type: 'error', message: 'Server busy, try again.' }); return; }

                const hostName = (msg.name || 'Player').slice(0, 32);
                rooms.set(code, { host: ws, guest: null, hostName, guestName: null });
                ws._roomCode = code;
                ws._role     = 'host';
                send(ws, { type: 'room_created', code });
                console.log(`[room] Created ${code} by "${hostName}" — ${rooms.size} rooms active`);
                break;
            }

            case 'join': {
                const code = String(msg.code || '').trim();
                const room = rooms.get(code);

                if (!room) {
                    send(ws, { type: 'error', message: 'Room not found. Check the code and try again.' });
                    return;
                }
                if (room.guest) {
                    send(ws, { type: 'error', message: 'Room is full.' });
                    return;
                }
                if (room.host === ws) {
                    send(ws, { type: 'error', message: 'Cannot join your own room.' });
                    return;
                }

                const guestName = (msg.name || 'Player').slice(0, 32);
                room.guest     = ws;
                room.guestName = guestName;
                ws._roomCode   = code;
                ws._role       = 'guest';

                // Notify both players — host is always the initiator (goes first)
                send(room.host,  { type: 'connected', opponentName: guestName,       isInitiator: true  });
                send(room.guest, { type: 'connected', opponentName: room.hostName,   isInitiator: false });
                console.log(`[room] ${code} filled: "${room.hostName}" vs "${guestName}"`);
                break;
            }

            case 'game_action': {
                const room = rooms.get(ws._roomCode);
                if (!room) return;
                const opponent = ws._role === 'host' ? room.guest : room.host;
                if (opponent) {
                    send(opponent, { type: 'game_action', payload: msg.payload });
                }
                break;
            }

            default:
                break;
        }
    });

    ws.on('close', () => {
        const code = ws._roomCode;
        if (!code) return;
        const room = rooms.get(code);
        if (!room) return;
        const opponent = ws._role === 'host' ? room.guest : room.host;
        if (opponent && opponent.readyState === WebSocket.OPEN) {
            send(opponent, { type: 'opponent_left' });
        }
        rooms.delete(code);
        console.log(`[room] ${code} closed — ${rooms.size} rooms remaining`);
    });

    ws.on('error', err => {
        console.warn('[ws] Socket error:', err.message);
    });
});

// Heartbeat — kill stale connections every 30s
const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws._alive) { ws.terminate(); return; }
        ws._alive = false;
        send(ws, { type: 'ping' });
    });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

console.log(`Cosmos TCG Relay listening on :${PORT}`);
