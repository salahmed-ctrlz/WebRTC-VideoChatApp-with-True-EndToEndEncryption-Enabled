// Import Socket.IO client
// Use hardcoded WSS URL for ngrok
// Import Socket.IO client
// Dynamically determine the WebSocket URL based on current window location
const socketUrl = window.location.protocol === 'https:' 
    ? `wss://${window.location.host}` 
    : `ws://${window.location.host}`;

const socket = io(socketUrl, {
    secure: window.location.protocol === 'https:',
    transports: ["websocket"]
});

// DOM Elements
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const toggleCameraBtn = document.getElementById("toggleCamera");
const switchCameraBtn = document.getElementById("switchCamera");
const toggleMicBtn = document.getElementById("toggleMic");
const endCallBtn = document.getElementById("endCall");
const roomParticipantsList = document.getElementById("roomParticipantsList");
const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const sendMessageBtn = document.getElementById("sendMessage");
const remoteMediaStatus = document.getElementById("remoteMediaStatus");
const remoteVideoStatus = document.getElementById("remoteVideoStatus");
const remoteAudioStatus = document.getElementById("remoteAudioStatus");
const localVideoTitle = document.getElementById("localVideoTitle");
const remoteVideoTitle = document.getElementById("remoteVideoTitle");
const chooseUsernameBtn = document.getElementById("chooseUsername");
const createRoomBtn = document.getElementById("createRoomBtn");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const joinRoomInput = document.getElementById("joinRoomInput");
const roomIdText = document.getElementById("roomIdText");
const copyRoomIdBtn = document.getElementById("copyRoomIdBtn");
const leaveRoomBtn = document.getElementById("leaveRoomBtn");
const welcomeScreen = document.getElementById("welcomeScreen");
const roomScreens = document.getElementById("roomScreens");

// State Variables
let localStream;
let peerConnections = {};
let isVideoEnabled = true;
let isAudioEnabled = true;
let isInCall = false;
let currentCameraIndex = 0;
let availableCameras = [];
let authToken = null;
let username = "";
let currentRoomId = null;
let callerPrivateKey, callerPublicKey, calleePrivateKey, calleePublicKey, sharedKey, pendingCallPublicKey;

// Crypto Functions
async function generateKeyPair() {
    return await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey"]
    );
}

async function exportPublicKey(key) {
    return await crypto.subtle.exportKey("jwk", key);
}

async function importPublicKey(jwk) {
    return await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        []
    );
}

async function deriveSharedKey(privateKey, publicKey) {
    return await crypto.subtle.deriveKey(
        { name: "ECDH", public: publicKey },
        privateKey,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
}

async function encryptData(data, key) {
    const toEncrypt = typeof data === "string" ? data : JSON.stringify(data);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encodedData = new TextEncoder().encode(toEncrypt);
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encodedData
    );
    return { iv: Array.from(iv), encrypted: Array.from(new Uint8Array(encrypted)) };
}

async function decryptData({ iv, encrypted }, key) {
    try {
        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(iv) },
            key,
            new Uint8Array(encrypted)
        );
        const decryptedStr = new TextDecoder().decode(decrypted);
        try {
            return JSON.parse(decryptedStr);
        } catch {
            return decryptedStr;
        }
    } catch (e) {
        console.error("Decryption failed:", e);
        return null;
    }
}

// Insertable Streams Encryption (Experimental)
function setupStreamEncryption(sender) {
    if (!sender.transform || !RTCRtpScriptTransform) {
        console.warn("Insertable Streams API not supported in this browser.");
        return;
    }
    const worker = new Worker(URL.createObjectURL(new Blob([`
        // Store IV for each frame to use in decryption
        const frameIVs = new Map();
        let sharedKeyData = null;
        
        self.onmessage = async (event) => {
            if (event.data.type === 'key') {
                sharedKeyData = event.data.key;
            }
        };
        
        self.onrtctransform = async (event) => {
            const { transformer } = event;
            transformer.readable.pipeThrough(new TransformStream({
                transform: async (frame, controller) => {
                    if (!sharedKeyData) {
                        controller.enqueue(frame);
                        return;
                    }
                    
                    try {
                        // Import the shared key
                        const sharedKey = await crypto.subtle.importKey(
                            "raw",
                            new Uint8Array(sharedKeyData),
                            { name: "AES-GCM" },
                            false,
                            ["encrypt"]
                        );
                        
                        // Generate IV for this frame
                        const iv = crypto.getRandomValues(new Uint8Array(12));
                        const frameData = new Uint8Array(frame.data);
                        
                        // Encrypt the frame data
                        const encryptedData = await crypto.subtle.encrypt(
                            { name: "AES-GCM", iv },
                            sharedKey,
                            frameData
                        );
                        
                        // Store frame number and IV mapping
                        frameIVs.set(frame.timestamp, Array.from(iv));
                        
                        // Create a new frame with encrypted data
                        const newFrame = new RTCEncodedVideoFrame({
                            type: frame.type,
                            timestamp: frame.timestamp,
                            data: encryptedData
                        });
                        
                        // Add custom header with IV
                        newFrame.getMetadata().encryptionIV = Array.from(iv);
                        
                        controller.enqueue(newFrame);
                    } catch (e) {
                        console.error("Frame encryption failed:", e);
                        controller.enqueue(frame);
                    }
                }
            })).pipeTo(transformer.writable);
        };
    `], { type: "application/javascript" })));
    
    // Export the shared key and send to worker
    if (sharedKey) {
        crypto.subtle.exportKey("raw", sharedKey).then(keyData => {
            worker.postMessage({
                type: 'key',
                key: Array.from(new Uint8Array(keyData))
            });
        });
    }
    
    sender.transform = new RTCRtpScriptTransform(worker, {});
}

function setupStreamDecryption(receiver) {
    if (!receiver.transform || !RTCRtpScriptTransform) {
        return;
    }
    const worker = new Worker(URL.createObjectURL(new Blob([`
        let sharedKeyData = null;
        
        self.onmessage = async (event) => {
            if (event.data.type === 'key') {
                sharedKeyData = event.data.key;
            }
        };
        
        self.onrtctransform = async (event) => {
            const { transformer } = event;
            transformer.readable.pipeThrough(new TransformStream({
                transform: async (frame, controller) => {
                    if (!sharedKeyData) {
                        controller.enqueue(frame);
                        return;
                    }
                    
                    try {
                        // Get IV from frame metadata
                        const iv = new Uint8Array(frame.getMetadata().encryptionIV);
                        if (!iv) {
                            controller.enqueue(frame);
                            return;
                        }
                        
                        // Import the shared key
                        const sharedKey = await crypto.subtle.importKey(
                            "raw",
                            new Uint8Array(sharedKeyData),
                            { name: "AES-GCM" },
                            false,
                            ["decrypt"]
                        );
                        
                        // Decrypt the frame data
                        const decryptedData = await crypto.subtle.decrypt(
                            { name: "AES-GCM", iv },
                            sharedKey,
                            frame.data
                        );
                        
                        // Create a new frame with decrypted data
                        const newFrame = new RTCEncodedVideoFrame({
                            type: frame.type,
                            timestamp: frame.timestamp,
                            data: decryptedData
                        });
                        
                        controller.enqueue(newFrame);
                    } catch (e) {
                        console.error("Frame decryption failed:", e);
                        controller.enqueue(frame);
                    }
                }
            })).pipeTo(transformer.writable);
        };
    `], { type: "application/javascript" })));
    
    // Export the shared key and send to worker
    if (sharedKey) {
        crypto.subtle.exportKey("raw", sharedKey).then(keyData => {
            worker.postMessage({
                type: 'key',
                key: Array.from(new Uint8Array(keyData))
            });
        });
    }
    
    receiver.transform = new RTCRtpScriptTransform(worker, {});
}

// Media Setup Functions
async function setupMediaStream() {
    try {
        availableCameras = await getAvailableCameras();
        switchCameraBtn.style.display = availableCameras.length > 1 ? "block" : "none";

        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
        localVideo.srcObject = localStream;
        localVideo.style.transform = "scaleX(-1)"; // Mirror local video
        setupMediaControls();
    } catch (err) {
        console.error("Error accessing media devices:", err);
        alert("Failed to access camera and microphone");
    }
}

async function getAvailableCameras() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(device => device.kind === "videoinput");
    } catch (err) {
        console.error("Error getting cameras:", err);
        return [];
    }
}

// WebRTC Functions
async function createPeerConnection(peerId) {
    if (peerConnections[peerId]) {
        console.log("Connection already exists for peer:", peerId);
        return peerConnections[peerId];
    }

    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" }
        ],
        iceTransportPolicy: "all"
    });

    // Add all local tracks to the connection
    localStream.getTracks().forEach(track => {
        console.log(`Adding ${track.kind} track to peer connection`);
        const sender = pc.addTrack(track, localStream);
        setupStreamEncryption(sender);
    });

    // Handle incoming tracks
    pc.ontrack = ({ streams: [stream], track }) => {
        console.log(`Received ${track.kind} track from remote peer`);
        if (!remoteVideo.srcObject) {
            remoteVideo.srcObject = stream;
        }
        const receiver = pc.getReceivers().find(r => r.track.kind === track.kind);
        setupStreamDecryption(receiver);
        remoteMediaStatus.style.display = "flex";
    };

    // Handle ICE candidates
    pc.onicecandidate = async ({ candidate }) => {
        if (candidate && peerId && sharedKey) {
            console.log("Sending ICE candidate to peer:", peerId);
            const encryptedCandidate = await encryptData({ candidate }, sharedKey);
            socket.emit("signal", { target: peerId, signal: encryptedCandidate });
        }
    };

    // Monitor connection state
    pc.oniceconnectionstatechange = () => {
        console.log("ICE connection state:", pc.iceConnectionState);
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
            console.log("Connection established with peer:", peerId);
        } else if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
            console.log("Connection lost with peer:", peerId);
            endCallWithPeer(peerId);
        }
    };

    peerConnections[peerId] = pc;
    return pc;
}

// Call Management Functions
async function initiateCall(userId) {
    if (isInCall) {
        alert("Please end your current call before starting a new one");
        return;
    }

    isInCall = true;
    endCallBtn.style.display = "block";

    const keyPair = await generateKeyPair();
    callerPrivateKey = keyPair.privateKey;
    callerPublicKey = keyPair.publicKey;
    const exportedPublicKey = await exportPublicKey(callerPublicKey);

    // No encryption for initial call request as we don't have shared key yet
    socket.emit("call-request", { target: userId, publicKey: exportedPublicKey });
}

function showCallNotification(callerId, callerName) {
    removeCallNotification();
    const notification = document.createElement("div");
    notification.className = "call-notification";
    notification.id = "callNotification";
    notification.innerHTML = `
        <p>Incoming call from ${callerName}</p>
        <div class="call-actions">
            <button onclick="acceptCall('${callerId}')" class="accept-call">
                <i class="fas fa-phone"></i> Accept
            </button>
            <button onclick="rejectCall('${callerId}')" class="reject-call">
                <i class="fas fa-phone-slash"></i> Decline
            </button>
        </div>
    `;
    document.body.appendChild(notification);
}

function removeCallNotification() {
    const existingNotification = document.getElementById("callNotification");
    if (existingNotification) existingNotification.remove();
}

async function acceptCall(callerId) {
    if (isInCall) {
        rejectCall(callerId);
        return;
    }

    console.log("Accepting call from:", callerId);
    isInCall = true;
    endCallBtn.style.display = "block";
    remoteMediaStatus.style.display = "flex";

    const keyPair = await generateKeyPair();
    calleePrivateKey = keyPair.privateKey;
    calleePublicKey = keyPair.publicKey;
    const exportedPublicKey = await exportPublicKey(calleePublicKey);
    const callerPublicKey = await importPublicKey(pendingCallPublicKey);
    sharedKey = await deriveSharedKey(calleePrivateKey, callerPublicKey);

    try {
        // Create peer connection
        const pc = await createPeerConnection(callerId);
        
        // Encrypt username for privacy
        const encryptedUsername = await encryptData(username, sharedKey);
        
        socket.emit("call-response", {
            target: callerId,
            accepted: true,
            publicKey: exportedPublicKey,
            encryptedUsername: encryptedUsername
        });
    } catch (err) {
        console.error("Error accepting call:", err);
        endCallWithPeer(callerId);
    }

    removeCallNotification();
}

function rejectCall(callerId) {
    socket.emit("call-response", { target: callerId, accepted: false });
    removeCallNotification();
}

function endCallWithPeer(peerId) {
    if (peerConnections[peerId]) {
        socket.emit("end-call", { target: peerId });
        peerConnections[peerId].close();
        delete peerConnections[peerId];
    }

    if (!Object.keys(peerConnections).length) {
        isInCall = false;
        remoteVideo.srcObject = null;
        endCallBtn.style.display = "none";
        remoteMediaStatus.style.display = "none";
        remoteVideoTitle.textContent = "Other";
        sharedKey = null;
        callerPrivateKey = null;
        callerPublicKey = null;
        calleePrivateKey = null;
        calleePublicKey = null;
        pendingCallPublicKey = null;
    }
}

// Media Controls
function setupMediaControls() {
    toggleCameraBtn.onclick = () => {
        isVideoEnabled = !isVideoEnabled;
        localStream.getVideoTracks()[0].enabled = isVideoEnabled;
        toggleCameraBtn.innerHTML = `<i class="fas fa-video${isVideoEnabled ? "" : "-slash"}"></i> Camera ${isVideoEnabled ? "On" : "Off"}`;
        toggleCameraBtn.classList.toggle("off", !isVideoEnabled);
        socket.emit("media-status-change", { videoEnabled: isVideoEnabled, audioEnabled: isAudioEnabled });
    };

    switchCameraBtn.onclick = async () => {
        if (availableCameras.length < 2) return;
        currentCameraIndex = (currentCameraIndex + 1) % availableCameras.length;
        const newCamera = availableCameras[currentCameraIndex];
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: newCamera.deviceId } },
            audio: true
        });

        localStream.getVideoTracks().forEach(track => track.stop());
        const newVideoTrack = newStream.getVideoTracks()[0];
        const audioTrack = localStream.getAudioTracks()[0];
        localStream = new MediaStream([newVideoTrack, audioTrack]);
        localVideo.srcObject = localStream;
        localVideo.style.transform = "scaleX(-1)";

        Object.values(peerConnections).forEach(pc => {
            const sender = pc.getSenders().find(s => s.track?.kind === "video");
            if (sender) sender.replaceTrack(newVideoTrack);
        });
    };

    toggleMicBtn.onclick = () => {
        isAudioEnabled = !isAudioEnabled;
        localStream.getAudioTracks()[0].enabled = isAudioEnabled;
        toggleMicBtn.innerHTML = `<i class="fas fa-microphone${isAudioEnabled ? "" : "-slash"}"></i> Mic ${isAudioEnabled ? "On" : "Off"}`;
        toggleMicBtn.classList.toggle("off", !isAudioEnabled);
        socket.emit("media-status-change", { videoEnabled: isVideoEnabled, audioEnabled: isAudioEnabled });
    };

    endCallBtn.onclick = () => {
        Object.keys(peerConnections).forEach(endCallWithPeer);
    };

    chatInput.onkeypress = e => {
        if (e.key === "Enter" && chatInput.value.trim()) sendMessage();
    };

    sendMessageBtn.onclick = sendMessage;
}

// Chat Functions
async function sendMessage() {
    const message = chatInput.value.trim();
    if (!message || !currentRoomId || !sharedKey) return;
    const encryptedMessage = await encryptData(message, sharedKey);
    socket.emit("chat-message", { encryptedMessage, roomMessage: true });
    appendMessage(`You: ${message}`, true);
    chatInput.value = "";
}

function appendMessage(message, isLocal = false) {
    const messageElement = document.createElement("p");
    messageElement.textContent = message;
    messageElement.classList.add(isLocal ? "local-message" : "remote-message");
    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Room Management
createRoomBtn.onclick = () => socket.emit("create-room");

joinRoomBtn.onclick = () => {
    const roomId = joinRoomInput.value.trim().toUpperCase();
    if (roomId) socket.emit("join-room", roomId);
    else alert("Please enter a valid room ID");
};

leaveRoomBtn.onclick = () => {
    if (currentRoomId) {
        Object.keys(peerConnections).forEach(endCallWithPeer);
        socket.emit("leave-room");
        welcomeScreen.style.display = "block";
        roomScreens.style.display = "none";
        currentRoomId = null;
        sharedKey = null;
        callerPrivateKey = null;
        callerPublicKey = null;
        calleePrivateKey = null;
        calleePublicKey = null;
        pendingCallPublicKey = null;
    }
};

copyRoomIdBtn.onclick = () => {
    if (currentRoomId) {
        navigator.clipboard.writeText(currentRoomId)
            .then(() => {
                alert("Room ID copied to clipboard!");
            })
            .catch(err => {
                console.error("Could not copy text: ", err);
                // Fallback
                const tempInput = document.createElement("input");
                tempInput.value = currentRoomId;
                document.body.appendChild(tempInput);
                tempInput.select();
                document.execCommand("copy");
                document.body.removeChild(tempInput);
                alert("Room ID copied to clipboard!");
            });
    }
};

function updateParticipantsList(participants) {
    roomParticipantsList.innerHTML = "";
    participants.forEach(participant => {
        if (participant.id === socket.id) return;
        const participantEl = document.createElement("div");
        participantEl.className = "user-item";
        participantEl.innerHTML = `
            <span>${participant.username}</span>
            <button class="call-button" onclick="initiateCall('${participant.id}')">
                <i class="fas fa-phone"></i> Call
            </button>
        `;
        roomParticipantsList.appendChild(participantEl);
    });
}

// Socket Event Handlers - Add these after the state variables
socket.on("authentication", data => {
    authToken = data.token;
    socket.auth = { token: authToken };
});

socket.on("room-joined", data => {
    currentRoomId = data.roomId;
    welcomeScreen.style.display = "none";
    roomScreens.style.display = "block";
    roomIdText.textContent = currentRoomId;
    
    // Clear previous participants
    roomParticipantsList.innerHTML = "";
    
    // Add participants to the list
    data.participants.forEach(participant => {
        if (participant.id !== socket.id) {
            addParticipantToList(participant);
        }
    });
    
    // Set local video title
    localVideoTitle.textContent = username || "You";
});

socket.on("user-joined-room", participant => {
    addParticipantToList(participant);
});

socket.on("user-left-room", data => {
    const participantElement = document.getElementById(`participant-${data.userId}`);
    if (participantElement) participantElement.remove();
    
    if (peerConnections[data.userId]) {
        endCallWithPeer(data.userId);
    }
});

socket.on("peer-media-status", data => {
    const videoStatusElement = document.getElementById(`video-status-${data.peerId}`);
    const audioStatusElement = document.getElementById(`audio-status-${data.peerId}`);
    
    if (videoStatusElement) {
        videoStatusElement.innerHTML = `<i class="fas fa-video${data.videoEnabled ? "" : "-slash"}"></i>`;
        videoStatusElement.classList.toggle("off", !data.videoEnabled);
    }
    
    if (audioStatusElement) {
        audioStatusElement.innerHTML = `<i class="fas fa-microphone${data.audioEnabled ? "" : "-slash"}"></i>`;
        audioStatusElement.classList.toggle("off", !data.audioEnabled);
    }
    
    if (remoteVideo.srcObject && data.peerId === Object.keys(peerConnections)[0]) {
        remoteVideoStatus.innerHTML = `<i class="fas fa-video${data.videoEnabled ? "" : "-slash"}"></i>`;
        remoteAudioStatus.innerHTML = `<i class="fas fa-microphone${data.audioEnabled ? "" : "-slash"}"></i>`;
        remoteVideoStatus.classList.toggle("off", !data.videoEnabled);
        remoteAudioStatus.classList.toggle("off", !data.audioEnabled);
    }
});

socket.on("incoming-call", async data => {
    console.log("Incoming call from:", data.caller);
    pendingCallPublicKey = data.publicKey;
    showCallNotification(data.caller, data.callerName);
});

socket.on("call-response", async data => {
    console.log("Call response received:", data);
    if (data.accepted) {
        try {
            // Import the responder's public key
            const responderPublicKey = await importPublicKey(data.publicKey);
            
            // Derive shared key using caller's private key and responder's public key
            sharedKey = await deriveSharedKey(callerPrivateKey, responderPublicKey);
            
            // Create peer connection
            const pc = await createPeerConnection(data.responder);
            
            // Create and send offer
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            
            // Encrypt the offer
            const encryptedOffer = await encryptData({ sdp: offer }, sharedKey);
            socket.emit("signal", { target: data.responder, signal: encryptedOffer });
            
            // Set remote name if provided
            if (data.encryptedUsername) {
                const decryptedUsername = await decryptData(data.encryptedUsername, sharedKey);
                remoteVideoTitle.textContent = decryptedUsername || "Other";
            } else {
                remoteVideoTitle.textContent = data.responderName || "Other";
            }
        } catch (err) {
            console.error("Error establishing connection:", err);
            endCallWithPeer(data.responder);
        }
    } else {
        alert("Call was declined");
        endCallWithPeer(data.responder);
    }
});

socket.on("signal", async data => {
    console.log("Signal received from:", data.sender);
    const pc = peerConnections[data.sender];
    if (!pc) return;
    
    try {
        const decryptedSignal = await decryptData(data.signal, sharedKey);
        
        if (decryptedSignal.sdp) {
            await pc.setRemoteDescription(new RTCSessionDescription(decryptedSignal.sdp));
            
            if (decryptedSignal.sdp.type === "offer") {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                const encryptedAnswer = await encryptData({ sdp: answer }, sharedKey);
                socket.emit("signal", { target: data.sender, signal: encryptedAnswer });
            }
        } else if (decryptedSignal.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(decryptedSignal.candidate));
        }
    } catch (err) {
        console.error("Error processing signal:", err);
    }
});

socket.on("call-ended", data => {
    endCallWithPeer(data.peerId);
});

socket.on("chat-message", async data => {
    if (!sharedKey) return;
    
    try {
        const decryptedMessage = await decryptData(data.encryptedMessage, sharedKey);
        if (decryptedMessage) {
            appendMessage(`${data.senderName}: ${decryptedMessage}`);
        }
    } catch (err) {
        console.error("Error decrypting message:", err);
    }
});

// Helper function to add participants to the list
function addParticipantToList(participant) {
    const participantElement = document.createElement("div");
    participantElement.className = "participant";
    participantElement.id = `participant-${participant.id}`;
    participantElement.innerHTML = `
        <div class="participant-info">
            <span>${participant.username}</span>
            <div class="participant-controls">
                <span id="video-status-${participant.id}" class="media-status ${participant.videoEnabled ? "" : "off"}">
                    <i class="fas fa-video${participant.videoEnabled ? "" : "-slash"}"></i>
                </span>
                <span id="audio-status-${participant.id}" class="media-status ${participant.audioEnabled ? "" : "off"}">
                    <i class="fas fa-microphone${participant.audioEnabled ? "" : "-slash"}"></i>
                </span>
                <button onclick="initiateCall('${participant.id}')" class="call-button">
                    <i class="fas fa-phone"></i> Call
                </button>
            </div>
        </div>
    `;
    roomParticipantsList.appendChild(participantElement);
}

// Initialize the application
window.onload = () => {
    setupMediaStream();
    
    // Username setup
    chooseUsernameBtn.onclick = () => {
        const usernameInput = prompt("Enter your username:", "");
        if (usernameInput && usernameInput.trim()) {
            username = usernameInput.trim();
            socket.emit("register", username);
            localVideoTitle.textContent = username;
        }
    };
    
    // Automatically prompt for username on load
    setTimeout(() => {
        if (!username) chooseUsernameBtn.click();
    }, 1000);
};

fetch('/join', { headers: { Authorization: `Bearer ${token}` } });
console.log("JWT sent to server:", token);
