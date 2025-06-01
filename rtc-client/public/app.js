// Connect to the signaling server
const DEFAULT_SIGNALING_SERVER = 'https://192.168.0.13:3000';
console.log('App started, using signaling server:', DEFAULT_SIGNALING_SERVER);
console.log('Connecting to signaling server...');
const socket = io(DEFAULT_SIGNALING_SERVER, {
    withCredentials: true,
    rejectUnauthorized: false, // Allow self-signed certificates
    transports: ['websocket', 'polling'],
    secure: true
});

// Add connection error handling
socket.on('connect_error', (error) => {
    console.error('Connection error:', error);
    alert('Failed to connect to signaling server. Please check if the server is running and try again.');
});

socket.on('connect', () => {
    console.log('Connected to signaling server:', DEFAULT_SIGNALING_SERVER);
});

// DOM elements
const usernameInput = document.getElementById('username');
const registerButton = document.getElementById('register');
const connectBtn = document.getElementById('connectBtn');
const usersList = document.getElementById('users');

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10
};

// Per-peer connection management
const peerConnections = {}; // peerConnections[peerUsername] = { peerConnection, dataChannel, ... }

let selectedUser = null;
let isInitiator = false;
let remoteCandidatesQueue = [];
let registeredUsername = null;
let dataChannel = null;
let chatMessages = [];

// Step 2: Automatic peer discovery and sync (logging only)
let registrationCompleted = false;
let autoConnectInProgress = false;
let autoConnectQueue = [];
let autoConnectedPeers = new Set();
let peerRetryCounts = {};
const MAX_PEER_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// --- Robust, event-driven, sequential connection strategy ---

// Set of peers we are already connected to
const connectedPeers = new Set();
// Queue of peers to connect to
let connectQueue = [];
let connectionInProgress = false;
const RETRY_DELAY = 2000;

registerButton.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    if (username) {
        socket.emit('register', username);
        registerButton.disabled = true;
        usernameInput.disabled = true;
        registeredUsername = username;
        registrationCompleted = true;
        console.log('[AutoSync] Registration completed as:', registeredUsername);
    }
});

socket.on('userList', async (users) => {
    if (!registrationCompleted || !registeredUsername) {
        console.log('[AutoSync] Registration not complete, skipping user list processing.');
        return;
    }
    console.log('[AutoSync] Received user list:', users);
    // For each peer in the list (except self, already connected, or already queued)
    users.forEach(peer => {
        if (
            peer !== registeredUsername &&
            !connectedPeers.has(peer) &&
            !connectQueue.includes(peer)
        ) {
            connectQueue.push(peer);
        }
    });
    tryConnectNextPeer();
});

async function tryConnectNextPeer() {
    if (connectionInProgress || connectQueue.length === 0) return;
    const peer = connectQueue.shift();
    connectionInProgress = true;
    try {
        // Deterministic initiator selection
        let isInitiator = false;
        if (registeredUsername > peer) {
            isInitiator = true;
            console.log(`[AutoSync] Initiator decision: ${registeredUsername} > ${peer} (I am initiator)`);
        } else {
            isInitiator = false;
            console.log(`[AutoSync] Initiator decision: ${registeredUsername} <= ${peer} (I am receiver)`);
        }
        await startPeerConnectionWithRetry(peer, isInitiator);
        connectedPeers.add(peer);
    } catch (e) {
        console.log(`[AutoSync] Connection to ${peer} failed, will retry after delay.`);
        connectQueue.push(peer);
        setTimeout(() => {
            connectionInProgress = false;
            tryConnectNextPeer();
        }, RETRY_DELAY);
        return;
    }
    connectionInProgress = false;
    tryConnectNextPeer();
}

async function startPeerConnectionWithRetry(peer, isInitiator) {
    peerRetryCounts[peer] = peerRetryCounts[peer] || 0;
    try {
        await startPeerConnection(peer, isInitiator);
    } catch (err) {
        console.error(`[AutoSync] Error initiating connection to ${peer}:`, err);
        if (peerRetryCounts[peer] < MAX_PEER_RETRIES) {
            peerRetryCounts[peer]++;
            console.log(`[AutoSync] Retrying connection to ${peer} in ${RETRY_DELAY_MS}ms (attempt ${peerRetryCounts[peer]})`);
            setTimeout(() => {
                startPeerConnectionWithRetry(peer, isInitiator);
            }, RETRY_DELAY_MS);
        } else {
            console.log(`[AutoSync] Max retries reached for ${peer}, skipping.`);
            autoConnectInProgress = false;
            tryAutoConnectNextPeer();
        }
    }
}

// Per-peer connection setup
async function startPeerConnection(peer, isInitiator) {
    if (peerConnections[peer]) {
        console.log(`[PeerConn] Connection to ${peer} already exists.`);
        return;
    }
    console.log(`[PeerConn] Creating new RTCPeerConnection for ${peer}`);
    const pc = new RTCPeerConnection(configuration);
    const connObj = {
        peerConnection: pc,
        dataChannel: null,
        remoteCandidatesQueue: [],
        isInitiator,
        sync: {
            localDbSummary: null,
            peerDbSummary: null,
            hasSentSummary: false,
            hasReceivedPeerSummary: false,
            hasRequestedMissing: false
        }
    };
    peerConnections[peer] = connObj;

    if (isInitiator) {
        console.log(`[PeerConn] (${peer}) Creating data channel for ICE gathering and chat`);
        connObj.dataChannel = pc.createDataChannel('chat');
        setupDataChannel(peer, connObj.dataChannel);
    } else {
        pc.ondatachannel = (event) => {
            console.log(`[PeerConn] (${peer}) Received data channel`);
            connObj.dataChannel = event.channel;
            setupDataChannel(peer, connObj.dataChannel);
        };
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`[PeerConn] (${peer}) Sending ICE candidate`, event.candidate);
            socket.emit('signal', {
                target: peer,
                signal: event.candidate,
                sender: registeredUsername
            });
        } else {
            console.log(`[PeerConn] (${peer}) ICE candidate gathering complete`);
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[PeerConn] (${peer}) ICE Connection State:`, pc.iceConnectionState);
        if (pc.iceConnectionState === 'connected') {
            console.log(`[PeerConn] (${peer}) ICE connection established.`);
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`[PeerConn] (${peer}) Connection State:`, pc.connectionState);
        if (pc.connectionState === 'connected') {
            console.log(`[PeerConn] (${peer}) Peer connection established.`);
        }
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
            cleanupPeerConnection(peer);
        }
    };

    if (isInitiator) {
        console.log(`[PeerConn] (${peer}) Acting as initiator, creating offer`);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log(`[PeerConn] (${peer}) Sending offer`, offer);
        socket.emit('signal', {
            target: peer,
            signal: offer,
            sender: registeredUsername
        });
    } else {
        console.log(`[PeerConn] (${peer}) Acting as receiver, waiting for offer`);
    }
}

function cleanupPeerConnection(peer) {
    const connObj = peerConnections[peer];
    if (!connObj) return;
    if (connObj.dataChannel) {
        try { connObj.dataChannel.close(); } catch (e) {}
    }
    if (connObj.peerConnection) {
        try { connObj.peerConnection.close(); } catch (e) {}
    }
    delete peerConnections[peer];
    autoConnectInProgress = false;
    // Retry logic: if not max retries, requeue peer
    if ((peerRetryCounts[peer] || 0) < MAX_PEER_RETRIES) {
        console.log(`[AutoSync] Connection to ${peer} closed/disconnected, will retry.`);
        autoConnectQueue.push(peer);
    } else {
        console.log(`[AutoSync] Connection to ${peer} closed/disconnected, max retries reached.`);
    }
    tryAutoConnectNextPeer();
    console.log(`[PeerConn] Cleaned up connection to ${peer}`);
}

// --- Handle incoming signals ---
socket.on('signal', async (data) => {
    if (!data || !data.data || !data.sender) {
        console.warn('Malformed signal received:', data);
        return;
    }
    const peer = data.sender === registeredUsername ? data.target : data.sender;
    if (!peerConnections[peer]) {
        // If not initiator, create connection on demand
        await startPeerConnection(peer, false);
    }
    const connObj = peerConnections[peer];
    const pc = connObj.peerConnection;
    // --- WebRTC signaling as before ---
    try {
        if (data.data.type === 'offer') {
            if (pc.signalingState === 'stable') {
                await pc.setRemoteDescription(new RTCSessionDescription(data.data));
                await flushRemoteCandidates(peer);
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                socket.emit('signal', {
                    target: peer,
                    signal: answer,
                    sender: registeredUsername
                });
            } else {
                console.log(`[PeerConn] (${peer}) Offer received but signaling state is`, pc.signalingState, '- ignoring.');
            }
        } else if (data.data.type === 'answer') {
            if (pc.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(data.data));
            } else {
                console.log(`[PeerConn] (${peer}) Answer received but signaling state is`, pc.signalingState, '- ignoring.');
            }
        } else if (data.data.candidate) {
            if (pc.remoteDescription && pc.remoteDescription.type) {
                await pc.addIceCandidate(new RTCIceCandidate(data.data));
            } else {
                connObj.remoteCandidatesQueue.push(data.data);
            }
        }
    } catch (error) {
        console.error(`[PeerConn] (${peer}) Error handling signal:`, error);
    }
});

async function flushRemoteCandidates(peer) {
    const connObj = peerConnections[peer];
    const pc = connObj.peerConnection;
    if (pc && connObj.remoteCandidatesQueue.length > 0) {
        for (const candidate of connObj.remoteCandidatesQueue) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                console.warn(`[PeerConn] (${peer}) Failed to add remote ICE candidate:`, e);
            }
        }
        connObj.remoteCandidatesQueue = [];
    }
}

// Per-peer data channel and sync logic
function setupDataChannel(peer, dataChannel) {
    const connObj = peerConnections[peer];
    dataChannel.onopen = () => {
        console.log(`[chat][${peer}] Data channel open`);
        // Start sync: export and send summary
        console.log(`[${peer}] Data channel open. Exporting DB summary...`);
        exportDbSummary().then(summary => {
            connObj.sync.localDbSummary = summary;
            connObj.sync.hasSentSummary = true;
            console.log(`[${peer}] Exported local summary. Sending to peer...`);
            console.log(`[${peer}] Local summary: ` + JSON.stringify(summary));
            sendSyncMessage(peer, 'dbSummary', summary);
            tryCompareAndRequestMissing(peer);
        }).catch(err => {
            console.log(`[${peer}] Error exporting DB summary: ` + (err && err.stack ? err.stack : err));
        });
    };
    dataChannel.onclose = () => {
        console.log(`[chat][${peer}] Data channel closed`);
    };
    dataChannel.onmessage = async (event) => {
        try {
            console.log(`[${peer}] Received raw message: ` + event.data);
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch (jsonErr) {
                console.log(`[${peer}] Non-JSON message received: ` + event.data);
                return;
            }
            if (msg && msg.type === 'dbSummary') {
                console.log(`[${peer}] Received peer summary.`);
                console.log(`[${peer}] Peer summary: ` + JSON.stringify(msg.payload));
                connObj.sync.peerDbSummary = msg.payload;
                connObj.sync.hasReceivedPeerSummary = true;
                tryCompareAndRequestMissing(peer);
            } else if (msg.type === 'requestFolder') {
                console.log(`[${peer}] Received request for folder id=${msg.payload.id}`);
                const folder = (await getFolders()).find(f => f.id === msg.payload.id);
                if (folder) {
                    console.log(`[${peer}] Sending folder data: ` + JSON.stringify(folder));
                    sendSyncMessage(peer, 'folderData', folder);
                    console.log(`[${peer}] Sent folder data: ${folder.name} (id=${folder.id})`);
                } else {
                    console.log(`[${peer}] Requested folder id=${msg.payload.id} not found`);
                }
            } else if (msg.type === 'requestFile') {
                console.log(`[${peer}] Received request for file id=${msg.payload.id}`);
                const file = (await getAllFiles()).find(f => f.id === msg.payload.id);
                if (file) {
                    console.log(`[${peer}] Sending file data: ` + JSON.stringify(file));
                    sendSyncMessage(peer, 'fileData', file);
                    console.log(`[${peer}] Sent file data: ${file.name} (id=${file.id})`);
                } else {
                    console.log(`[${peer}] Requested file id=${msg.payload.id} not found`);
                }
            } else if (msg.type === 'folderData') {
                console.log(`[${peer}] Received folder data: ${msg.payload.name} (id=${msg.payload.id})`);
                console.log(`[${peer}] Folder data: ` + JSON.stringify(msg.payload));
                try {
                    await importFolderIfMissing(msg.payload);
                    await refreshFolders();
                } catch (err) {
                    console.log(`[${peer}] Error importing folder: ` + (err && err.stack ? err.stack : err));
                }
            } else if (msg.type === 'fileData') {
                console.log(`[${peer}] Received file data: ${msg.payload.name} (id=${msg.payload.id})`);
                console.log(`[${peer}] File data: ` + JSON.stringify(msg.payload));
                try {
                    await importFileIfMissing(msg.payload);
                    if (selectedFolderId === msg.payload.folderId) {
                        await showFilesInFolder(selectedFolderId, selectedFolderName);
                    }
                } catch (err) {
                    console.log(`[${peer}] Error importing file: ` + (err && err.stack ? err.stack : err));
                }
            } else if (msg.type === 'signalingServerIPs') {
                console.log(`[${peer}] Received signaling server IPs: ` + JSON.stringify(msg.payload));
                handleSignalingServerIPs(msg.payload);
            } else if (msg.type === 'triggerSync') {
                console.log(`[${peer}] Triggering recursive sync.`);
                exportDbSummary().then(summary => {
                    connObj.sync.localDbSummary = summary;
                    connObj.sync.hasSentSummary = true;
                    console.log(`[${peer}] Exported local summary. Sending to peer...`);
                    console.log(`[${peer}] Local summary: ` + JSON.stringify(summary));
                    sendSyncMessage(peer, 'dbSummary', summary);
                    tryCompareAndRequestMissing(peer);
                }).catch(err => {
                    console.log(`[${peer}] Error exporting DB summary: ` + (err && err.stack ? err.stack : err));
                });
            } else if (event.data === '__CLOSE_CHAT__') {
                console.log(`[chat][${peer}] Received close signal, closing chat`);
                cleanupPeerConnection(peer);
                return;
            } else {
                console.log(`[${peer}] Unknown sync message type: ` + msg.type);
            }
        } catch (e) {
            console.log(`[${peer}] Error in data channel message handler: ` + (e && e.stack ? e.stack : e));
        }
    };
}

function sendSyncMessage(peer, type, payload) {
    const connObj = peerConnections[peer];
    if (connObj && connObj.dataChannel && connObj.dataChannel.readyState === 'open') {
        const msg = JSON.stringify({ type, payload });
        connObj.dataChannel.send(msg);
    }
}

function tryCompareAndRequestMissing(peer) {
    const connObj = peerConnections[peer];
    const sync = connObj.sync;
    if (sync.hasRequestedMissing) return;
    if (sync.hasSentSummary && sync.hasReceivedPeerSummary && sync.localDbSummary && sync.peerDbSummary) {
        sync.hasRequestedMissing = true;
        compareAndRequestMissing(peer);
    }
}

async function compareAndRequestMissing(peer) {
    const connObj = peerConnections[peer];
    const sync = connObj.sync;
    // Folders
    const localFolderIds = new Set(sync.localDbSummary.folders.map(f => f.id));
    const peerFolderIds = new Set(sync.peerDbSummary.folders.map(f => f.id));
    const missingFolders = sync.peerDbSummary.folders.filter(f => !localFolderIds.has(f.id));
    for (const folder of missingFolders) {
        sendSyncMessage(peer, 'requestFolder', { id: folder.id });
    }
    // Files
    const localFileIds = new Set(sync.localDbSummary.files.map(f => f.id));
    const peerFileIds = new Set(sync.peerDbSummary.files.map(f => f.id));
    const missingFiles = sync.peerDbSummary.files.filter(f => !localFileIds.has(f.id));
    for (const file of missingFiles) {
        sendSyncMessage(peer, 'requestFile', { id: file.id });
    }

    // After sync is complete, share signaling server IPs
    console.log(`[${peer}] Sync complete, sharing signaling server IPs`);
    const ips = Array.from(signalingServerIPs);
    console.log(`[${peer}] Sending IPs:`, ips);
    sendSyncMessage(peer, 'signalingServerIPs', ips);
}

// Clean up all connections on end
function endCall() {
    Object.keys(peerConnections).forEach(peer => cleanupPeerConnection(peer));
    // Close all signaling server connections
    if (signalingSockets) {
        signalingSockets.forEach((socket, ip) => {
            console.log(`[SignalingIPs] Closing connection to ${ip}`);
            socket.close();
        });
        signalingSockets.clear();
    }
    // Re-enable connect button if a user is selected
    if (selectedUser) {
        connectBtn.disabled = false;
    }
}

// Handle user list updates
socket.on('userList', (users) => {
    usersList.innerHTML = '';
    users.forEach(user => {
        if (user !== registeredUsername) {
            const li = document.createElement('li');
            li.textContent = user;
            li.classList.remove('selected');
            li.addEventListener('click', () => {
                document.querySelectorAll('#users li').forEach(item => item.classList.remove('selected'));
                li.classList.add('selected');
                selectedUser = user;
                connectBtn.disabled = false;
            });
            usersList.appendChild(li);
        }
    });
    // Disable connect button if no user is selected or user list is empty
    if (!selectedUser || !Array.from(usersList.children).some(li => li.classList.contains('selected'))) {
        connectBtn.disabled = true;
    }
});

// --- Connection Request Modal ---
function showConnectionRequestModal(fromUser, onAccept, onReject) {
    let modal = document.getElementById('conn-req-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'conn-req-modal';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100vw';
        modal.style.height = '100vh';
        modal.style.background = 'rgba(0,0,0,0.5)';
        modal.style.display = 'flex';
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
        modal.style.zIndex = '2000';
        modal.innerHTML = `
            <div style="background: white; padding: 32px 32px 24px 32px; border-radius: 12px; min-width: 320px; box-shadow: 0 4px 32px rgba(0,0,0,0.15); display: flex; flex-direction: column; align-items: center;">
                <div style="font-size: 1.2rem; font-weight: 500; margin-bottom: 18px; text-align: center;">
                    <span id="conn-req-from"></span> wants to connect.<br>Accept connection?
                </div>
                <div style="display: flex; gap: 18px;">
                    <button id="conn-req-accept" style="padding: 8px 18px; border-radius: 6px; border: none; background: #43a047; color: white; font-size: 1rem; font-weight: 500; cursor: pointer;">Accept</button>
                    <button id="conn-req-reject" style="padding: 8px 18px; border-radius: 6px; border: none; background: #e53935; color: white; font-size: 1rem; font-weight: 500; cursor: pointer;">Reject</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    } else {
        modal.style.display = 'flex';
    }
    document.getElementById('conn-req-from').textContent = fromUser;
    document.getElementById('conn-req-accept').onclick = () => {
        modal.style.display = 'none';
        onAccept();
    };
    document.getElementById('conn-req-reject').onclick = () => {
        modal.style.display = 'none';
        onReject();
    };
}
function hideConnectionRequestModal() {
    const modal = document.getElementById('conn-req-modal');
    if (modal) modal.style.display = 'none';
}

// --- IndexedDB Sync: Summary Exchange ---
let localDbSummary = null;
let peerDbSummary = null;
let hasSentSummary = false;
let hasReceivedPeerSummary = false;
let hasRequestedMissing = false;

function resetSyncFlags() {
    localDbSummary = null;
    peerDbSummary = null;
    hasSentSummary = false;
    hasReceivedPeerSummary = false;
    hasRequestedMissing = false;
}

async function exportDbSummary() {
    const folders = await getFolders();
    const files = await getAllFiles();
    // Only send minimal info for summary (no file content)
    return {
        folders: folders.map(f => ({ id: f.id, name: f.name })),
        files: files.map(f => ({ id: f.id, folderId: f.folderId, name: f.name }))
    };
}

async function getAllFiles() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readonly');
        const store = tx.objectStore('files');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// IndexedDB setup
function openDB() {
    console.log('[IndexedDB] Opening database...');
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('chatAppDB', 2); // bump version to 2
        request.onupgradeneeded = (event) => {
            console.log('[IndexedDB] onupgradeneeded: Creating object stores if needed');
            const db = event.target.result;
            if (!db.objectStoreNames.contains('messages')) {
                db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
                console.log('[IndexedDB] Object store "messages" created');
            }
            if (!db.objectStoreNames.contains('folders')) {
                db.createObjectStore('folders', { keyPath: 'id', autoIncrement: true });
                console.log('[IndexedDB] Object store "folders" created');
            }
            if (!db.objectStoreNames.contains('files')) {
                const fileStore = db.createObjectStore('files', { keyPath: 'id', autoIncrement: true });
                fileStore.createIndex('folderId', 'folderId', { unique: false });
                console.log('[IndexedDB] Object store "files" created');
            }
        };
        request.onsuccess = () => {
            console.log('[IndexedDB] Database opened successfully');
            resolve(request.result);
        };
        request.onerror = () => {
            console.error('[IndexedDB] Failed to open database:', request.error);
            reject(request.error);
        };
    });
}

// Folder and file functions
async function createFolder(name) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('folders', 'readwrite');
        const store = tx.objectStore('folders');
        const req = store.add({ name });
        req.onsuccess = () => {
            console.log('[IndexedDB] Folder created:', name);
            resolve(req.result); // returns folder id
        };
        req.onerror = () => {
            console.error('[IndexedDB] Failed to create folder:', req.error);
            reject(req.error);
        };
    });
}

async function getFolders() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('folders', 'readonly');
        const store = tx.objectStore('folders');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function createFile(folderId, name, content) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readwrite');
        const store = tx.objectStore('files');
        const req = store.add({ folderId, name, content });
        req.onsuccess = () => {
            console.log(`[IndexedDB] File "${name}" created in folder ${folderId}`);
            resolve(req.result); // returns file id
        };
        req.onerror = () => {
            console.error('[IndexedDB] Failed to create file:', req.error);
            reject(req.error);
        };
    });
}

async function getFilesInFolder(folderId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readonly');
        const store = tx.objectStore('files');
        const idx = store.index('folderId');
        const req = idx.getAll(IDBKeyRange.only(folderId));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// Minimal UI for folders/files
function setupFolderFileUI() {
    // Insert UI after registration
    const regSection = document.getElementById('register').parentElement;
    const container = document.createElement('div');
    container.id = 'folder-file-ui';
    container.style.margin = '24px 0';
    container.innerHTML = `
        <div style="margin-bottom: 24px;">
            <div style="margin-bottom: 12px; font-weight: bold;">Signaling Servers</div>
            <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                <input id="new-server-ip" type="text" placeholder="New server IP (e.g., https://192.168.0.13:3000)" style="flex:1; padding:4px;" />
                <button id="add-server-btn">Add Server</button>
            </div>
            <ul id="server-list" style="margin-bottom: 16px; padding-left: 18px;"></ul>
        </div>
        <div style="margin-bottom: 12px; font-weight: bold;">Folders</div>
        <div style="display: flex; gap: 8px; margin-bottom: 8px;">
            <input id="new-folder-name" type="text" placeholder="New folder name" style="flex:1; padding:4px;" />
            <button id="create-folder-btn">Create Folder</button>
        </div>
        <ul id="folders-list" style="margin-bottom: 16px; padding-left: 18px;"></ul>
        <div id="files-section" style="display:none;">
            <div style="margin-bottom: 8px; font-weight: bold;">Files in <span id="current-folder-name"></span></div>
            <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                <input id="new-file-name" type="text" placeholder="File name" style="flex:1; padding:4px;" />
                <input id="new-file-content" type="text" placeholder="File content" style="flex:2; padding:4px;" />
                <button id="create-file-btn">Create File</button>
            </div>
            <ul id="files-list" style="padding-left: 18px;"></ul>
        </div>
    `;
    regSection.parentElement.insertBefore(container, regSection.nextSibling);

    // Handlers
    document.getElementById('create-folder-btn').onclick = async () => {
        const name = document.getElementById('new-folder-name').value.trim();
        if (!name) return;
        await createFolder(name);
        document.getElementById('new-folder-name').value = '';
        await refreshFolders();
    };

    // Add server button handler
    document.getElementById('add-server-btn').onclick = () => {
        let ip = document.getElementById('new-server-ip').value.trim();
        if (!ip) return;
        if (!ip.startsWith('https://')) {
            alert('Server IP must start with https://');
            return;
        }
        ip = normalizeServerIP(ip);
        signalingServerIPs.add(ip);
        document.getElementById('new-server-ip').value = '';
        refreshServerList();
        shareSignalingServerIPs();
    };
}

// Function to refresh the server list UI
function refreshServerList() {
    const list = document.getElementById('server-list');
    list.innerHTML = '';
    Array.from(signalingServerIPs).forEach(ip => {
        const li = document.createElement('li');
        li.textContent = ip;
        li.style.display = 'flex';
        li.style.justifyContent = 'space-between';
        li.style.alignItems = 'center';
        li.style.marginBottom = '4px';
        
        const removeBtn = document.createElement('button');
        removeBtn.textContent = '×';
        removeBtn.style.marginLeft = '8px';
        removeBtn.style.padding = '0 6px';
        removeBtn.style.border = 'none';
        removeBtn.style.background = '#ff4444';
        removeBtn.style.color = 'white';
        removeBtn.style.borderRadius = '4px';
        removeBtn.style.cursor = 'pointer';
        
        removeBtn.onclick = () => {
            if (ip === DEFAULT_SIGNALING_SERVER) {
                alert('Cannot remove the default signaling server');
                return;
            }
            signalingServerIPs.delete(normalizeServerIP(ip));
            refreshServerList();
            shareSignalingServerIPs();
        };
        
        li.appendChild(removeBtn);
        list.appendChild(li);
    });
}

let selectedFolderId = null;
let selectedFolderName = '';

async function refreshFolders() {
    const folders = await getFolders();
    const list = document.getElementById('folders-list');
    list.innerHTML = '';
    folders.forEach(folder => {
        const li = document.createElement('li');
        li.textContent = folder.name;
        li.style.cursor = 'pointer';
        li.style.fontWeight = (folder.id === selectedFolderId) ? 'bold' : 'normal';
        li.onclick = async () => {
            selectedFolderId = folder.id;
            selectedFolderName = folder.name;
            await refreshFolders();
            await showFilesInFolder(folder.id, folder.name);
        };
        list.appendChild(li);
    });
}

async function showFilesInFolder(folderId, folderName) {
    document.getElementById('files-section').style.display = 'block';
    document.getElementById('current-folder-name').textContent = folderName;
    const files = await getFilesInFolder(folderId);
    const list = document.getElementById('files-list');
    list.innerHTML = '';
    files.forEach(file => {
        const li = document.createElement('li');
        li.textContent = file.name + ': ' + file.content;
        list.appendChild(li);
    });
    // File creation handler
    document.getElementById('create-file-btn').onclick = async () => {
        const name = document.getElementById('new-file-name').value.trim();
        const content = document.getElementById('new-file-content').value;
        if (!name) return;
        await createFile(folderId, name, content);
        document.getElementById('new-file-name').value = '';
        document.getElementById('new-file-content').value = '';
        await showFilesInFolder(folderId, folderName);
    };
}

// Call DB open on startup
openDB().then(() => {
    console.log('[Startup] IndexedDB is ready');
    setupFolderFileUI();
    refreshFolders();
    refreshServerList();
}).catch((err) => {
    console.error('[Startup] IndexedDB failed to initialize:', err);
});

// --- IndexedDB Sync: Import received file ---
async function importFileIfMissing(file) {
    const files = await getAllFiles();
    if (files.some(f => f.id === file.id)) {
        console.log(`[Sync] File already exists: ${file.name} (id=${file.id})`);
        return;
    }
    // Insert with explicit id
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readwrite');
        const store = tx.objectStore('files');
        const req = store.add({ id: file.id, folderId: file.folderId, name: file.name, content: file.content });
        req.onsuccess = () => {
            console.log(`[Sync] Imported file: ${file.name} (id=${file.id})`);
            resolve();
        };
        req.onerror = () => {
            console.log(`[Sync] Failed to import file: ${file.name} (id=${file.id})`);
            reject(req.error);
        };
    });
}

// --- IndexedDB Sync: Import received folder ---
async function importFolderIfMissing(folder) {
    const folders = await getFolders();
    if (folders.some(f => f.id === folder.id)) {
        console.log(`[Sync] Folder already exists: ${folder.name} (id=${folder.id})`);
        return;
    }
    // Insert with explicit id
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('folders', 'readwrite');
        const store = tx.objectStore('folders');
        const req = store.add({ id: folder.id, name: folder.name });
        req.onsuccess = () => {
            console.log(`[Sync] Imported folder: ${folder.name} (id=${folder.id})`);
            resolve();
        };
        req.onerror = () => {
            console.log(`[Sync] Failed to import folder: ${folder.name} (id=${folder.id})`);
            reject(req.error);
        };
    });
}

// --- Signaling Server IP Sharing and Recursive Sync ---

// Cache for signaling server IPs
const signalingServerIPs = new Set([DEFAULT_SIGNALING_SERVER]);

// Add server retry tracking
const serverRetryCounts = new Map();
const MAX_SERVER_RETRIES = 5;
const SERVER_RETRY_DELAY = 2000;

// Set to track permanently failed servers
const permanentlyFailedServers = new Set();

// Function to share signaling server IPs with all connected peers
function shareSignalingServerIPs() {
    const ips = Array.from(signalingServerIPs);
    console.log('[SignalingIPs] Sharing IPs with peers:', ips);
    Object.keys(peerConnections).forEach(peer => {
        if (peerConnections[peer].dataChannel && peerConnections[peer].dataChannel.readyState === 'open') {
            console.log(`[SignalingIPs] Sending IPs to peer ${peer}`);
            sendSyncMessage(peer, 'signalingServerIPs', ips);
        } else {
            console.log(`[SignalingIPs] Cannot send IPs to peer ${peer} - data channel not open`);
        }
    });
}

// Function to handle received signaling server IPs
function handleSignalingServerIPs(ips) {
    console.log('[SignalingIPs] Received IPs:', ips);
    let newIPs = false;
    ips.forEach(ip => {
        ip = normalizeServerIP(ip);
        if (permanentlyFailedServers.has(ip)) {
            console.log(`[SignalingIPs] IP ${ip} is permanently failed, ignoring.`);
            return;
        }
        if (!signalingServerIPs.has(ip)) {
            console.log(`[SignalingIPs] New IP found: ${ip}`);
            signalingServerIPs.add(ip);
            newIPs = true;
            // Connect to the new signaling server
            connectToNewSignalingServer(ip);
        } else {
            console.log(`[SignalingIPs] IP already known: ${ip}`);
        }
    });
    if (newIPs) {
        console.log('[SignalingIPs] New IPs received, sharing with peers and triggering sync');
        shareSignalingServerIPs();
        // Trigger recursive sync
        Object.keys(peerConnections).forEach(peer => {
            if (peerConnections[peer].dataChannel && peerConnections[peer].dataChannel.readyState === 'open') {
                console.log(`[SignalingIPs] Triggering sync with peer ${peer}`);
                sendSyncMessage(peer, 'triggerSync', {});
            } else {
                console.log(`[SignalingIPs] Cannot trigger sync with peer ${peer} - data channel not open`);
            }
        });
    } else {
        console.log('[SignalingIPs] No new IPs received, skipping sync');
    }
}

// Function to connect to a new signaling server
function connectToNewSignalingServer(serverIP) {
    serverIP = normalizeServerIP(serverIP);
    console.log(`[SignalingIPs] Connecting to new signaling server: ${serverIP}`);
    const newSocket = io(serverIP, {
        withCredentials: true,
        rejectUnauthorized: false,
        transports: ['websocket', 'polling'],
        secure: true
    });

    newSocket.on('connect_error', (error) => {
        console.error(`[SignalingIPs] Connection error to ${serverIP}:`, error);
        const retryCount = (serverRetryCounts.get(serverIP) || 0) + 1;
        serverRetryCounts.set(serverIP, retryCount);
        
        if (retryCount >= MAX_SERVER_RETRIES) {
            console.log(`[SignalingIPs] Server ${serverIP} unreachable after ${MAX_SERVER_RETRIES} attempts, removing from list`);
            signalingServerIPs.delete(serverIP);
            serverRetryCounts.delete(serverIP);
            permanentlyFailedServers.add(serverIP);
            if (signalingSockets.has(serverIP)) {
                signalingSockets.get(serverIP).close();
                signalingSockets.delete(serverIP);
            }
            refreshServerList();
        } else {
            console.log(`[SignalingIPs] Retrying connection to ${serverIP} in ${SERVER_RETRY_DELAY}ms (attempt ${retryCount}/${MAX_SERVER_RETRIES})`);
            setTimeout(() => {
                if (signalingSockets.has(serverIP)) {
                    signalingSockets.get(serverIP).close();
                    signalingSockets.delete(serverIP);
                }
                connectToNewSignalingServer(serverIP);
            }, SERVER_RETRY_DELAY);
        }
    });

    newSocket.on('connect', () => {
        console.log(`[SignalingIPs] Connected to new signaling server: ${serverIP}`);
        // Reset retry count on successful connection
        serverRetryCounts.delete(serverIP);
        // Register with the same username
        if (registeredUsername) {
            console.log(`[SignalingIPs] Registering as ${registeredUsername} on ${serverIP}`);
            newSocket.emit('register', registeredUsername);
        }
    });

    // Handle user list from the new server
    newSocket.on('userList', async (users) => {
        if (!registrationCompleted || !registeredUsername) {
            console.log('[SignalingIPs] Registration not complete, skipping user list processing.');
            return;
        }
        console.log(`[SignalingIPs] Received user list from ${serverIP}:`, users);
        // Add new peers to the connection queue
        users.forEach(peer => {
            if (
                peer !== registeredUsername &&
                !connectedPeers.has(peer) &&
                !connectQueue.includes(peer)
            ) {
                console.log(`[SignalingIPs] Adding new peer ${peer} from ${serverIP} to connection queue`);
                connectQueue.push(peer);
            }
        });
        tryConnectNextPeer();
    });

    // Handle signals from the new server
    newSocket.on('signal', async (data) => {
        if (!data || !data.data || !data.sender) {
            console.warn(`[SignalingIPs] Malformed signal received from ${serverIP}:`, data);
            return;
        }
        const peer = data.sender === registeredUsername ? data.target : data.sender;
        if (!peerConnections[peer]) {
            // If not initiator, create connection on demand
            await startPeerConnection(peer, false);
        }
        const connObj = peerConnections[peer];
        const pc = connObj.peerConnection;
        try {
            if (data.data.type === 'offer') {
                if (pc.signalingState === 'stable') {
                    await pc.setRemoteDescription(new RTCSessionDescription(data.data));
                    await flushRemoteCandidates(peer);
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    newSocket.emit('signal', {
                        target: peer,
                        signal: answer,
                        sender: registeredUsername
                    });
                } else {
                    console.log(`[SignalingIPs] (${peer}) Offer received but signaling state is`, pc.signalingState, '- ignoring.');
                }
            } else if (data.data.type === 'answer') {
                if (pc.signalingState === 'have-local-offer') {
                    await pc.setRemoteDescription(new RTCSessionDescription(data.data));
                } else {
                    console.log(`[SignalingIPs] (${peer}) Answer received but signaling state is`, pc.signalingState, '- ignoring.');
                }
            } else if (data.data.candidate) {
                if (pc.remoteDescription && pc.remoteDescription.type) {
                    await pc.addIceCandidate(new RTCIceCandidate(data.data));
                } else {
                    connObj.remoteCandidatesQueue.push(data.data);
                }
            }
        } catch (error) {
            console.error(`[SignalingIPs] (${peer}) Error handling signal from ${serverIP}:`, error);
        }
    });

    // Store the socket connection
    if (!signalingSockets) {
        signalingSockets = new Map();
    }
    signalingSockets.set(serverIP, newSocket);
}

// Add signalingSockets to store multiple socket connections
let signalingSockets = new Map();

// Update cleanup to close all signaling server connections
function cleanupPeerConnection(peer) {
    const connObj = peerConnections[peer];
    if (!connObj) return;
    if (connObj.dataChannel) {
        try { connObj.dataChannel.close(); } catch (e) {}
    }
    if (connObj.peerConnection) {
        try { connObj.peerConnection.close(); } catch (e) {}
    }
    delete peerConnections[peer];
    autoConnectInProgress = false;
    // Retry logic: if not max retries, requeue peer
    if ((peerRetryCounts[peer] || 0) < MAX_PEER_RETRIES) {
        console.log(`[AutoSync] Connection to ${peer} closed/disconnected, will retry.`);
        autoConnectQueue.push(peer);
    } else {
        console.log(`[AutoSync] Connection to ${peer} closed/disconnected, max retries reached.`);
    }
    tryAutoConnectNextPeer();
    console.log(`[PeerConn] Cleaned up connection to ${peer}`);
}

// Update endCall to close all signaling server connections
function endCall() {
    Object.keys(peerConnections).forEach(peer => cleanupPeerConnection(peer));
    // Close all signaling server connections
    if (signalingSockets) {
        signalingSockets.forEach((socket, ip) => {
            console.log(`[SignalingIPs] Closing connection to ${ip}`);
            socket.close();
        });
        signalingSockets.clear();
    }
    // Re-enable connect button if a user is selected
    if (selectedUser) {
        connectBtn.disabled = false;
    }
}

// Utility to normalize server IPs (remove trailing slashes)
function normalizeServerIP(ip) {
    return ip.replace(/\/+$/, '');
} 